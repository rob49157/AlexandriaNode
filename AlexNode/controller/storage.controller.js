// Storage worker observability (ARWEAVE-DIRECT-PLAN.md §4.8).
//
// Same reasoning as /api/chain/status: the worker is a background loop, so "the
// worker died" and "nobody uploaded today" must not look the same from outside.

const prisma = require('../config/db');
const cfg = require('../config/arweave');
const storage = require('../services/storage.service');
const { isValidArweaveHash, fetchEncrypted } = require('./arweave');

const STORAGE_STATUSES = ['pending_confirmation', 'storage_failed'];

// GET /api/storage/status
// Wallet, balance, uploads per storage state, the oldest one still pending, and
// the worker's last error. 503 when the worker is stopped.
async function getStorageStatus(req, res, next) {
  try {
    const worker = storage.health();

    const [pending, failed, oldest] = await Promise.all([
      prisma.upload.count({ where: { status: 'pending_confirmation' } }),
      prisma.upload.count({ where: { status: 'storage_failed' } }),
      prisma.upload.findFirst({
        where: { status: 'pending_confirmation' },
        orderBy: { uploadTimestamp: 'asc' },
        select: { arweaveHash: true, uploadTimestamp: true },
      }),
    ]);

    // Balance is best effort: a node outage must not hide the worker's state.
    let wallet;
    try {
      const b = await cfg.getBalance();
      wallet = { address: b.address, balanceAr: b.ar, balanceWinston: b.winston };
    } catch (err) {
      wallet = { address: cfg.ARWEAVE_WALLET_ADDRESS || null, error: err.message };
    }

    return res.status(worker.running ? 200 : 503).json({
      worker,
      wallet,
      settings: {
        confirmations: cfg.ARWEAVE_CONFIRMATIONS,
        minHolders: cfg.ARWEAVE_MIN_HOLDERS,
        rewardMarginPercent: cfg.ARWEAVE_REWARD_MARGIN_PERCENT,
        maxRewardAr: cfg.winstonToAr(cfg.ARWEAVE_MAX_REWARD_WINSTON),
      },
      uploads: {
        pendingConfirmation: pending,
        storageFailed: failed,
        oldestPending: oldest
          ? {
              arweaveHash: oldest.arweaveHash,
              since: oldest.uploadTimestamp,
              ageMinutes: Math.round((Date.now() - new Date(oldest.uploadTimestamp).getTime()) / 60_000),
            }
          : null,
      },
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/storage/:arweaveHash
// Progress of one upload, for the frontend to poll after POST /api/upload's 202.
// Public: node addresses and counts only. The signed header is not returned.
async function getUploadStorage(req, res, next) {
  try {
    const { arweaveHash } = req.params;
    if (!isValidArweaveHash(arweaveHash)) {
      return res.status(400).json({ error: 'invalid_hash', message: 'arweaveHash must be a 43-character base64url transaction ID.' });
    }
    const row = await prisma.upload.findUnique({
      where: { arweaveHash },
      select: {
        status: true,
        storageProvider: true,
        arweaveTxPostedAt: true,
        arweaveBlockHeight: true,
        arweaveConfirmations: true,
        arweaveReward: true,
        arweaveUploaderState: true,
        storageError: true,
        storageAttempts: true,
      },
    });
    if (!row) return res.status(404).json({ error: 'not_found', message: `No upload indexed for ${arweaveHash}.` });

    const state = row.arweaveUploaderState || {};
    const holders = Object.values(state.holders || {});
    const stored = !STORAGE_STATUSES.includes(row.status);
    return res.json({
      arweaveHash,
      status: row.status,
      stored,
      provider: row.storageProvider,
      mined: row.arweaveBlockHeight != null,
      blockHeight: row.arweaveBlockHeight,
      confirmations: row.arweaveConfirmations,
      confirmationsRequired: cfg.ARWEAVE_CONFIRMATIONS,
      copiesComplete: holders.filter((h) => h.done).length,
      copiesRequired: cfg.ARWEAVE_MIN_HOLDERS,
      verifiedCopies: state.verified ? state.verified.nodes.length : 0,
      rewardAr: row.arweaveReward ? cfg.winstonToAr(row.arweaveReward) : null,
      postedAt: row.arweaveTxPostedAt,
      error: row.storageError,
      attempts: row.storageAttempts,
    });
  } catch (err) {
    return next(err);
  }
}

// Concurrent readers of the same book share one fetch rather than each pulling
// up to 150 MiB from the network.
const inflightReads = new Map();

// GET /api/storage/:arweaveHash/data
// The encrypted book, read from raw Arweave nodes with every chunk proof-checked
// against the signed header (controller/arweave.js fetchEncrypted).
//
// Why the backend serves this instead of the browser reading Arweave itself:
// raw nodes speak plain HTTP, which an HTTPS page cannot fetch (mixed content),
// and the only HTTPS alternative is a third-party gateway (decision D8).
//
// Not a security boundary: this is the same public ciphertext anyone can read off
// Arweave, useless without the key that only the Lit Action releases. Served only
// for books this backend indexed and verified as stored, so it is not an open
// gateway for arbitrary Arweave content.
async function getUploadData(req, res, next) {
  try {
    const { arweaveHash } = req.params;
    if (!isValidArweaveHash(arweaveHash)) {
      return res.status(400).json({ error: 'invalid_hash', message: 'arweaveHash must be a 43-character base64url transaction ID.' });
    }
    const row = await prisma.upload.findUnique({
      where: { arweaveHash },
      select: { status: true, storageProvider: true, fileSize: true, arweaveUploaderState: true },
    });
    if (!row) return res.status(404).json({ error: 'not_found', message: `No upload indexed for ${arweaveHash}.` });
    if (row.storageProvider !== 'arweave-l1') {
      return res.status(404).json({ error: 'not_on_arweave', message: 'This upload was never stored on Arweave mainnet.' });
    }
    if (STORAGE_STATUSES.includes(row.status)) {
      return res.status(409).json({ error: 'storage_not_confirmed', status: row.status, message: 'The book is not stored yet.' });
    }

    const state = row.arweaveUploaderState || {};
    const preferNodes = (state.verified && state.verified.nodes) || [];
    if (!inflightReads.has(arweaveHash)) {
      const p = fetchEncrypted(arweaveHash, { preferNodes }).finally(() => inflightReads.delete(arweaveHash));
      inflightReads.set(arweaveHash, p);
    }
    const data = await inflightReads.get(arweaveHash);

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
      // Content-addressed: this id can only ever name these bytes.
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${arweaveHash}"`,
    });
    return res.status(200).send(data);
  } catch (err) {
    if (err.code === 'arweave_unavailable') {
      return res.status(503).json({ error: 'arweave_unavailable', message: err.message });
    }
    return next(err);
  }
}

module.exports = { getStorageStatus, getUploadStorage, getUploadData };
