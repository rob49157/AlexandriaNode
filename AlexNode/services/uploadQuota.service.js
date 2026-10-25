// Upload limits: who may upload now, and whether Alexandria can pay for it today.
//
// An upload is the most expensive thing Alexandria does. The storage wallet pays
// the Arweave fee (~$0.06/MiB, up to ~2 AR for a 150 MiB book) permanently, at
// mining, BEFORE the archivist stakes anything. An archivist who never stakes
// costs that fee and returns nothing, and wallets are free to create. So:
//
//   awaiting stake  per wallet, at most UPLOAD_MAX_AWAITING_STAKE uploads that
//                   are stored or being stored but carry no stake yet. Staking one
//                   frees a slot, so an archivist who stakes each book is never
//                   held back, and one who never stakes is.
//   per day         per wallet, at most UPLOAD_MAX_PER_WALLET_PER_DAY uploads in
//                   any 24 hours, so one wallet cannot take the whole budget.
//   budget          all wallets together, at most UPLOAD_DAILY_BUDGET_AR of
//                   storage fees in any 24 hours. The only limit that new wallets
//                   cannot get around, so it caps what the storage wallet can lose.
//
// The per-wallet rules are only as good as the wallet's identity, which is why
// uploads are signed (uploadAuth.service.js).
//
// Counts come from Postgres, so they survive restarts. Two uploads checked at the
// same instant can both pass (neither row exists yet); like the wallet balance
// check in upload.controller.js, this closes the common case, not that race.

const prisma = require('../config/db');
const { getStakeStatus } = require('./blockchain.service');
const { arToWinston, winstonToAr } = require('../config/arweave');

// Statuses of an upload that has cost (or is about to cost) storage and that its
// archivist may not have staked: before registration nobody can stake, and
// "pending" covers both registered-unstaked and staked, so the chain decides.
// storage_failed is excluded: a header that is never mined is never paid for.
const AWAITING_STAKE_STATUSES = ['pending_confirmation', 'pending_stake', 'pending'];
const DAY_MS = 24 * 60 * 60_000;

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function uploadLimits() {
  return {
    maxAwaitingStake: envInt('UPLOAD_MAX_AWAITING_STAKE', 3),
    maxPerWalletPerDay: envInt('UPLOAD_MAX_PER_WALLET_PER_DAY', 10),
    // Throws on a malformed value: a budget that silently fell back would be worse.
    dailyBudgetWinston: arToWinston(process.env.UPLOAD_DAILY_BUDGET_AR || '3'),
  };
}

/** Has this book been staked? An unreadable chain counts as "no": refuse rather than over-allow. */
async function isStaked(arweaveHash) {
  try {
    return (await getStakeStatus(arweaveHash)).staked === true;
  } catch {
    return false;
  }
}

/**
 * This wallet's uploads that are holding a slot: stored or being stored, no stake.
 * @param {string} address lower-case (uploads store the uploader lower-case)
 */
async function awaitingStake(address) {
  const rows = await prisma.upload.findMany({
    where: { uploader: address.toLowerCase(), status: { in: AWAITING_STAKE_STATUSES } },
    select: { arweaveHash: true, title: true, status: true, uploadTimestamp: true },
  });
  // Only registered books can carry a stake, so only they need a chain read, and
  // those reads run together: a busy archivist can have many books under review.
  const staked = await Promise.all(rows.map((row) => (row.status === 'pending' ? isStaked(row.arweaveHash) : false)));
  return rows
    .filter((row, i) => !staked[i])
    .map((row) => ({ arweaveHash: row.arweaveHash, title: row.title, status: row.status }));
}

async function uploadsInLastDay(address, now) {
  return prisma.upload.count({
    where: {
      uploader: address.toLowerCase(),
      uploadTimestamp: { gte: new Date(now - DAY_MS) },
      status: { not: 'storage_failed' },
    },
  });
}

/** Storage fees signed into uploads in the last 24 hours, mined or about to be. */
async function storageSpentWinston(now) {
  const rows = await prisma.upload.findMany({
    where: {
      storageProvider: 'arweave-l1',
      uploadTimestamp: { gte: new Date(now - DAY_MS) },
      status: { not: 'storage_failed' },
    },
    select: { arweaveReward: true },
  });
  return rows.reduce((sum, r) => sum + BigInt(r.arweaveReward || '0'), 0n);
}

/**
 * The per-wallet rules. Checked before any work is done on an upload.
 *
 * @param {string} address
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string, message?: string,
 *   awaiting: object[], last24h: number, limits: object }>}
 */
async function checkWalletQuota(address, { now = Date.now() } = {}) {
  const limits = uploadLimits();
  const [awaiting, last24h] = await Promise.all([awaitingStake(address), uploadsInLastDay(address, now)]);
  const base = { awaiting, last24h, limits };

  if (awaiting.length >= limits.maxAwaitingStake) {
    return {
      ...base,
      ok: false,
      status: 429,
      reason: 'too_many_awaiting_stake',
      message:
        `You have ${awaiting.length} uploads waiting for a stake, and the limit is ${limits.maxAwaitingStake}. ` +
        'Stake one of them to upload another. Books still being stored count too, until you can stake them.',
    };
  }
  if (last24h >= limits.maxPerWalletPerDay) {
    return {
      ...base,
      ok: false,
      status: 429,
      reason: 'daily_upload_limit',
      message: `You have uploaded ${last24h} books in the last 24 hours, the most one wallet may. Try again tomorrow.`,
    };
  }
  return { ...base, ok: true };
}

/**
 * Whether the shared 24-hour storage budget can also pay this fee.
 * @param {string|bigint} rewardWinston  0 asks "is there any room at all?"
 */
async function checkStorageBudget(rewardWinston, { now = Date.now() } = {}) {
  const { dailyBudgetWinston } = uploadLimits();
  const spentWinston = await storageSpentWinston(now);
  return {
    ok: spentWinston + BigInt(rewardWinston) <= dailyBudgetWinston && spentWinston < dailyBudgetWinston,
    spentWinston,
    budgetWinston: dailyBudgetWinston,
  };
}

const BUDGET_MESSAGE =
  "Today's storage budget is used up, so uploads are paused until earlier uploads are more than 24 hours old. " +
  'Nothing was stored or paid. Please try again later.';

/**
 * Everything the upload page shows before the archivist picks a file.
 * @param {string} address
 */
async function quotaFor(address, { now = Date.now() } = {}) {
  const [wallet, budget] = await Promise.all([checkWalletQuota(address, { now }), checkStorageBudget(0n, { now })]);
  const percentUsed =
    budget.budgetWinston > 0n ? Number((budget.spentWinston * 1000n) / budget.budgetWinston) / 10 : 100;

  let reason = null;
  let message = null;
  if (!wallet.ok) ({ reason, message } = wallet);
  else if (!budget.ok) [reason, message] = ['upload_budget_exhausted', BUDGET_MESSAGE];

  return {
    address: address.toLowerCase(),
    canUpload: wallet.ok && budget.ok,
    reason,
    message,
    awaitingStake: {
      count: wallet.awaiting.length,
      max: wallet.limits.maxAwaitingStake,
      books: wallet.awaiting,
    },
    last24h: { count: wallet.last24h, max: wallet.limits.maxPerWalletPerDay },
    budget: {
      usedAr: winstonToAr(budget.spentWinston),
      limitAr: winstonToAr(budget.budgetWinston),
      percentUsed: Math.min(100, percentUsed),
      exhausted: !budget.ok,
    },
  };
}

module.exports = {
  AWAITING_STAKE_STATUSES,
  BUDGET_MESSAGE,
  uploadLimits,
  checkWalletQuota,
  checkStorageBudget,
  quotaFor,
};
