// Rental status + the rental-gated decryption payload.
//
// Both endpoints read live on-chain state through services/blockchain.service.
// Nothing here is authoritative: Rent.sol owns rental permission, and the Lit
// Action owns whether a key is ever released. See getDecryptParams below for
// why that distinction is what makes this route safe to serve.

const { ethers } = require('ethers');
const prisma = require('../config/db');
const { isValidArweaveHash } = require('./arweave');
const { toPublicUpload, PUBLIC_UPLOAD_SELECT } = require('./upload.controller');
const { isValidWalletAddress } = require('../middleware/auth.middleware');
const {
  isRentalActive,
  getBookRental,
  getUploadOnChain,
  getStakeStatus,
  isActiveLibrarian,
  ChainError,
} = require('../services/blockchain.service');

function badRequest(res, reason, message) {
  return res.status(400).json({ error: reason, message });
}

/**
 * May this wallet open a book as a librarian reviewing it?
 *
 * The caller is an active librarian and the book has an active stake, then one
 * of two cases, the same two the decryption Lit Action opens (invariant 9):
 *
 *   not challenged — the 14-day window is still open, as
 *                    AlexandriaStake.challengeUpload() requires.
 *   challenged     — the challenge is not resolved, and its own 14-day review
 *                    period (CHALLENGE_PERIOD from the challenge, not from the
 *                    stake) is still running. The three independent reviewers
 *                    must read what they vote on; voting closes at the same time.
 *
 * A challenge on record means the library status is Challenged: challengeUpload()
 * writes both, and resolveChallenge() marks it resolved as it moves the status on.
 *
 * The book's own uploader is excluded because the uploader carve-out has already
 * answered for them, and a librarian cannot challenge their own upload in any case.
 *
 * Fails closed: an unreadable chain denies review rather than granting it.
 *
 * @param {string} arweaveHash
 * @param {string} address wallet
 * @returns {Promise<boolean>}
 */
async function isLibrarianReviewAllowed(arweaveHash, address) {
  try {
    const librarian = await isActiveLibrarian(address);
    if (!librarian.active) return false;

    const stake = await getStakeStatus(arweaveHash);
    if (!stake.staked || !stake.active || !stake.staker) return false;
    if (stake.staker.toLowerCase() === address.toLowerCase()) return false;

    if (stake.challenge) return stake.challenge.resolved === false && stake.challenge.reviewOver === false;
    return stake.challengePeriodOver === false;
  } catch (err) {
    return false;
  }
}

// Indexed statuses of a book that registerUpload() has not recorded on-chain yet.
// Postgres knows its uploader, but the Action reads the uploader from the chain,
// gets a revert, and denies, so letting these through would spend a Lit credit on
// a certain refusal.
const NOT_REGISTERED_STATUSES = new Set(['pending_confirmation', 'pending_stake', 'storage_failed']);

const STAKE_REQUIRED_MESSAGE =
  'Stake this book to open it. Archivists can read their own uploads once they have staked them.';

/** Why a book cannot be opened yet, in words its archivist can act on. */
function notRegisteredMessage(status) {
  return status === 'storage_failed'
    ? 'This book was never stored on Arweave, so it cannot be opened. Upload it again.'
    : `This book is not registered on-chain yet (status: ${status}). It can be opened once storage and registration finish.`;
}

/**
 * May this wallet read this book? The same three doors the decryption Lit Action
 * opens — uploader, active rental, librarian review — checked against live chain
 * state. Shared by decrypt-params and the unlock relay; the Action re-checks all
 * of it inside the TEE, so this is never the last word.
 *
 * @param {{ arweaveHash: string, uploader: string|null, status: string }} row  the indexed upload
 * @param {string} address
 * @returns {Promise<{ allowed: boolean, grantedVia?: string, unavailable?: boolean, notRegistered?: boolean,
 *   stakeRequired?: boolean, rental: object|null }>}
 *   unavailable   — the Rent contract is paused, so permission cannot be read
 *   notRegistered — not on-chain yet, so the Action would refuse everyone
 *   stakeRequired — the uploader asked, but has not staked the book
 * @throws {ChainError} when the chain cannot be read at all
 */
async function checkReadAccess(row, address) {
  // Before the uploader door: that door trusts Postgres, the Action trusts the chain.
  if (NOT_REGISTERED_STATUSES.has(row.status)) {
    return { allowed: false, notRegistered: true, rental: null };
  }

  // The uploader door opens only for an archivist who staked the book. Registration
  // is automatic, so without this anyone could upload a PDF, never stake, and open
  // "their" book on Alexandria's Lit credit. stake() records the staker, and the
  // record outlives unstake() and slashing, so approved books stay readable.
  // The uploader cannot rent their own book or review it either, so a refusal
  // here is final.
  if (row.uploader && row.uploader.toLowerCase() === address.toLowerCase()) {
    const stake = await getStakeStatus(row.arweaveHash);
    if (stake.staked && stake.staker && stake.staker.toLowerCase() === address.toLowerCase()) {
      return { allowed: true, grantedVia: 'uploader', rental: null };
    }
    return { allowed: false, stakeRequired: true, rental: null };
  }

  const rental = await isRentalActive(row.arweaveHash, address);
  if (rental.available === false) return { allowed: false, unavailable: true, rental };
  if (rental.active) return { allowed: true, grantedVia: 'rental', rental };

  // A book that is not Approved is not rentable — Rent.rentBook() requires it —
  // so a librarian who has to read it before challenging, or to review a
  // challenge, cannot buy access even in good faith. Open while the book is
  // challengeable, and for 14 days after a challenge while it is unresolved.
  if (await isLibrarianReviewAllowed(row.arweaveHash, address)) {
    return { allowed: true, grantedVia: 'librarian_review', rental };
  }

  return { allowed: false, rental };
}

/**
 * Validate the two path params every route here takes.
 * @returns {{ arweaveHash: string, address: string }|null} null after responding
 */
function readParams(req, res, { requireAddress = true } = {}) {
  const { arweaveHash, address } = req.params;

  if (!isValidArweaveHash(arweaveHash)) {
    badRequest(res, 'invalid_hash', 'arweaveHash must be a 43-character base64url transaction ID.');
    return null;
  }

  if (requireAddress && !isValidWalletAddress(address)) {
    badRequest(res, 'invalid_address', 'address must be a valid Ethereum address.');
    return null;
  }

  return { arweaveHash, address };
}

/** Turn a ChainError into its intended HTTP response; re-throw anything else. */
function handleChainError(err, res, next) {
  if (err instanceof ChainError) {
    return res.status(err.status).json({
      error: err.reason,
      message: err.message,
    });
  }
  return next(err);
}

// GET /api/rental/status/:arweaveHash/:address
//
// Live rental permission for one reader on one book, straight from Rent.sol.
// Deliberately not cached — a rental expires on a wall-clock timestamp, and a
// cached "active" is a cached authorization.
async function getRentalStatus(req, res, next) {
  const params = readParams(req, res);
  if (!params) return undefined;

  try {
    const [rental, book] = await Promise.all([
      isRentalActive(params.arweaveHash, params.address),
      getBookRental(params.arweaveHash),
    ]);

    // `available: false` means the Rent contract is paused, so its own
    // permission check reverts rather than answering. Reported as 503 with
    // active:false — the caller must fail closed, but must not cache this as a
    // settled "no".
    const status = rental.available === false ? 503 : 200;

    return res.status(status).json({
      arweaveHash: params.arweaveHash,
      address: params.address,
      active: rental.active,
      expiry: rental.expiry,
      expiryUnix: rental.expiryUnix,
      blacklisted: rental.blacklisted,
      available: rental.available !== false,
      reason: rental.reason,
      book: {
        pricePerDay: book.pricePerDay,
        pricePerDayAlex: book.pricePerDayAlex,
        priceSet: book.priceSet,
        delisted: book.delisted,
      },
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}


 *
 * @param {string} arweaveHash
 * @param {string} address     renter, any case
 * @param {number|null} expiryUnix  Rent.rentals(hash, renter), in seconds
 * @returns {Promise<string|null>}
 */
async function findRentalTxHash(arweaveHash, address, expiryUnix) {
  if (!expiryUnix) return null;
  try {
    const event = await prisma.event.findFirst({
      where: {
        contract: 'rent',
        eventName: 'BookRented',
        arweaveHash,
        AND: [
          // As the listener stores them: the renter checksummed, uint256 as decimal strings.
          { args: { path: ['renter'], equals: ethers.getAddress(address) } },
          { args: { path: ['expiry'], equals: String(expiryUnix) } },
        ],
      },
      select: { transactionHash: true },
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
    });
    return event ? event.transactionHash : null;
  } catch (err) {
    console.warn(`[rental] rental tx lookup failed for ${arweaveHash}: ${err.message}`);
    return null;
  }
}

// GET /api/rental/decrypt-params/:arweaveHash/:address
//
// Serves the material the frontend needs to attempt decryption: the sealed
// symmetric key, Lit's integrity hash for it, and the AES-GCM IV + auth tag.
//
// ─── What actually protects the book ─────────────────────────────────────────
//
// Not this endpoint. The key is sealed inside a Lit PKP envelope, and it is
// released only by a Lit Action running in a TEE, which re-checks
// Rent.isRentalActive() against the arweaveHash sealed *inside* the ciphertext.
// Everything served here is inert without that release: the ciphertext of a key
// nobody can open, plus an IV and an auth tag that are already public in the
// Arweave tags.
//
// ⚠️ The rental check below is therefore defense in depth, and it is only as
// strong as the address it is handed. `address` is a path parameter with no
// signature behind it, so anyone can name a wallet that holds a valid rental and
// be served this payload. That is an accepted PoC tradeoff *only* because the
// Lit Action is the real gate — it would not be acceptable if this route ever
// returned a usable key.
//
// The signed step is the next one: POST /api/rental/unlock (unlock.controller.js)
// recovers the reader's address from an EIP-4361 signature, and the Lit Action
// does the same inside the TEE. This route only hands out what that step needs.
//
// ⚠️ Archivists cannot rent their own books — Rent.rentBook() rejects
// `getUploader(hash) == msg.sender` outright. So the uploader is allowed through
// here explicitly. The decryption Lit Action needs the same carve-out, or an
// archivist will be unable to open the book they uploaded. See KEY-BINDING.md.
async function getDecryptParams(req, res, next) {
  const params = readParams(req, res);
  if (!params) return undefined;

  try {
    const row = await prisma.upload.findUnique({
      where: { arweaveHash: params.arweaveHash },
      select: {
        arweaveHash: true,
        uploader: true,
        status: true,
        litEncryptedKeyId: true,
        litDataToEncryptHash: true,
        encryptionIv: true,
        encryptionAuthTag: true,
      },
    });

    if (!row) {
      return res.status(404).json({
        error: 'not_found',
        message: `No upload indexed for ${params.arweaveHash}.`,
      });
    }

    const access = await checkReadAccess(row, params.address);

    if (access.notRegistered) {
      return res.status(409).json({ error: 'not_registered', message: notRegisteredMessage(row.status) });
    }

    if (access.stakeRequired) {
      return res.status(403).json({ error: 'stake_required', message: STAKE_REQUIRED_MESSAGE });
    }

    if (access.unavailable) {
      return res.status(503).json({
        error: 'rent_contract_paused',
        message: 'Rental permission cannot be checked right now — the Rent contract is paused.',
      });
    }

    if (!access.allowed) {
      return res.status(403).json({
        error: 'no_active_rental',
        message: access.rental.blacklisted
          ? 'This address is blacklisted from renting.'
          : 'No active rental for this address. Rent the book on-chain first.',
        expiry: access.rental.expiry,
      });
    }

    // Only the rental door has a rental transaction. BookRented is public
    // (renter is an indexed topic), so this exposes nothing new.
    const rentalTxHash = access.grantedVia === 'rental'
      ? await findRentalTxHash(row.arweaveHash, params.address, access.rental.expiryUnix)
      : null;

    return res.json({
      arweaveHash: row.arweaveHash,
      status: row.status,
      grantedVia: access.grantedVia,
      expiry: access.rental ? access.rental.expiry : null,
      rentalTxHash,
      // The sealed envelope { v, k, arweaveHash } and Lit's integrity hash for
      // it. Handed to the Lit Action, never opened here — the backend is not in
      // the decryption path and holds nothing that could open it.
      litEncryptedKeyId: row.litEncryptedKeyId,
      litDataToEncryptHash: row.litDataToEncryptHash,
      // AES-256-GCM parameters for the PDF itself, once the Action releases the
      // symmetric key. Both are also on the Arweave tags.
      encryptionIv: row.encryptionIv,
      encryptionAuthTag: row.encryptionAuthTag,
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// GET /api/rental/book/:arweaveHash
// Price and listing state, plus whether the library has it registered at all.
async function getBookRentalInfo(req, res, next) {
  const params = readParams(req, res, { requireAddress: false });
  if (!params) return undefined;

  try {
    const [book, onChain] = await Promise.all([
      getBookRental(params.arweaveHash),
      getUploadOnChain(params.arweaveHash),
    ]);

    return res.json({
      arweaveHash: params.arweaveHash,
      registered: onChain.registered,
      onChainStatus: onChain.registered ? onChain.status : null,
      uploader: onChain.registered ? onChain.uploader : null,
      // rentBook() requires Approved status, a non-zero price, and not delisted.
      rentable: Boolean(onChain.registered && onChain.status === 'approved' && book.priceSet && !book.delisted),
      ...book,
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// The most rentals one renter listing returns, newest first.
const RENTER_LIMIT = 200;

// GET /api/rental/renter/:address
//
// Every rental this wallet made, newest first, for the Reader dashboard: what
// it is renting now and what it rented before. Read from the BookRented events
// the listener mirrors into Postgres (services/eventListener.service.js), not
// from the chain: Rent.sol keeps rentals[hash][renter] per book and cannot be
// listed by renter.
//
// Each event's expiry is exactly what Rent.rentBook() stored, and rentBook()
// refuses a second rental of a book while one is active, so "expiry in the
// future" is "rented now". Informational only, like the rest of this file: the
// Reader's decrypt-params check and the Lit Action decide access, so a
// blacklisted renter still listed here is refused when they open the book.
//
// No new exposure: renter is an indexed topic of BookRented, so every wallet's
// rentals are already public on-chain.
async function getRenterRentals(req, res, next) {
  const { address } = req.params;
  if (!isValidWalletAddress(address)) {
    return badRequest(res, 'invalid_address', 'address must be a valid Ethereum address.');
  }

  try {
    const events = await prisma.event.findMany({
      where: {
        contract: 'rent',
        eventName: 'BookRented',
        // ethers decodes addresses checksummed, and the listener stores them as decoded.
        args: { path: ['renter'], equals: ethers.getAddress(address) },
      },
      select: { arweaveHash: true, args: true, timestamp: true, transactionHash: true },
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: RENTER_LIMIT,
    });

    // A book the listener could not resolve to a hash has nothing to open or link.
    const resolved = events.filter((e) => e.arweaveHash);
    const rows = resolved.length
      ? await prisma.upload.findMany({
          where: { arweaveHash: { in: [...new Set(resolved.map((e) => e.arweaveHash))] } },
          select: PUBLIC_UPLOAD_SELECT,
        })
      : [];
    const bookByHash = new Map(rows.map((row) => [row.arweaveHash, toPublicUpload(row)]));

    const now = Date.now();
    const rentals = resolved.map((e) => {
      // uint256 seconds, stored as decimal strings (BigInt is not JSON).
      const expiryMs = Number(e.args.expiry) * 1000;
      return {
        arweaveHash: e.arweaveHash,
        book: bookByHash.get(e.arweaveHash) || null,
        rentedAt: e.timestamp,
        expiry: new Date(expiryMs).toISOString(),
        durationDays: Number(e.args.duration) / 86_400,
        active: expiryMs > now,
        transactionHash: e.transactionHash,
      };
    });

    return res.json({
      address,
      rentals,
      activeCount: rentals.filter((r) => r.active).length,
      total: rentals.length,
      unresolved: events.length - resolved.length,
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

module.exports = {
  getRentalStatus,
  getDecryptParams,
  getBookRentalInfo,
  getRenterRentals,
  checkReadAccess,
  notRegisteredMessage,
  NOT_REGISTERED_STATUSES,
  STAKE_REQUIRED_MESSAGE,
  handleChainError,
  readParams,
};
