// Read-only queries against the deployed Alexandria contracts.
//
// Every function here is a `view` call. The job of this layer is to turn three
// awkward on-chain behaviours into something an HTTP handler can use directly:
//
//   1. Missing rows revert instead of returning empty. library.getUpload() and
//      getUploadStatus() both `require(timestamp != 0, "Upload not found")`, so
//      "this book was never registered" arrives as a thrown CALL_EXCEPTION. That
//      is a 404, not a 500, and it must not be confused with the RPC being down.
//
//   2. isRentalActive() is `view whenNotPaused`. Pausing the Rent contract makes
//      a read-only permission check *revert* rather than return false. Callers
//      need to tell "no rental" from "cannot currently tell", because the second
//      one must fail closed without being cached as a definitive no.
//
//   3. Public RPC endpoints fail intermittently. A network error must surface as
//      503 (try again) and never as "not registered" (a permanent-sounding lie).

const { ethers } = require('ethers');
const { getContracts } = require('../config/blockchain');

// AlexandriaLibrary.UploadStatus, in declaration order. The index is the uint8
// that appears on-chain and in UploadStatusChanged events.
const UPLOAD_STATUS = ['pending', 'challenged', 'approved', 'rejected'];

// Mirrors AlexandriaStake.CHALLENGE_PERIOD (14 days). Read from the contract at
// runtime rather than trusted from here — this is only the fallback.
const FALLBACK_CHALLENGE_PERIOD = 14 * 24 * 60 * 60;

/**
 * Error type for chain failures that should not be mistaken for "no data".
 * `status` is the HTTP status the route should return.
 */
class ChainError extends Error {
  constructor(message, { status = 503, reason = 'chain_unavailable', cause } = {}) {
    super(message);
    this.name = 'ChainError';
    this.status = status;
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Does this thrown error represent a contract `require` failing with `message`?
 *
 * Checked narrowly: only a decoded revert reason counts. A transport failure has
 * no revert reason, so it falls through and is re-thrown as a ChainError.
 */
function isRevertWithReason(err, message) {
  const reason = err?.reason ?? err?.revert?.args?.[0];
  return typeof reason === 'string' && reason.includes(message);
}

/** Any revert at all (as opposed to the RPC being unreachable). */
function isRevert(err) {
  return err?.code === 'CALL_EXCEPTION';
}

/**
 * Run a contract read, converting an expected revert into `fallback` and any
 * other failure into a ChainError.
 *
 * @param {() => Promise<T>} fn
 * @param {{ expectedRevert?: string, fallback?: T, label: string }} opts
 * @returns {Promise<T>}
 * @template T
 */
async function read(fn, { expectedRevert, fallback, label }) {
  try {
    return await fn();
  } catch (err) {
    if (expectedRevert !== undefined && isRevertWithReason(err, expectedRevert)) {
      return fallback;
    }
    throw new ChainError(`On-chain read failed (${label}): ${err.shortMessage || err.message}`, {
      reason: isRevert(err) ? 'contract_reverted' : 'chain_unavailable',
      status: isRevert(err) ? 502 : 503,
      cause: err,
    });
  }
}

function toNumberSeconds(value) {
  return value === undefined || value === null ? null : Number(value);
}

function toIsoOrNull(seconds) {
  const n = Number(seconds);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

// ─── Library ─────────────────────────────────────────────────────────────────

/**
 * Registration record for a book, or `{ registered: false }` if the library has
 * never seen this hash.
 *
 * @param {string} arweaveHash
 */
async function getUploadOnChain(arweaveHash) {
  const { library } = getContracts();

  const upload = await read(() => library.getUpload(arweaveHash), {
    expectedRevert: 'Upload not found',
    fallback: null,
    label: 'library.getUpload',
  });

  if (!upload) return { registered: false };

  return {
    registered: true,
    arweaveHash: upload.arweaveHash,
    uploader: upload.uploader,
    timestamp: toIsoOrNull(upload.timestamp),
    status: UPLOAD_STATUS[Number(upload.status)] ?? `unknown(${upload.status})`,
    metadata: upload.metadata,
  };
}

/**
 * Just the status string, or null when unregistered. Cheaper than getUpload
 * when the metadata is not needed.
 *
 * @param {string} arweaveHash
 * @returns {Promise<string|null>}
 */
async function getUploadStatusOnChain(arweaveHash) {
  const { library } = getContracts();

  const status = await read(() => library.getUploadStatus(arweaveHash), {
    expectedRevert: 'Upload not found',
    fallback: null,
    label: 'library.getUploadStatus',
  });

  return status === null ? null : UPLOAD_STATUS[Number(status)] ?? `unknown(${status})`;
}

/**
 * Every arweaveHash registered by one address.
 *
 * Doubles as the escape hatch for the indexed-string problem: `uploader` is an
 * indexed *address* and so is readable straight off a log, which means an event
 * for a book this backend has never seen can still be resolved to a plaintext
 * hash by listing that uploader's books and matching keccak256.
 *
 * @param {string} uploader
 * @returns {Promise<string[]>}
 */
async function getUploaderHashes(uploader) {
  const { library } = getContracts();
  return read(() => library.getUploaderHashes(uploader), {
    fallback: [],
    label: 'library.getUploaderHashes',
  });
}

// ─── Stake ───────────────────────────────────────────────────────────────────

/**
 * Stake + challenge state for a book.
 *
 * Unlike the library, AlexandriaStake.getStakeStatus() returns a zeroed struct
 * rather than reverting for an unknown hash, so "never staked" is detected by a
 * zero timestamp.
 *
 * @param {string} arweaveHash
 */
async function getStakeStatus(arweaveHash) {
  const { stake } = getContracts();

  const [info, challenge, challengePeriod] = await Promise.all([
    read(() => stake.getStakeStatus(arweaveHash), { label: 'stake.getStakeStatus' }),
    read(() => stake.challenges(arweaveHash), { label: 'stake.challenges' }),
    read(() => stake.CHALLENGE_PERIOD(), {
      fallback: BigInt(FALLBACK_CHALLENGE_PERIOD),
      label: 'stake.CHALLENGE_PERIOD',
    }),
  ]);

  const stakedAt = toNumberSeconds(info.timestamp);

  if (!stakedAt) {
    return { staked: false, active: false, challenge: null };
  }

  const period = Number(challengePeriod);
  const challengeEndsAt = stakedAt + period;
  const challenger = challenge.challenger;
  const hasChallenge = challenger && challenger !== ethers.ZeroAddress;

  return {
    staked: true,
    active: Boolean(info.active),
    staker: info.staker,
    // Atomic units (18 decimals). Sent as a string because 100 ALEX is 1e20,
    // well past Number.MAX_SAFE_INTEGER — JSON.stringify would round it.
    stakeAmount: info.amount.toString(),
    stakeAmountAlex: ethers.formatUnits(info.amount, 18),
    stakeTime: toIsoOrNull(stakedAt),
    challengePeriodEnds: toIsoOrNull(challengeEndsAt),
    // Whether unstake() would be allowed on time grounds. It has other
    // preconditions (status not Challenged/Rejected) that the library covers.
    challengePeriodOver: Math.floor(Date.now() / 1000) >= challengeEndsAt,
    challenge: hasChallenge
      ? {
          challenger,
          reason: challenge.reason,
          resolved: Boolean(challenge.resolved),
          challengedAt: toIsoOrNull(challenge.timestamp),
        }
      : null,
  };
}

// ─── Rent ────────────────────────────────────────────────────────────────────

/**
 * Rental permission for one reader on one book.
 *
 * Returns `{ active, expiry, ... }`. If the Rent contract is paused, the
 * contract's own check reverts; that is reported as `active: false` with
 * `available: false` so the caller fails closed but can tell the difference
 * between "denied" and "undeterminable".
 *
 * @param {string} arweaveHash
 * @param {string} address reader wallet
 */
async function isRentalActive(arweaveHash, address) {
  const { rent } = getContracts();
  const renter = ethers.getAddress(address);

  // `rentals` and `blacklisted` are plain public getters with no pause modifier,
  // so they still answer while the contract is paused.
  const [expiry, blacklisted, paused] = await Promise.all([
    read(() => rent.rentals(arweaveHash, renter), { label: 'rent.rentals' }),
    read(() => rent.blacklisted(renter), { label: 'rent.blacklisted' }),
    read(() => rent.paused(), { fallback: false, label: 'rent.paused' }),
  ]);

  const expiryTime = toNumberSeconds(expiry);
  const base = {
    expiry: toIsoOrNull(expiryTime),
    expiryUnix: expiryTime || null,
    blacklisted: Boolean(blacklisted),
  };

  if (paused) {
    return {
      ...base,
      active: false,
      available: false,
      reason: 'rent_contract_paused',
    };
  }

  const active = await read(() => rent.isRentalActive(arweaveHash, renter), {
    label: 'rent.isRentalActive',
  });

  return { ...base, active: Boolean(active), available: true, reason: null };
}

/**
 * Per-day rental price in atomic ALEX units, plus whether the book is delisted.
 * @param {string} arweaveHash
 */
async function getBookRental(arweaveHash) {
  const { rent } = getContracts();

  const [price, delisted] = await Promise.all([
    read(() => rent.bookPrices(arweaveHash), { label: 'rent.bookPrices' }),
    read(() => rent.delisted(arweaveHash), { label: 'rent.delisted' }),
  ]);

  return {
    pricePerDay: price.toString(),
    pricePerDayAlex: ethers.formatUnits(price, 18),
    priceSet: price > 0n,
    delisted: Boolean(delisted),
  };
}

module.exports = {
  ChainError,
  UPLOAD_STATUS,
  getUploadOnChain,
  getUploadStatusOnChain,
  getUploaderHashes,
  getStakeStatus,
  isRentalActive,
  getBookRental,
};
