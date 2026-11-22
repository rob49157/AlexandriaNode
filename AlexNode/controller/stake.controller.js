// Stake status — live on-chain read, joined against the Postgres index.
//
// Two different questions get answered together because the frontend always
// needs both: "what does the chain say about this stake" (AlexandriaStake) and
// "does our index agree" (Upload.status). A disagreement is a listener lag or a
// sync bug, and surfacing it is more useful than silently preferring one.

const prisma = require('../config/db');
const { isValidArweaveHash } = require('./arweave');
const { getStakeStatus, getUploadOnChain } = require('../services/blockchain.service');
const { handleChainError, NOT_REGISTERED_STATUSES } = require('./rental.controller');
const { isValidWalletAddress } = require('../middleware/auth.middleware');
const { toPublicUpload, PUBLIC_UPLOAD_SELECT } = require('./upload.controller');
const { settleInChunks } = require('./librarian.controller');

// The most uploads one archivist listing returns, newest first.
const ARCHIVIST_LIMIT = 100;

/**
 * May the archivist publish this book now, i.e. would AlexandriaStake.unstake()
 * succeed for them? It requires, in contract order:
 *   stakes[hash].active                                  the stake is still held
 *   stakes[hash].staker == msg.sender                    their own stake
 *   block.timestamp >= stake.timestamp + CHALLENGE_PERIOD the 14-day window is over
 *   status != Challenged && status != Rejected           nobody challenged it
 * A challenge on record covers the last line: challengeUpload() is the only way
 * to Challenged, and a resolved challenge leaves the stake inactive.
 *
 * unstake() is what makes an unchallenged book Approved (rentable), returns the
 * stake, and pays the upload reward. Only the archivist can call it.
 */
function canPublish(stake, address) {
  return Boolean(
    stake &&
      stake.active &&
      stake.staker &&
      stake.staker.toLowerCase() === address.toLowerCase() &&
      stake.challengePeriodOver === true &&
      !stake.challenge
  );
}

// GET /api/stake/archivist/:address
// Every upload this wallet made, with the on-chain stake state the Archivist
// dashboard acts on: the window countdown, any challenge and its review
// deadline, and whether "Publish & reclaim stake" would succeed right now.
// Upload.status cannot answer that: Postgres "pending" covers both a registered
// book nobody staked and a staked one whose window is running or over.
async function getArchivistUploads(req, res, next) {
  const { address } = req.params;
  if (!isValidWalletAddress(address)) {
    return res.status(400).json({ error: 'invalid_wallet_address', message: 'address must be a valid Ethereum address.' });
  }

  try {
    const rows = await prisma.upload.findMany({
      // Uploads store the uploader lower-case (services/uploadQuota.service.js).
      where: { uploader: address.toLowerCase() },
      select: PUBLIC_UPLOAD_SELECT,
      orderBy: { uploadTimestamp: 'desc' },
      take: ARCHIVIST_LIMIT,
    });

    // Not on-chain yet, so there is no stake to read.
    const onChainRows = rows.filter((row) => !NOT_REGISTERED_STATUSES.has(row.status));
    const results = await settleInChunks(onChainRows, (row) => getStakeStatus(row.arweaveHash));
    const stakeByHash = new Map();
    let unavailable = 0;
    onChainRows.forEach((row, i) => {
      if (results[i].status === 'fulfilled') stakeByHash.set(row.arweaveHash, results[i].value);
      else unavailable++;
    });

    const uploads = rows.map((row) => {
      const stake = stakeByHash.get(row.arweaveHash) || null;
      return {
        ...toPublicUpload(row),
        stake: stake && {
          staked: stake.staked,
          active: stake.active,
          stakeAmountAlex: stake.stakeAmountAlex ?? null,
          stakeTime: stake.stakeTime ?? null,
          challengePeriodEnds: stake.challengePeriodEnds ?? null,
          challengePeriodOver: stake.challengePeriodOver ?? null,
          challenge: stake.challenge,
        },
        // A row whose chain read failed is never publishable: unknown is "no".
        canPublish: canPublish(stake, address),
      };
    });

    return res.json({ uploads, total: uploads.length, unavailable });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// GET /api/stake/status/:arweaveHash
async function getStakeStatusForHash(req, res, next) {
  const { arweaveHash } = req.params;

  if (!isValidArweaveHash(arweaveHash)) {
    return res.status(400).json({
      error: 'invalid_hash',
      message: 'arweaveHash must be a 43-character base64url transaction ID.',
    });
  }

  try {
    const [stake, onChain, row] = await Promise.all([
      getStakeStatus(arweaveHash),
      getUploadOnChain(arweaveHash),
      prisma.upload.findUnique({
        where: { arweaveHash },
        select: { status: true, uploader: true, title: true },
      }),
    ]);

    // The book exists nowhere we can see it. 404 rather than an empty stake,
    // which would imply the book is real and merely unstaked.
    if (!onChain.registered && !row) {
      return res.status(404).json({
        error: 'not_found',
        message: `No upload indexed or registered for ${arweaveHash}.`,
      });
    }

    // AlexandriaLibrary is the authority on status; it is what stake.sol and
    // rent.sol both read. Before registration the status is off-chain only:
    //   pending_stake         bytes stored, registerUpload() not called yet
    //   pending_confirmation  bytes NOT stored yet (storage worker still running)
    //   storage_failed        bytes never stored; the archivist must re-upload
    // The last two used to be reported as pending_stake, which told the frontend
    // to ask for a stake that stake.stake() would revert.
    const OFF_CHAIN_STORAGE_STATES = ['pending_confirmation', 'storage_failed'];
    const status = onChain.registered
      ? onChain.status
      : row && OFF_CHAIN_STORAGE_STATES.includes(row.status)
        ? row.status
        : 'pending_stake';

    return res.json({
      arweaveHash,
      status,
      registered: onChain.registered,
      uploader: onChain.uploader ?? row?.uploader ?? null,
      title: row?.title ?? null,

      staked: stake.staked,
      stakeActive: stake.active,
      staker: stake.staker ?? null,
      stakeAmount: stake.stakeAmount ?? null,
      stakeAmountAlex: stake.stakeAmountAlex ?? null,
      stakeTime: stake.stakeTime ?? null,
      challengePeriodEnds: stake.challengePeriodEnds ?? null,
      challengePeriodOver: stake.challengePeriodOver ?? null,
      challenge: stake.challenge,

      index: {
        status: row?.status ?? null,
        // True when the event listener has not yet applied the on-chain status.
        // Expected briefly after a transaction; persistent drift is a bug.
        inSync: row ? row.status === status : null,
      },
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

module.exports = { getStakeStatusForHash, getArchivistUploads, canPublish };
