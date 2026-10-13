// Storage worker: pending_confirmation → chunks on 2 independent long-term nodes
// → 16 confirmations → verified copies → pending_stake → registered
// (ARWEAVE-DIRECT-PLAN.md §3, §4.5, decisions D1, D2, D9).
//
// Run: node tests/storageWorker.test.js   (Node >= 22)
//
// The real controller/arweave.js, config/arweave.js and spool run against
// tests/helpers/fakeArweaveNetwork.js (responses copied from mainnet, Phase 0),
// with a real wallet and real signed transactions. Postgres and on-chain
// registration are stubbed.

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Arweave = require('arweave');
const { createFakeArweave } = require('./helpers/fakeArweaveNetwork');

let passed = 0;
let failed = 0;
function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ ${testName}`);
    failed++;
  }
}
function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, path: path.dirname(resolved), loaded: true, children: [], paths: [], exports };
  return exports;
}

// Five nodes; A and A2 share a /24 (one operator, as far as we can tell).
const A = 'http://10.1.1.1:1984';
const A2 = 'http://10.1.1.2:1984';
const B = 'http://10.2.1.1:1984';
const C = 'http://10.3.1.1:1984';
const D = 'http://10.4.1.1:1984';
const NODES = [A, A2, B, C, D];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-worker-'));
const SPOOL = path.join(tmp, 'spool');
const ARCHIVIST = '0x1234567890abcdef1234567890abcdef12345678';

(async () => {
  const jwk = await Arweave.init({}).wallets.generate();
  const address = await Arweave.init({}).wallets.jwkToAddress(jwk);
  fs.writeFileSync(path.join(tmp, 'wallet.json'), JSON.stringify(jwk));
  Object.assign(process.env, {
    ARWEAVE_WALLET_FILE: path.join(tmp, 'wallet.json'),
    ARWEAVE_WALLET_ADDRESS: address,
    ARWEAVE_NODE_URLS: NODES.join(','),
    ARWEAVE_SPOOL_DIR: SPOOL,
    ARWEAVE_PEER_CACHE_FILE: path.join(tmp, 'peers.json'),
    ARWEAVE_CONFIRMATIONS: '16',
    ARWEAVE_MIN_HOLDERS: '2',
  });
  delete process.env.ARWEAVE_PEER_SEEDS;

  const net = createFakeArweave({ nodeUrls: NODES });
  global.fetch = net.fetch;

  // --- Fake Postgres ---------------------------------------------------------
  const db = { rows: [] };
  const matchWhere = (r, where) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'NOT') return !matchWhere(r, v);
      if (v === null) return r[k] == null; // Postgres NULL: an unset column matches

      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      if (v && typeof v === 'object' && 'gte' in v) return r[k] >= v.gte;
      return r[k] === v;
    });
  const apply = (r, data) => {
    for (const [k, v] of Object.entries(data)) {
      r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] || 0) + v.increment : v;
    }
  };
  // JSON columns come back as fresh objects, as they do from Postgres.
  const clone = (r) => JSON.parse(JSON.stringify(r));
  stub('../config/db', {
    upload: {
      findMany: async ({ where }) => db.rows.filter((r) => matchWhere(r, where)).map(clone),
      findUnique: async ({ where }) => {
        const r = db.rows.find((x) => matchWhere(x, where));
        return r ? clone(r) : null;
      },
      update: async ({ where, data }) => {
        const r = db.rows.find((x) => matchWhere(x, where));
        if (!r) throw new Error('not found');
        apply(r, JSON.parse(JSON.stringify(data)));
        return r;
      },
      updateMany: async ({ where, data }) => {
        const rows = db.rows.filter((r) => matchWhere(r, where));
        rows.forEach((r) => apply(r, JSON.parse(JSON.stringify(data))));
        return { count: rows.length };
      },
    },
  });

  const registration = { calls: [], result: null, throws: null };
  stub('../services/registration.service', {
    registerOnChain: async (hash, uploader, meta) => {
      registration.calls.push({ hash, uploader, meta });
      if (registration.throws) throw registration.throws; // e.g. an RPC read failing in preflight
      return registration.result || { registered: true, txHash: `0x${'d'.repeat(64)}` };
    },
    preflight: async () => ({ ready: true }),
  });

  const cfg = require('../config/arweave');
  const arweave = require('../controller/arweave');
  const spool = require('../services/spool.service');
  const worker = require('../services/storage.service');

  // --- Helpers ---------------------------------------------------------------
  function reset() {
    db.rows = [];
    registration.calls = [];
    registration.result = null;
    registration.throws = null;
    net.calls = [];
    for (const n of net.nodes.values()) Object.assign(n, { up: true, chunkMode: 200, postTxMode: 200, postTxLag: 0, dropChunks: false, tamperChunks: false });
    worker._state.registrationRetry.clear();
    worker._state.lastReplicationPassAt = 0;
    cfg._reset();
  }
  const quiet = async (fn) => {
    const e = console.error, w = console.warn, l = console.log;
    console.error = console.warn = console.log = () => {};
    try {
      return await fn();
    } finally {
      console.error = e;
      console.warn = w;
      console.log = l;
    }
  };

  /** What POST /api/upload leaves behind: a signed, posted header, a row, a spool. */
  async function seedUpload(bytes = 700 * 1024, { post = true } = {}) {
    const data = crypto.randomBytes(bytes);
    const prepared = await arweave.prepareUpload(data, [{ name: 'App-Name', value: 'Alexandria' }]);
    await spool.write(prepared.arweaveHash, data);
    const sha = crypto.randomBytes(32).toString('hex');
    db.rows.push({
      arweaveHash: prepared.arweaveHash,
      uploader: ARCHIVIST,
      title: 'T',
      author: 'A',
      category: 'science',
      sha256Hash: sha,
      status: 'pending_confirmation',
      storageProvider: 'arweave-l1',
      arweaveAnchorHeight: prepared.anchorHeight,
      arweaveReward: prepared.reward,
      arweaveUploaderState: { v: 1, header: prepared.header, holders: {} },
      storageAttempts: 0,
      uploadTimestamp: new Date(),
    });
    if (post) await arweave.postHeader(prepared.header);
    return { hash: prepared.arweaveHash, data, sha };
  }
  const rowOf = (hash) => db.rows.find((r) => r.arweaveHash === hash);
  const pass = (hash) => worker.processUpload(clone(rowOf(hash)));
  const chunkPostsTo = (node) => net.calls.filter((c) => c.node === node && c.method === 'POST' && c.path === '/chunk').length;

  // ── Not mined yet ──────────────────────────────────────────────────────────
  console.log('\n=== Waiting for the header to be mined ===\n');
  reset();
  let u = await seedUpload();
  assert((await pass(u.hash)) === 'waiting', 'Pending in the mempool → waiting');
  assert(rowOf(u.hash).status === 'pending_confirmation' && rowOf(u.hash).arweaveConfirmations === 0, 'Row stays pending_confirmation with 0 confirmations');
  assert(chunkPostsTo(A) + chunkPostsTo(B) === 0, 'No chunks are sent before the header is mined');

  // ── Header lost: re-post the same signed header ───────────────────────────
  console.log('\n=== Re-posting a header nobody has ===\n');
  reset();
  u = await seedUpload(64 * 1024, { post: false }); // as if every post was lost
  assert((await pass(u.hash)) === 'waiting', 'Not found, but fewer than 5 blocks since signing → waiting');
  net.advance(5);
  assert((await pass(u.hash)) === 'header_reposted', 'Not found after 5 blocks → the same signed header is re-posted');
  assert(net.txs.has(u.hash), 'The network now has the header, under the SAME id (the Lit seal stays valid)');
  assert(rowOf(u.hash).arweaveUploaderState.headerReposts === 1, 'The re-post is recorded in the saved state');

  // ── Never mined: storage_failed after the 50-block anchor window (D1) ─────
  console.log('\n=== Never mined → storage_failed ===\n');
  reset();
  u = await seedUpload(64 * 1024, { post: false });
  net.advance(50 + worker.DROP_MARGIN); // exactly at the deadline: still waits
  for (const n of net.nodes.values()) n.postTxMode = 500;
  assert((await quiet(() => pass(u.hash))) !== 'failed', 'At the deadline itself it does not give up yet (errs late)');
  net.advance(1);
  for (const n of net.nodes.values()) n.postTxMode = 200; // nodes up, but the anchor is now expired
  assert((await quiet(() => pass(u.hash))) === 'failed', 'Past anchor + 50 + margin, and nodes answer "Invalid anchor" → failed');
  const failedRow = rowOf(u.hash);
  assert(failedRow.status === 'storage_failed' && /header_not_mined/.test(failedRow.storageError), 'Row → storage_failed with reason header_not_mined');
  assert(failedRow.sha256Hash.startsWith(`failed:${u.sha}:`), 'sha256 is moved aside so the archivist can upload the same file again');
  assert(!(await spool.exists(u.hash)), 'The spool is deleted');
  assert(registration.calls.length === 0, 'Nothing is registered');

  // ── Mined: copies to 2 independent long-term nodes (D9, Q12) ──────────────
  console.log('\n=== Mined → chunks to 2 independent long-term nodes ===\n');
  reset();
  net.nodes.get(A).chunkMode = 303; // accepted but not kept long term (Q12)
  u = await seedUpload(700 * 1024); // 3 chunks
  net.mine(u.hash);
  net.advance(3);
  assert((await pass(u.hash)) === 'confirming', 'Mined with 4 confirmations → chunks sent, now confirming');
  let st = rowOf(u.hash).arweaveUploaderState;
  let done = Object.entries(st.holders).filter(([, h]) => h.done).map(([n]) => n);
  assert(done.length === 2, `Exactly 2 complete copies (got ${done.length}: ${done.join(', ')})`);
  assert(!done.includes(A), 'The node answering 303 is never used as a copy');
  assert(new Set(done.map(arweave.blockOf)).size === 2, 'The 2 copies are in different /24 blocks');
  assert(rowOf(u.hash).arweaveBlockHeight === net.txs.get(u.hash).minedAt, 'Mined block height is recorded');
  assert(rowOf(u.hash).status === 'pending_confirmation', 'Still pending_confirmation below 16 confirmations');

  console.log('\n=== 16 confirmations → verified → pending_stake → registered ===\n');
  net.advance(12); // 16 confirmations
  assert((await quiet(() => pass(u.hash))) === 'stored', 'At 16 confirmations with 2 verified copies → stored');
  const stored = rowOf(u.hash);
  assert(stored.status === 'pending' && stored.onChainTxHash === `0x${'d'.repeat(64)}`, 'Registered on-chain → pending, with the registration tx hash');
  assert(registration.calls.length === 1 && registration.calls[0].uploader === ARCHIVIST, 'registerUpload called once, with the ARCHIVIST as uploader');
  assert(stored.arweaveUploaderState.verified.nodes.length === 2, 'Both copies are recorded as verified');
  assert(!(await spool.exists(u.hash)), 'The spool is deleted once storage is verified');

  console.log('\n=== Reading the book back (no gateway) ===\n');
  const back = await arweave.fetchEncrypted(u.hash);
  assert(back.equals(u.data), 'fetchEncrypted returns the exact bytes, read chunk by chunk from raw nodes');
  for (const n of done) net.nodes.get(n).tamperChunks = n === done[0];
  const back2 = await arweave.fetchEncrypted(u.hash);
  assert(back2.equals(u.data), 'A node serving altered bytes is rejected by the proof check; the other copy is used');
  for (const n of net.nodes.values()) n.tamperChunks = false;

  // ── Registration failure is not a storage failure ─────────────────────────
  console.log('\n=== Registration failure after storage ===\n');
  reset();
  registration.result = { registered: false, reason: 'not_authorized', message: 'x' };
  u = await seedUpload(100 * 1024);
  net.mine(u.hash);
  net.advance(15);
  await quiet(() => pass(u.hash));
  assert(rowOf(u.hash).status === 'pending_stake', 'Stored but unregistered → pending_stake (retryable via POST /register)');

  // ── Verification failure: a copy that cannot be read back is not a copy ───
  console.log('\n=== A holder that loses the data is replaced ===\n');
  reset();
  u = await seedUpload(700 * 1024);
  net.mine(u.hash);
  net.advance(15);
  // First pass: push the copies but make one fail verification.
  const origFetch = global.fetch;
  let lossyNode = null;
  global.fetch = async (url, opts) => {
    if (lossyNode && url.startsWith(lossyNode) && /\/chunk\/\d+$/.test(url)) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    }
    return origFetch(url, opts);
  };
  // Pick the node that will be chosen first by letting it be chosen, then breaking it.
  const firstPass = await quiet(async () => {
    const state = clone(rowOf(u.hash)).arweaveUploaderState;
    await arweave.pushChunks({ header: state.header, data: u.data, state, minHolders: 2 });
    rowOf(u.hash).arweaveUploaderState = state;
    lossyNode = Object.keys(state.holders).find((n) => state.holders[n].done);
    return pass(u.hash);
  });
  assert(firstPass === 'verify_failed', 'A copy that answers 404 on read-back fails verification');
  st = rowOf(u.hash).arweaveUploaderState;
  assert(st.holders[lossyNode].done && !st.holders[lossyNode].failed && st.holders[lossyNode].verifyMisses === 1, 'One 404 is "not readable yet": the holder is kept, with 1 miss counted');
  assert(rowOf(u.hash).status === 'pending_confirmation', 'The book is NOT marked stored');
  assert((await quiet(() => pass(u.hash))) === 'verify_failed', 'A second miss: still not stored');
  assert((await quiet(() => pass(u.hash))) === 'verify_failed', 'A third miss in a row: holder dropped');
  st = rowOf(u.hash).arweaveUploaderState;
  assert(/^verify:/.test(st.holders[lossyNode].failed) && !st.holders[lossyNode].done, 'After 3 misses the node is marked failed, not counted as a copy');
  assert((await quiet(() => pass(u.hash))) === 'stored', 'The next pass copies to a new node, verifies 2, and stores');
  const finalHolders = rowOf(u.hash).arweaveUploaderState.verified.nodes;
  assert(!finalHolders.includes(lossyNode), 'The failed node is not among the verified copies');
  global.fetch = origFetch;

  console.log('\n=== A holder serving wrong bytes is dropped at once ===\n');
  reset();
  u = await seedUpload(300 * 1024);
  net.mine(u.hash);
  net.advance(15);
  await quiet(async () => {
    const s = clone(rowOf(u.hash)).arweaveUploaderState;
    await arweave.pushChunks({ header: s.header, data: u.data, state: s, minHolders: 2 });
    rowOf(u.hash).arweaveUploaderState = s;
  });
  const badNode = Object.keys(rowOf(u.hash).arweaveUploaderState.holders)[0];
  net.nodes.get(badNode).tamperChunks = true;
  assert((await quiet(() => pass(u.hash))) === 'verify_failed', 'Altered bytes fail verification');
  assert(/^verify:/.test(rowOf(u.hash).arweaveUploaderState.holders[badNode].failed), 'Wrong bytes are definitive: dropped on the first miss, no waiting');
  net.nodes.get(badNode).tamperChunks = false;

  console.log('\n=== Reading a fresh book that only its holders have ===\n');
  reset();
  u = await seedUpload(300 * 1024);
  net.mine(u.hash);
  const s2 = clone(rowOf(u.hash)).arweaveUploaderState;
  await quiet(() => arweave.pushChunks({ header: s2.header, data: u.data, state: s2, minHolders: 2 }));
  const holders2 = Object.keys(s2.holders);
  // Only the 2 holders have the chunks; the other 3 healthy nodes answer 404.
  const readBack = await arweave.fetchEncrypted(u.hash);
  assert(readBack.equals(u.data), 'Found without a hint by searching every healthy node');
  net.calls = [];
  const hinted = await arweave.fetchEncrypted(u.hash, { preferNodes: holders2 });
  const chunkReads = net.calls.filter((c) => /^\/chunk\/\d+$/.test(c.path)).length;
  assert(hinted.equals(u.data) && chunkReads === 2, `With the holders as a hint, each chunk is read once (${chunkReads} reads for 2 chunks)`);

  // ── Resume after a crash mid-upload ───────────────────────────────────────
  console.log('\n=== Resuming after a crash ===\n');
  reset();
  const TOTAL = 25; // > 10, so progress is saved mid-upload (every 10 chunks)
  u = await seedUpload(TOTAL * 256 * 1024);
  net.mine(u.hash);
  const state = clone(rowOf(u.hash)).arweaveUploaderState;
  // Crash at the FIRST progress save: the process dies mid-upload. What survives
  // is exactly what was saved, as with a real restart.
  let saves = 0;
  await arweave
    .pushChunks({
      header: state.header,
      data: u.data,
      state,
      minHolders: 2,
      onState: async (s) => {
        if (saves++ === 0) {
          rowOf(u.hash).arweaveUploaderState = clone(s);
          throw new Error('simulated crash');
        }
      },
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 500)); // let the orphaned parallel upload settle
  const saved = rowOf(u.hash).arweaveUploaderState.holders;
  const savedNext = Object.values(saved).map((h) => h.next);
  assert(savedNext.some((n) => n > 1 && n < TOTAL), `The crash happened mid-upload (saved progress: ${savedNext.join(', ')} of ${TOTAL})`);
  net.calls = [];
  await quiet(() => pass(u.hash));
  const posts = net.calls.filter((c) => c.method === 'POST' && c.path === '/chunk').length;
  const fromScratch = 2 * TOTAL;
  const expected = Object.values(saved).reduce((n, h) => n + (TOTAL - h.next), 0);
  const holdersAfter = rowOf(u.hash).arweaveUploaderState.holders;
  assert(Object.values(holdersAfter).filter((h) => h.done).length >= 2, 'After the crash, the next pass completes 2 copies');
  assert(posts === expected && posts < fromScratch, `Resumed from saved progress: ${posts} chunk posts (from scratch would be ${fromScratch})`);

  // ── Not enough long-term nodes: wait, don't fail ──────────────────────────
  console.log('\n=== Only one node keeps chunks ===\n');
  reset();
  for (const n of [A, A2, C, D]) net.nodes.get(n).chunkMode = 303;
  u = await seedUpload(64 * 1024);
  net.mine(u.hash);
  let err = null;
  try {
    await pass(u.hash);
  } catch (e) {
    err = e;
  }
  assert(err && err.code === 'no_long_term_nodes', 'One copy possible, two required → no_long_term_nodes (retryable)');
  assert(rowOf(u.hash).status === 'pending_confirmation', 'The row is not failed: it waits for another long-term node');
  assert(Object.values(rowOf(u.hash).arweaveUploaderState.holders).filter((h) => h.done).length === 1, 'The one good copy is kept in the saved state');

  // ── Fatal chunk error → storage_failed ────────────────────────────────────
  reset();
  for (const n of net.nodes.values()) n.chunkMode = 'fatal';
  u = await seedUpload(64 * 1024);
  net.mine(u.hash);
  assert((await quiet(() => pass(u.hash))) === 'failed' && rowOf(u.hash).status === 'storage_failed', 'An invalid_proof from nodes → storage_failed (it would repeat everywhere)');

  // ── Spool lost after mining ───────────────────────────────────────────────
  console.log('\n=== Spool lost after mining ===\n');
  reset();
  u = await seedUpload(64 * 1024);
  net.mine(u.hash);
  await spool.remove(u.hash);
  assert((await quiet(() => pass(u.hash))) === 'failed', 'Mined but the spool is gone with no copies → failed');
  assert(/spool_missing/.test(rowOf(u.hash).storageError), 'Reason names the missing spool');

  // ── tick(): errors are recorded, not fatal ────────────────────────────────
  console.log('\n=== tick() bookkeeping ===\n');
  reset();
  u = await seedUpload(64 * 1024);
  for (const n of net.nodes.values()) n.up = false;
  cfg._reset();
  await quiet(() => worker.tick());
  await new Promise((r) => setTimeout(r, 200));
  assert(rowOf(u.hash).storageAttempts === 1 && /arweave_unavailable/.test(rowOf(u.hash).storageError), 'A network outage increments storageAttempts and records the error');
  assert(rowOf(u.hash).status === 'pending_confirmation', 'An outage never fails an upload by itself');
  assert(worker.health().lastError && worker.health().lastError.arweaveHash === u.hash, 'health() reports the last error');

  // ── Review 2026-10-12 #1: a 2xx after the deadline is not "still alive" ───
  console.log('\n=== Past the deadline, a stale node answering OK cannot keep a row pending ===\n');
  reset();
  u = await seedUpload(64 * 1024, { post: false });
  net.advance(50 + worker.DROP_MARGIN + 1);
  net.nodes.get(A).postTxLag = 100; // A still thinks the anchor is live and says "OK"
  net.nodes.get(A2).postTxLag = 100;
  assert((await quiet(() => pass(u.hash))) === 'failed', 'One node says OK, another says "Invalid anchor" → the proof wins: failed');
  assert(/Invalid anchor/.test(rowOf(u.hash).storageError) && rowOf(u.hash).sha256Hash.startsWith('failed:'), 'Reason names the proof; sha256 freed for a re-upload');
  assert(!(await spool.exists(u.hash)), 'The spool is deleted');

  reset();
  u = await seedUpload(64 * 1024, { post: false });
  for (const n of net.nodes.values()) n.postTxLag = 100; // EVERY node answers OK, forever
  net.advance(50 + worker.DROP_MARGIN + 1);
  assert((await quiet(() => pass(u.hash))) === 'waiting', 'Every node accepts the re-post → waits (within the grace window)');
  net.advance(worker.EXPIRY_GRACE_BLOCKS);
  assert((await quiet(() => pass(u.hash))) === 'failed', `${worker.EXPIRY_GRACE_BLOCKS} blocks later, still unmined → failed even though nodes keep saying OK`);
  assert(/accepted a re-post/.test(rowOf(u.hash).storageError), 'Reason says it failed despite accepting nodes');

  // ── #9: mined between the status read and the re-check ────────────────────
  console.log('\n=== Mined after all, found by the re-check after the deadline ===\n');
  reset();
  u = await seedUpload(300 * 1024); // posted in time; the status nodes still say "Pending"
  net.advance(50 + worker.DROP_MARGIN + 1);
  const fetchBefore9 = global.fetch;
  // The first status read was stale: the tx was mined in-window, which the
  // network only reveals by the time the worker re-checks.
  global.fetch = async (url, opts) => {
    const res = await fetchBefore9(url, opts);
    if (opts && opts.method === 'POST' && url.endsWith('/tx') && net.txs.has(u.hash) && net.txs.get(u.hash).minedAt === undefined) {
      net.mine(u.hash, net.height - 10);
    }
    return res;
  };
  const out9 = await quiet(() => pass(u.hash));
  global.fetch = fetchBefore9;
  assert(out9 === 'confirming', `The re-check finds it mined → handled as mined in the SAME pass (got ${out9})`);
  assert(rowOf(u.hash).arweaveConfirmations === 11 && chunkPostsTo(A) + chunkPostsTo(A2) + chunkPostsTo(B) + chunkPostsTo(C) + chunkPostsTo(D) > 0, 'Real confirmation count recorded (not 0) and chunks sent without losing a pass');

  // ── #2: registration is retried, with backoff; never a storage error ──────
  console.log('\n=== Registration failure is retried by the worker ===\n');
  reset();
  registration.result = { registered: false, reason: 'insufficient_gas', message: 'no gas' };
  u = await seedUpload(100 * 1024);
  net.mine(u.hash);
  net.advance(15);
  assert((await quiet(() => pass(u.hash))) === 'stored' && rowOf(u.hash).status === 'pending_stake', 'Stored, registration failed → pending_stake');
  const retry = worker.health().registrationRetries.find((x) => x.arweaveHash === u.hash);
  assert(retry && retry.attempts === 1 && retry.lastReason === 'insufficient_gas', 'The failure is queued for retry, with its reason, in health()');
  await quiet(() => worker.retryRegistrations());
  assert(registration.calls.length === 1, 'Before the backoff elapses, no retry is sent');
  registration.result = null; // gas arrives
  worker._state.registrationRetry.get(u.hash).nextAt = Date.now() - 1;
  await quiet(() => worker.retryRegistrations());
  assert(registration.calls.length === 2 && rowOf(u.hash).status === 'pending' && rowOf(u.hash).onChainTxHash, 'After the backoff the worker retries by itself → pending, with the tx hash');
  assert(!rowOf(u.hash).storageError, 'No storageError was ever written for a registration problem');

  reset();
  registration.throws = new Error('RPC down');
  u = await seedUpload(100 * 1024);
  net.mine(u.hash);
  net.advance(15);
  const outThrow = await quiet(() => pass(u.hash)).catch((e) => `threw: ${e.message}`);
  assert(outThrow === 'stored', `registerOnChain throwing does not make the storage pass throw (got ${outThrow})`);
  assert(rowOf(u.hash).status === 'pending_stake' && !rowOf(u.hash).storageError && !rowOf(u.hash).storageAttempts, 'Stored row keeps no storageError / storageAttempts from a registration exception');
  assert((worker._state.registrationRetry.get(u.hash) || {}).lastReason === 'error', 'The exception is queued for retry like any other registration failure');

  reset();
  registration.result = { registered: true, reason: 'already_registered' }; // no tx hash
  u = await seedUpload(100 * 1024);
  net.mine(u.hash);
  net.advance(15);
  await quiet(() => pass(u.hash));
  await quiet(() => worker.retryRegistrations());
  assert(registration.calls.length === 1, 'Already registered (no tx hash) → not retried again; the event listener takes it from there');

  // ── #4: two long pushes do not starve the other rows ──────────────────────
  console.log('\n=== Two long chunk pushes do not block other rows ===\n');
  reset();
  const x = await seedUpload(300 * 1024);
  const y = await seedUpload(300 * 1024);
  const w = await seedUpload(300 * 1024);
  const z = await seedUpload(64 * 1024, { post: false });
  for (const h of [x.hash, y.hash, w.hash]) net.mine(h);
  net.advance(5); // z: not found 5 blocks after signing → due for a re-post
  // All three mined rows hang mid-push; which two win the slots is not specified.
  const hangRoots = new Set([x.hash, y.hash, w.hash].map((h) => rowOf(h).arweaveUploaderState.header.data_root));
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchBefore4 = global.fetch;
  global.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST' && url.endsWith('/chunk') && hangRoots.has(JSON.parse(opts.body).data_root)) await gate;
    return fetchBefore4(url, opts);
  };
  await quiet(async () => {
    await worker.tick();
    for (let i = 0; i < 50 && rowOf(z.hash).arweaveUploaderState.headerReposts !== 1; i++) await new Promise((r) => setTimeout(r, 20));
  });
  const minedRows = [x.hash, y.hash, w.hash];
  assert(worker._state.pushing.size === 2 && minedRows.filter((h) => worker._state.pushing.has(h)).length === 2, 'Two uploads are pushing chunks (the cap)');
  assert(rowOf(z.hash).arweaveUploaderState.headerReposts === 1 && net.txs.has(z.hash), 'Meanwhile a fourth row still got its header re-posted');
  const queued = minedRows.filter((h) => !worker._state.pushing.has(h));
  assert(
    queued.length === 1 && !worker._state.inFlight.has(queued[0]) && minedRows.filter((h) => worker._state.inFlight.has(h)).length === 2,
    'The third MINED row ends its pass without pushing (push_queued) while the two pushes run (cap held)'
  );
  release();
  await quiet(async () => {
    for (let i = 0; i < 200 && worker._state.inFlight.size; i++) await new Promise((r) => setTimeout(r, 20));
  });
  global.fetch = fetchBefore4;

  // ── #8: no spool read while only waiting for confirmations ────────────────
  console.log('\n=== Waiting for confirmations does not re-read the spool ===\n');
  reset();
  u = await seedUpload(300 * 1024);
  net.mine(u.hash);
  await quiet(() => pass(u.hash)); // pushes the copies
  const realRead = spool.read;
  let reads = 0;
  spool.read = async (h) => (reads++, realRead(h));
  net.advance(2);
  const out8 = await quiet(() => pass(u.hash));
  assert(out8 === 'confirming' && reads === 0, `A confirming pass with copies done reads the spool 0 times (got ${reads})`);
  net.advance(15);
  await quiet(() => pass(u.hash));
  assert(reads === 1 && rowOf(u.hash).status !== 'pending_confirmation', 'The verifying pass reads it once, and stores');
  spool.read = realRead;

  // ── #7: replication checks cover the window, least recently checked first ─
  console.log('\n=== Replication monitoring covers every book over time ===\n');
  reset();
  const HOUR = 60 * 60_000;
  const ages = [null, null, null, 7, 8, 9, 10, 11, 12, 13, 14, 1]; // hours since last check; null = never
  ages.forEach((h, i) => {
    db.rows.push({
      arweaveHash: `R${String(i).padStart(2, '0')}`.padEnd(43, 'x'),
      status: 'pending_stake',
      storageProvider: 'arweave-l1',
      uploadTimestamp: new Date(),
      arweaveUploaderState: {
        header: { data_size: '1', data_root: 'r' },
        verified: { nodes: [B, C] },
        ...(h === null ? {} : { replication: { checkedAt: new Date(Date.now() - h * HOUR).toISOString() } }),
      },
    });
  });
  const realVerify = arweave.verifyHolders;
  const checked = [];
  arweave.verifyHolders = async ({ txId, nodes }) => (checked.push(txId), { verified: nodes, failures: {} });
  await worker.monitorReplication();
  arweave.verifyHolders = realVerify;
  const ageOf = (id) => ages[Number(id.slice(1, 3))];
  assert(checked.length === 10, `One pass checks 10 books, not 1 (got ${checked.length})`);
  assert(checked.slice(0, 3).every((id) => ageOf(id) === null), 'Never-checked books go first');
  assert(!checked.some((id) => ageOf(id) === 1), 'A book checked 1 h ago (< 6 h) is not re-checked');
  assert(!checked.some((id) => ageOf(id) === 7), 'With more due than fit in one pass, the most recently checked waits');

  // ── Dedup ignores storage_failed rows ─────────────────────────────────────
  console.log('\n=== Near-duplicate check ignores failed uploads ===\n');
  let seenWhere = null;
  stub('../config/db', { upload: { findMany: async ({ where }) => ((seenWhere = where), []) } });
  delete require.cache[require.resolve('../services/dedup.service')];
  await require('../services/dedup.service').checkNearDuplicate('ffffffffffffffff');
  assert(JSON.stringify(seenWhere).includes('"status":"storage_failed"') && JSON.stringify(seenWhere).includes('"NOT"'), 'checkNearDuplicate excludes status storage_failed');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${'='.repeat(50)}\n  Passed: ${passed}\n  Failed: ${failed}\n${'='.repeat(50)}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
