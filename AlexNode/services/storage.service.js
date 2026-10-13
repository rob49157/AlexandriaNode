// Storage worker — takes an upload from "header posted" to "stored and verified".
//
// POST /api/upload answers 202 with the row at pending_confirmation, the signed
// header saved in Upload.arweaveUploaderState and the ciphertext in the spool.
// From there this worker owns the row (ARWEAVE-DIRECT-PLAN.md §3, §4.5):
//
//   not mined, anchor still live   re-post the same signed header (same id)
//   not mined, anchor expired      storage_failed: free the sha256, drop the spool
//   mined                          push chunks to ARWEAVE_MIN_HOLDERS nodes (D9)
//   mined, >= N confirmations      verify each holder byte for byte, then
//                                  pending_stake → registerUpload → pending
//
// After pending_stake it keeps watching replication for a while and alerts if
// verified copies fall below the minimum; that never blocks staking (D9).
//
// Every decision is re-derived from Postgres + the spool + the network on each
// pass, so a restart at any point resumes. Single-instance: two backends running
// this worker would push the same chunks twice (harmless, idempotent) and could
// race the final status update (guarded by `status` in the WHERE clause).

const prisma = require('../config/db');
const cfg = require('../config/arweave');
const arweave = require('../controller/arweave');
const spool = require('./spool.service');
const { registerOnChain } = require('./registration.service');

const ANCHOR_DEPTH = 50; // STORE_BLOCKS_BEHIND_CURRENT [D8][D9]
// Blocks past the deadline before declaring a drop: the node asked may lag the
// tip by up to 2 (MAX_PEER_LAG), and a tx mined in the last valid block takes a
// moment to show in /status. Late is safe; early would fail a live upload.
const DROP_MARGIN = 3;
// Past the deadline, a node that still answers 2xx to a re-post has a stale view:
// the protocol rejects any tx whose anchor is not among the last 50 blocks [D2].
// It is humored for this many more blocks (~20 min), then the upload fails anyway.
// Without this bound, one such node kept a row pending forever (sha256 locked,
// spool never deleted).
const EXPIRY_GRACE_BLOCKS = 10;
const REPOST_EVERY_BLOCKS = 5;
const VERIFY_MISSES_ALLOWED = 3; // consecutive "not readable yet" answers before a holder is replaced
// Chunk pushes running at once; a 150 MiB push can take an hour (Q5). Only the
// push is limited: status checks, re-posts and deadlines run for every row on
// every pass, or two long pushes would starve them (an upload that a re-post
// would have saved could run out its anchor window).
const MAX_PARALLEL_PUSH = 2;
const BATCH = 20;
const REPLICATION_WATCH_DAYS = 7;
const REPLICATION_CHECK_EVERY_MS = 6 * 60 * 60_000;
const REPLICATION_PASS_EVERY_MS = 30 * 60_000;
// Rows checked per pass, least recently checked first. At 10 per 30 min, up to
// ~120 books in the 7-day window are each re-checked every 6 h; beyond that they
// are checked less often, but none is starved.
const REPLICATION_PER_PASS = 10;
const REPLICATION_SCAN_LIMIT = 1000;
// Registration retries for stored-but-unregistered rows: 1 min, doubling, capped
// at 1 h. A gas shortage or an RPC blip then clears itself without POST /register.
const REGISTRATION_RETRY_BASE_MS = 60_000;
const REGISTRATION_RETRY_MAX_MS = 60 * 60_000;
const REGISTRATIONS_PER_TICK = 5;

const worker = {
  enabled: false,
  timer: null,
  intervalMs: Number(process.env.STORAGE_WORKER_INTERVAL_MS) || 30_000,
  inFlight: new Set(), // rows with a processUpload() pass running
  pushing: new Set(), // rows currently pushing chunks (≤ MAX_PARALLEL_PUSH)
  registering: new Set(), // rows with a registerOnChain() call running
  // Per-row registration backoff, in memory: after a restart every row gets one
  // immediate retry, which is harmless (registerOnChain is idempotent). Kept out
  // of the row on purpose: storageError is for storage, and arweaveUploaderState
  // is also written by monitorReplication.
  registrationRetry: new Map(), // arweaveHash -> { attempts, nextAt, lastReason, done }
  lastTickAt: null,
  lastError: null,
  lastReplicationPassAt: 0,
  ticking: false,
};

const ROW_SELECT = {
  arweaveHash: true,
  uploader: true,
  title: true,
  author: true,
  category: true,
  sha256Hash: true,
  status: true,
  arweaveAnchorHeight: true,
  arweaveUploaderState: true,
  storageAttempts: true,
};

async function save(arweaveHash, data) {
  await prisma.upload.update({ where: { arweaveHash }, data });
}

/**
 * Terminal: the header can never be mined (or the data can never be sent).
 * The sha256 is moved aside so the archivist's re-upload is not rejected as a
 * duplicate of a book that was never stored (plan §4.4).
 */
async function failUpload(row, reason, message) {
  const freedSha = `failed:${row.sha256Hash}:${Date.now()}`;
  const { count } = await prisma.upload.updateMany({
    where: { arweaveHash: row.arweaveHash, status: 'pending_confirmation' },
    data: { status: 'storage_failed', storageError: `${reason}: ${message}`, sha256Hash: freedSha },
  });
  if (count) await spool.remove(row.arweaveHash).catch(() => {});
  console.error(`[storage] ${row.arweaveHash} → storage_failed (${reason}): ${message}`);
}

/**
 * One pass over one upload. Returns what it did, for logs and tests.
 * @returns {Promise<string>}
 */
async function processUpload(row) {
  const hash = row.arweaveHash;
  const state = row.arweaveUploaderState || {};
  if (!state.header) {
    await failUpload(row, 'no_header', 'the row has no signed header to post');
    return 'failed';
  }
  state.holders = state.holders || {};

  let status = await arweave.getTxStatus(hash);

  // ── Not mined yet ─────────────────────────────────────────────────────────
  if (status.state !== 'mined') {
    const tip = await arweave.getTipHeight();
    const deadline = row.arweaveAnchorHeight + ANCHOR_DEPTH + DROP_MARGIN;
    if (tip > deadline) {
      // One last look: re-post the header, then re-read the status. Mined after
      // all → carry on with THIS status (the old code fell back to the stale one,
      // recorded 0 confirmations and started chunks a pass late).
      const post = await arweave.postHeader(state.header);
      const recheck = await arweave.getTxStatus(hash);
      if (recheck.state === 'mined') {
        status = recheck;
      } else {
        // "Invalid anchor" is positive proof the tx can never be mined (fixture).
        // A 2xx is NOT proof it is alive: past the deadline the protocol rejects
        // it, so a node accepting it has a stale view. It is humored only until
        // EXPIRY_GRACE_BLOCKS more have passed.
        const expiredBy = post.results.filter(arweave.isExpiredAnchorAnswer).map((r) => r.node);
        const pastGrace = tip > deadline + EXPIRY_GRACE_BLOCKS;
        if (expiredBy.length || !post.accepted.length || pastGrace) {
          const why = expiredBy.length
            ? `${expiredBy.length} node(s) answered "Invalid anchor"`
            : !post.accepted.length
              ? 'no node accepted a re-post'
              : `still unmined ${EXPIRY_GRACE_BLOCKS} blocks past the deadline although ${post.accepted.length} node(s) accepted a re-post`;
          await failUpload(row, 'header_not_mined', `not mined by height ${tip} (anchor ${row.arweaveAnchorHeight} + ${ANCHOR_DEPTH}); ${why}`);
          return 'failed';
        }
        await save(hash, { arweaveConfirmations: 0 });
        return 'waiting';
      }
    } else {
      // Not even in a mempool: re-send the same signed header every few blocks.
      if (status.state === 'not_found' && tip >= (state.lastHeaderPostHeight || row.arweaveAnchorHeight) + REPOST_EVERY_BLOCKS) {
        const post = await arweave.postHeader(state.header);
        state.lastHeaderPostHeight = tip;
        state.headerReposts = (state.headerReposts || 0) + 1;
        await save(hash, { arweaveUploaderState: state, arweaveConfirmations: 0 });
        return post.accepted.length ? 'header_reposted' : 'header_repost_refused';
      }
      await save(hash, { arweaveConfirmations: 0 });
      return 'waiting';
    }
  }

  // ── Mined: send the data to MIN_HOLDERS independent long-term nodes ────────
  await save(hash, { arweaveBlockHeight: status.blockHeight, arweaveConfirmations: status.confirmations });

  const doneCount = () => Object.values(state.holders).filter((h) => h.done).length;
  const haveSpool = await spool.exists(hash);
  if (!haveSpool && doneCount() < cfg.ARWEAVE_MIN_HOLDERS) {
    // The header is mined (paid) but the bytes to send are gone. Only a holder
    // that already has everything can save it; otherwise it is lost for good.
    console.error(`[storage] [LOST] ${hash}: mined and paid, but the spool is missing with ${doneCount()} complete copies.`);
    await failUpload(row, 'spool_missing', 'mined, but the ciphertext spool is gone; upload the file again');
    return 'failed';
  }
  // Read lazily: a 150 MiB spool is read only on a pass that pushes or verifies,
  // not on each of the ~60 passes spent waiting for confirmations.
  let data = null;

  if (doneCount() < cfg.ARWEAVE_MIN_HOLDERS) {
    if (worker.pushing.size >= MAX_PARALLEL_PUSH) return 'push_queued';
    worker.pushing.add(hash);
    try {
      data = await spool.read(hash);
      await arweave.pushChunks({
        header: state.header,
        data,
        state,
        minHolders: cfg.ARWEAVE_MIN_HOLDERS,
        onState: (s) => save(hash, { arweaveUploaderState: s }),
      });
    } catch (err) {
      await save(hash, { arweaveUploaderState: state });
      if (err.code === 'chunk_fatal' || err.code === 'spool_mismatch') {
        await failUpload(row, err.code, err.message);
        return 'failed';
      }
      throw err; // no_long_term_nodes / network: retried next pass
    } finally {
      worker.pushing.delete(hash);
    }
  }

  // ── Final: enough confirmations AND verified copies (D2 + D9) ──────────────
  if (status.confirmations < cfg.ARWEAVE_CONFIRMATIONS) return 'confirming';

  if (!data && haveSpool) data = await spool.read(hash);
  const holders = Object.entries(state.holders).filter(([, h]) => h.done).map(([n]) => n);
  const check = await arweave.verifyHolders({ txId: hash, header: state.header, nodes: holders, data });
  for (const node of check.verified) state.holders[node].verifyMisses = 0;
  if (check.verified.length < cfg.ARWEAVE_MIN_HOLDERS) {
    // A holder that cannot serve it back is not a copy. Wrong bytes or a bad
    // proof drop it at once; "not readable yet" (no_offset, 404, timeout) is what
    // a holder can answer for a while after mining (live, 2026-10-13), so it is
    // dropped only after VERIFY_MISSES_ALLOWED misses in a row. A dropped holder
    // is replaced by a new node on the next pass.
    for (const [node, why] of Object.entries(check.failures)) {
      const h = state.holders[node];
      h.verifyMisses = (h.verifyMisses || 0) + 1;
      if (arweave.isDefinitiveVerifyFailure(why) || h.verifyMisses >= VERIFY_MISSES_ALLOWED) {
        state.holders[node] = { ...h, done: false, failed: `verify: ${why}` };
      }
    }
    await save(hash, { arweaveUploaderState: state });
    return 'verify_failed';
  }

  state.verified = { at: new Date().toISOString(), nodes: check.verified };
  const { count } = await prisma.upload.updateMany({
    where: { arweaveHash: hash, status: 'pending_confirmation' },
    data: {
      status: 'pending_stake',
      arweaveUploaderState: state,
      arweaveConfirmations: status.confirmations,
      storageError: null,
    },
  });
  if (!count) return 'raced';
  await spool.remove(hash).catch(() => {});
  console.log(`[storage] ${hash} stored: ${status.confirmations} confirmations, verified on ${check.verified.join(', ')}`);

  // Registration was inline in the request before; it moved here so nobody can
  // stake on bytes that are not stored yet. Non-fatal: on failure the row stays
  // pending_stake and retryRegistrations() tries again with backoff (POST
  // /api/upload/:hash/register still works too).
  await registerStored(row);
  return 'stored';
}

/**
 * Register a stored row on-chain. Never throws: a registration problem is not a
 * storage problem, so it must not reach tick()'s error handler, which would
 * write storageError onto a book that is fully stored.
 * @returns {Promise<'registered'|'registration_failed'|'in_progress'>}
 */
async function registerStored(row) {
  const hash = row.arweaveHash;
  if (worker.registering.has(hash)) return 'in_progress';
  worker.registering.add(hash);
  try {
    let registration;
    try {
      registration = await registerOnChain(hash, row.uploader, row);
    } catch (err) {
      // preflight() and uploadExists() are RPC reads and can throw.
      registration = { registered: false, reason: 'error', message: err.message };
    }
    if (registration.registered) {
      if (registration.txHash) {
        await prisma.upload.updateMany({
          where: { arweaveHash: hash, status: 'pending_stake' },
          data: { status: 'pending', onChainTxHash: registration.txHash },
        });
        worker.registrationRetry.delete(hash);
      } else {
        // already_registered: on-chain, but not by this call, so there is no tx
        // hash to record. The event listener moves the row to pending when it
        // sees UploadRegistered; stop retrying it here.
        worker.registrationRetry.set(hash, { done: true });
      }
      return 'registered';
    }
    const prev = worker.registrationRetry.get(hash) || { attempts: 0 };
    const attempts = prev.attempts + 1;
    const delay = Math.min(REGISTRATION_RETRY_BASE_MS * 2 ** (attempts - 1), REGISTRATION_RETRY_MAX_MS);
    worker.registrationRetry.set(hash, { attempts, nextAt: Date.now() + delay, lastReason: registration.reason });
    console.warn(
      `[storage] ${hash} stored but not registered (${registration.reason}: ${registration.message}); ` +
        `retry ${attempts} in ${Math.round(delay / 1000)}s`
    );
    return 'registration_failed';
  } finally {
    worker.registering.delete(hash);
  }
}

/**
 * Stored on the direct path but not registered: retry those whose backoff has
 * elapsed. Without this, registration ran exactly once and a short gas shortage
 * left the book unregistered (and unstakeable) until someone called
 * POST /register by hand.
 */
async function retryRegistrations() {
  const rows = await prisma.upload.findMany({
    where: { status: 'pending_stake', storageProvider: 'arweave-l1', onChainTxHash: null },
    orderBy: { uploadTimestamp: 'asc' },
    take: BATCH,
    select: { arweaveHash: true, uploader: true, title: true, author: true, category: true },
  });
  let attempted = 0;
  for (const row of rows) {
    if (attempted >= REGISTRATIONS_PER_TICK) break;
    const retry = worker.registrationRetry.get(row.arweaveHash);
    if (retry && (retry.done || Date.now() < retry.nextAt)) continue;
    attempted++;
    await registerStored(row);
  }
}

/**
 * After pending_stake: re-check the verified holders now and then for a week.
 * Proof-checked reads (no spool by then). Alerts, never blocks (D9).
 */
async function monitorReplication() {
  if (Date.now() - worker.lastReplicationPassAt < REPLICATION_PASS_EVERY_MS) return;
  worker.lastReplicationPassAt = Date.now();
  const since = new Date(Date.now() - REPLICATION_WATCH_DAYS * 24 * 60 * 60_000);
  // The whole window, then the least recently checked first (never-checked rows
  // lead). The old query took 50 rows in no order and checked one per pass, so
  // most books in the window were checked rarely or never.
  const rows = await prisma.upload.findMany({
    where: {
      storageProvider: 'arweave-l1',
      uploadTimestamp: { gte: since },
      NOT: { status: { in: ['pending_confirmation', 'storage_failed'] } },
    },
    select: { arweaveHash: true, arweaveUploaderState: true },
    orderBy: { uploadTimestamp: 'asc' },
    take: REPLICATION_SCAN_LIMIT,
  });
  const due = rows
    .map((row) => {
      const state = row.arweaveUploaderState || {};
      const last = (state.replication && Date.parse(state.replication.checkedAt)) || 0;
      const nodes = [...new Set((state.verified && state.verified.nodes) || [])];
      return { row, state, last, nodes };
    })
    .filter((x) => x.state.header && x.nodes.length && Date.now() - x.last >= REPLICATION_CHECK_EVERY_MS)
    .sort((a, b) => a.last - b.last)
    .slice(0, REPLICATION_PER_PASS);
  for (const { row, state, nodes } of due) {
    const check = await arweave.verifyHolders({ txId: row.arweaveHash, header: state.header, nodes });
    state.replication = { checkedAt: new Date().toISOString(), verified: check.verified, failures: check.failures };
    await save(row.arweaveHash, { arweaveUploaderState: state });
    if (check.verified.length < cfg.ARWEAVE_MIN_HOLDERS) {
      console.error(
        `[storage] [REPLICATION] ${row.arweaveHash}: only ${check.verified.length} of ${cfg.ARWEAVE_MIN_HOLDERS} ` +
          `verified copies (${JSON.stringify(check.failures)})`
      );
    }
  }
}

async function tick() {
  if (worker.ticking) return;
  worker.ticking = true;
  worker.lastTickAt = new Date();
  try {
    const rows = await prisma.upload.findMany({
      where: { status: 'pending_confirmation', storageProvider: 'arweave-l1' },
      orderBy: { uploadTimestamp: 'asc' },
      take: BATCH,
      select: ROW_SELECT,
    });
    // Every row gets a pass; only chunk pushing is capped (MAX_PARALLEL_PUSH,
    // inside processUpload). A row whose previous pass is still running (a long
    // push) is skipped, never started twice.
    for (const row of rows) {
      if (worker.inFlight.has(row.arweaveHash)) continue;
      worker.inFlight.add(row.arweaveHash);
      processUpload(row)
        .then(async (outcome) => {
          // A clean in-progress pass clears an old transient error. Never after
          // 'failed' (that wrote the terminal reason) or 'verify_failed'.
          if (['waiting', 'confirming', 'header_reposted', 'push_queued'].includes(outcome)) {
            await save(row.arweaveHash, { storageError: null }).catch(() => {});
          }
        })
        .catch(async (err) => {
          worker.lastError = { at: new Date().toISOString(), arweaveHash: row.arweaveHash, message: err.message };
          console.warn(`[storage] ${row.arweaveHash}: ${err.code || 'error'}: ${err.message} (will retry)`);
          await save(row.arweaveHash, {
            storageError: `${err.code || 'error'}: ${err.message}`.slice(0, 500),
            storageAttempts: { increment: 1 },
          }).catch(() => {});
        })
        .finally(() => worker.inFlight.delete(row.arweaveHash));
    }
    await retryRegistrations().catch((err) => console.warn(`[storage] registration retry: ${err.message}`));
    await monitorReplication().catch((err) => console.warn(`[storage] replication check: ${err.message}`));
  } catch (err) {
    worker.lastError = { at: new Date().toISOString(), message: err.message };
    console.warn(`[storage] tick failed: ${err.message}`);
  } finally {
    worker.ticking = false;
  }
}

function start() {
  if (worker.timer) return;
  worker.enabled = true;
  worker.timer = setInterval(tick, worker.intervalMs);
  if (worker.timer.unref) worker.timer.unref();
  tick();
  console.log(`[storage] worker started (every ${worker.intervalMs / 1000}s, ${cfg.ARWEAVE_CONFIRMATIONS} confirmations, ${cfg.ARWEAVE_MIN_HOLDERS} copies)`);
}

function stop() {
  if (worker.timer) clearInterval(worker.timer);
  worker.timer = null;
  worker.enabled = false;
}

function health() {
  return {
    running: Boolean(worker.timer),
    intervalMs: worker.intervalMs,
    lastTickAt: worker.lastTickAt,
    lastError: worker.lastError,
    inFlight: [...worker.inFlight],
    pushing: [...worker.pushing],
    registrationRetries: [...worker.registrationRetry.entries()]
      .filter(([, r]) => !r.done)
      .map(([arweaveHash, r]) => ({ arweaveHash, attempts: r.attempts, lastReason: r.lastReason, nextAt: new Date(r.nextAt) })),
  };
}

module.exports = {
  start,
  stop,
  tick,
  processUpload,
  registerStored,
  retryRegistrations,
  monitorReplication,
  health,
  ANCHOR_DEPTH,
  DROP_MARGIN,
  EXPIRY_GRACE_BLOCKS,
  MAX_PARALLEL_PUSH,
  // Test hook: the in-memory state the worker keeps between passes.
  _state: worker,
};
