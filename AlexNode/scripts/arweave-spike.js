#!/usr/bin/env node
// Phase 0 spike: direct Arweave L1 uploads, measured against the REAL network.
// See ARWEAVE-DIRECT-PLAN.md §7 (Phase 0) and §9 (the questions this answers).
//
//   node scripts/arweave-spike.js wallet                 # create/check the storage wallet
//   node scripts/arweave-spike.js quote [--mb N]         # price only, spends nothing
//   node scripts/arweave-spike.js sign-test [--mb N]     # sign locally + check the id, sends nothing
//   node scripts/arweave-spike.js small [--mb 1] [--reward-multiplier 1.1] --yes
//   node scripts/arweave-spike.js large [--mb 150] [--eager] [--max-ar 2.1] --yes
//   node scripts/arweave-spike.js watch <txId>           # mined? → chunks → confirmations → probes
//   node scripts/arweave-spike.js status <txId>          # one-shot snapshot + read probes
//   node scripts/arweave-spike.js report                 # Q1–Q11 evidence across every run
//
// Uploads go to RAW Arweave nodes, never a gateway (decision D6). Nodes come from
// ARWEAVE_NODE_URLS if set (e.g. our own node later), otherwise from GET /peers on
// ARWEAVE_PEER_SEEDS. Every candidate is health-checked with GET /info before use.
//
// ⚠️ MAINNET. There is no public Arweave testnet (ARWEAVE-DIRECT.md §10). Every
// `small`/`large` run spends real AR and publishes PERMANENTLY. That is why:
//   • the payload is always crypto.randomBytes — never a real book, never a file
//     path you pass in. Random bytes are incompressible, like our AES-GCM output.
//   • nothing is sent without --yes, and the quote is printed first.
//   • a run aborts if its fee exceeds SPIKE_MAX_AR (default 1 AR).
//   • every item is tagged App-Name=Alexandria-Spike, so it is never mistaken for
//     a real Alexandria upload by anything that indexes our tags later.
//
// Why record raw responses: the base58 incident (ARWEAVE-IRYS.md). The Irys fake
// in uploadFlow.test.js was written from a doc instead of from reality, so it
// certified a bug. Phase 2's fake arweave-js is built from what this script
// saves in .arweave-spike/<txId>/run.json — not from ARWEAVE-DIRECT.md.

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 22) {
  // arweave-js 2.x declares engines >=22 (D4). Fail here rather than on some
  // obscure API difference halfway through a paid upload.
  console.error(`Node ${process.versions.node} detected; arweave-js 2.x needs Node >= 22. Run: nvm use 22.21.1`);
  process.exit(1);
}

// The production module: wallet checks, node discovery (median-height tip), the
// price quorum and ARWEAVE_MAX_REWARD_AR cap. Requiring it also validates env
// (e.g. ARWEAVE_CONFIRMATIONS); a bad value is reported as one line, not a stack.
let cfg;
try {
  cfg = require('../config/arweave');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(ROOT, '.arweave-spike');
// Gateways are used ONLY to read data back and compare it to the fixture (Q6).
const GATEWAYS = cfg.ARWEAVE_GATEWAY_URLS;
const CONFIRMATIONS = cfg.ARWEAVE_CONFIRMATIONS; // D2
const ANCHOR_DEPTH = 50; // STORE_BLOCKS_BEHIND_CURRENT, ar.hrl [D8][D9]
// Extra blocks waited past the anchor deadline before calling a tx dropped: the
// node we ask may lag the tip by up to MAX_PEER_LAG (2), and a tx mined in the
// last valid block needs a moment to show up in /status. Erring late is safe;
// declaring a drop early would be wrong.
const DROP_MARGIN = 3;
const SERVE_LIMIT = 12 * 1024 * 1024; // MAX_SERVED_TX_DATA_SIZE [D11]
const HEADER_PEERS = 3; // the same signed header goes to this many nodes (D6)
const MAX_CHUNK_PEERS = 5; // chunk failover gives up after this many nodes
const REPOST_EVERY_BLOCKS = 5; // re-send the header while unmined and still inside the anchor window

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const positional = args.slice(1).find((a) => !a.startsWith('--'));
// --max-ar raises the cap for one run (the 150 MiB test costs ≈2.02 AR) without editing .env.
// This is the spike's own, tighter cap; ARWEAVE_MAX_REWARD_AR (config) still applies.
// Parsed only by the commands that spend, so a typo cannot break `report` or `watch`.
function spikeCapWinston() {
  const raw = option('max-ar', process.env.SPIKE_MAX_AR || '1');
  try {
    return cfg.arToWinston(raw);
  } catch (err) {
    throw new Error(`--max-ar / SPIKE_MAX_AR: ${err.message}`);
  }
}
const arweaveFor = cfg.arweaveFor;

// Set by selectNodes(): healthy raw nodes, best first, and an arweave-js client on the first.
let NODES = [];
let arweave;

/**
 * Pick healthy raw nodes via config/arweave.js. Without `preferred` this is the
 * module's cached list, the SAME one getPrice/getBalance use, so one discovery
 * serves the whole command and the price comes from the nodes we post to.
 * `preferred` (the nodes a resumed run already posted to) forces a fresh
 * selection that keeps those at the front if they are still healthy.
 */
async function selectNodes(preferred = []) {
  NODES = preferred.length ? await cfg.selectNodes(preferred) : await cfg.getNodes();
  arweave = arweaveFor(NODES[0]);
  console.log(`  nodes: ${NODES.length} healthy; first: ${NODES.slice(0, HEADER_PEERS).join(', ')}`);
}

// Height of the anchor block. The tx stays valid while that block is among the
// last 50 [D2: "a hash of one of the last 50 blocks"], so the real deadline is
// anchorHeight + 50, not "height when we signed" + 50. Which block /tx_anchor
// picks relative to the tip is not documented; this records it (Q11).
async function anchorHeight(anchor) {
  try {
    const res = await arweave.api.get(`block/hash/${anchor}`);
    return res.status === 200 && Number.isSafeInteger(res.data && res.data.height) ? res.data.height : null;
  } catch {
    return null;
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ar = (winston) => `${(Number(BigInt(winston)) / 1e12).toFixed(6)} AR`;
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

function b64urlToBuffer(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function toB64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function runDir(txId) {
  return path.join(RUNS_DIR, txId);
}
function loadRun(txId) {
  const file = path.join(runDir(txId), 'run.json');
  if (!fs.existsSync(file)) throw new Error(`No spike run recorded for ${txId} (looked in ${file})`);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  run.chunkNodes = run.chunkNodes || [];
  return run;
}
function saveRun(run) {
  fs.mkdirSync(runDir(run.txId), { recursive: true });
  fs.writeFileSync(path.join(runDir(run.txId), 'run.json'), JSON.stringify(run, null, 2));
}
function record(run, type, detail = {}) {
  const event = { t: now(), type, ...detail };
  run.events.push(event);
  saveRun(run);
  console.log(`  [${event.t}] ${type}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
}

// Wallet loading, its checks (EVM address, public-only key, address mismatch),
// balance and price all come from config/arweave.js, so Phase 0 measures the code
// production will run rather than a copy of it.
const loadWallet = () => cfg.loadWallet();
const balanceOf = async () => (await cfg.getBalance()).winston;

async function height() {
  return (await arweave.network.getInfo()).height;
}

// Read at most `limit` bytes of a response body, then drop the connection, so a
// probe against a 60 MiB item does not download 60 MiB.
async function readPrefix(res, limit) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(parts).subarray(0, limit);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdWallet() {
  const file = cfg.ARWEAVE_WALLET_FILE;
  if (!fs.existsSync(file)) {
    const jwk = await cfg.offline.wallets.generate();
    // 'wx' = fail if it exists. Never overwrite a key that might hold funds.
    fs.writeFileSync(file, JSON.stringify(jwk), { flag: 'wx', mode: 0o600 });
    console.log(`Created a new RSA-4096 storage wallet at ${file}`);
    console.log('  ⚠️ Back this file up. Arweave keys "can never be recovered if lost" [D4].');
  }
  const { address } = await loadWallet();
  const balance = await balanceOf();
  console.log(`Address : ${address}`);
  console.log(`Balance : ${ar(balance)} (${balance} winston)`);
  console.log(`Node    : ${NODES[0]}`);
  if (!cfg.ARWEAVE_WALLET_ADDRESS) console.log(`\nAdd to .env:  ARWEAVE_WALLET_ADDRESS=${address}`);
  if (BigInt(balance) === 0n) console.log('\nFund this address with AR before running small/large.');
}

// Free half of Q1: build and sign a transaction, check the id, send NOTHING.
// Signing is local [D4], so this works on an unfunded wallet.
async function cmdSignTest() {
  const { jwk } = await loadWallet();
  const data = crypto.randomBytes(Math.round(Number(option('mb', 1)) * 1024 * 1024));
  const tx = await arweave.createTransaction({ data, reward: '1' }, jwk);
  tx.addTag('App-Name', 'Alexandria-Spike');
  await arweave.transactions.sign(tx, jwk);
  const derived = toB64url(crypto.createHash('sha256').update(b64urlToBuffer(tx.signature)).digest());
  console.log(`id                         ${tx.id}`);
  console.log(`base64url, 43 chars        ${/^[A-Za-z0-9_-]{43}$/.test(tx.id)}`);
  console.log(`== sha256(signature)       ${derived === tx.id}`);
  console.log(`verify() accepts signature ${await arweave.transactions.verify(tx)}`);
  console.log(`chunks                     ${tx.chunks.chunks.length}  (format ${tx.format}, anchor ${tx.last_tx.slice(0, 12)}…)`);
  console.log('Nothing was posted.');
}

async function cmdQuote() {
  const bytes = Math.round(Number(option('mb', 1)) * 1024 * 1024);
  const price = await cfg.getPrice(bytes); // median of up to 3 nodes, capped
  console.log(`${mib(bytes)} → ${price} winston = ${ar(price)}`);
}

/**
 * Build, sign, and post an upload. Shared by `small` and `large`.
 *   mode 'full'   — post header + every chunk now (small, and large --eager)
 *   mode 'header' — post the header only; `watch` uploads chunks after mining
 */
async function startRun(kind, { megabytes, mode, rewardMultiplier }) {
  const { jwk, address } = await loadWallet();
  const bytes = Math.round(megabytes * 1024 * 1024);
  const data = crypto.randomBytes(bytes);

  if (!(rewardMultiplier > 0) || !Number.isFinite(rewardMultiplier)) {
    throw new Error(`--reward-multiplier must be a positive number, got ${rewardMultiplier}`);
  }
  // The same price path production will use: median of up to 3 nodes, capped.
  const price = BigInt(await cfg.getPrice(bytes));
  const reward = (price * BigInt(Math.round(rewardMultiplier * 1000))) / 1000n;
  const balanceBefore = await balanceOf();

  console.log(`\n${kind.toUpperCase()} — ${mib(bytes)} random fixture, mode=${mode}`);
  console.log(`  nodes     ${NODES.slice(0, HEADER_PEERS).join(', ')}`);
  console.log(`  price     ${ar(price)}  ×${rewardMultiplier} → reward ${ar(reward)}`);
  console.log(`  balance   ${ar(balanceBefore)}`);

  const spikeCap = spikeCapWinston();
  if (reward > spikeCap) {
    throw new Error(`Reward ${ar(reward)} exceeds the spike cap of ${cfg.winstonToAr(spikeCap)} AR (SPIKE_MAX_AR / --max-ar). Raise it deliberately if intended.`);
  }
  // The multiplier is applied after getPrice's cap check, so re-check the final reward.
  if (reward > cfg.ARWEAVE_MAX_REWARD_WINSTON) {
    throw new Error(`Reward ${ar(reward)} exceeds ARWEAVE_MAX_REWARD_AR=${cfg.winstonToAr(cfg.ARWEAVE_MAX_REWARD_WINSTON)}.`);
  }
  const funded = BigInt(balanceBefore) >= reward;
  if (!flag('yes')) {
    if (!funded) console.log(`\n⚠️ Balance is below the reward. Fund ${address} first.`);
    console.log('\nDry run. Nothing signed or sent. Re-run with --yes to spend and publish permanently.');
    return;
  }
  if (!funded) {
    throw new Error(`Balance ${ar(balanceBefore)} is below the reward ${ar(reward)}. Fund ${address}.`);
  }

  const heightAtSign = await height();
  // reward is supplied, so createTransaction fetches only the anchor (block
  // anchor via GET /tx_anchor — decision D1) and prepares chunks [S3].
  const tx = await arweave.createTransaction({ data, reward: reward.toString() }, jwk);
  tx.addTag('Content-Type', 'application/octet-stream');
  tx.addTag('App-Name', 'Alexandria-Spike');
  tx.addTag('App-Version', '0');
  tx.addTag('Spike-Kind', kind);
  await arweave.transactions.sign(tx, jwk);

  // Q1: is the id exactly base64url(sha256(signature)), 43 chars? [D2]
  const derived = toB64url(crypto.createHash('sha256').update(b64urlToBuffer(tx.signature)).digest());

  // Q11: the deadline counts from the anchor block. Fall back to the height at
  // signing only if the node will not say (later than the truth, so still safe).
  const anchorH = await anchorHeight(tx.last_tx);
  const deadlineBase = anchorH ?? heightAtSign;

  const run = {
    kind,
    mode,
    txId: tx.id,
    headerNodes: NODES.slice(0, HEADER_PEERS),
    chunkNodes: [],
    address,
    bytes,
    reward: reward.toString(),
    priceAtSign: price.toString(),
    rewardMultiplier,
    anchor: tx.last_tx,
    anchorHeight: anchorH,
    heightAtSign,
    anchorDeadline: deadlineBase + ANCHOR_DEPTH,
    anchorDeadlineFrom: anchorH !== null ? 'anchor block' : 'height at signing (anchor height unavailable)',
    dataRoot: tx.data_root,
    checks: {
      idIsBase64url43: /^[A-Za-z0-9_-]{43}$/.test(tx.id),
      idMatchesSha256OfSignature: derived === tx.id,
      fixtureSha256: crypto.createHash('sha256').update(data).digest('hex'),
    },
    balances: { beforePost: balanceBefore },
    chunksComplete: false,
    events: [],
  };

  // The fixture is kept on disk because resuming "must provide the same data as
  // the original upload" [D4] — the same reason ARWEAVE_SPOOL_DIR exists (plan §2.2).
  fs.mkdirSync(runDir(tx.id), { recursive: true });
  fs.writeFileSync(path.join(runDir(tx.id), 'fixture.bin'), data);
  record(run, 'signed', { txId: tx.id, chunks: tx.chunks.chunks.length, checks: run.checks });

  const uploader = await arweave.transactions.getUploader(tx, data);
  run.totalChunks = uploader.totalChunks;

  // First uploadChunk() posts the header — WITHOUT data when totalChunks > 1 [S4].
  const tPost = Date.now();
  await uploader.uploadChunk();
  saveUploader(tx.id, uploader);
  record(run, 'header_posted', {
    node: NODES[0],
    ms: Date.now() - tPost,
    status: uploader.lastResponseStatus,
    uploadedChunks: uploader.uploadedChunks,
    totalChunks: uploader.totalChunks,
  });

  // The exact header as posted: data stripped when > 1 chunk, included when 1 chunk
  // (arweave-js postTransaction [S4]). Kept so `watch` can re-send the SAME signed
  // header — same id, so the Lit seal stays valid — while the anchor is still live.
  const header = uploader.totalChunks <= 1 ? tx : uploader.transaction;
  fs.writeFileSync(path.join(runDir(tx.id), 'header.json'), JSON.stringify(header));
  run.lastHeaderPostHeight = heightAtSign;
  // Q8: send the same header to the other nodes too (D6), and record what each says.
  await broadcastHeader(run, run.headerNodes.slice(1), 'header_broadcast');

  run.postedAt = now();
  run.balances.afterPost = await balanceOf();
  await snapshotTx(run, 'after_header_post');

  if (mode === 'full') {
    // Before mining, the node's pending-chunk cap is 50 MiB per transaction [D2].
    // In --eager mode on a larger fixture, we EXPECT errors here — that is Q3.
    // Stop after a few consecutive errors instead of arweave-js's ~1 hour of retries,
    // and do NOT fail over: moving to another node would hide the limit we are measuring.
    run.chunkNodes.push(NODES[0]);
    run.chunksComplete = await pushChunks(run, uploader, { stopAfterErrors: 3 });
    saveRun(run);
  }

  console.log(`\nNext: node scripts/arweave-spike.js watch ${tx.id}`);
}

function saveUploader(txId, uploader) {
  // toJSON() leaves the data out by design; fixture.bin holds it.
  fs.writeFileSync(path.join(runDir(txId), 'uploader.json'), JSON.stringify(uploader));
}

async function pushChunks(run, uploader, { stopAfterErrors }) {
  const start = Date.now();
  const startChunks = uploader.uploadedChunks;
  let consecutiveErrors = 0;

  while (!uploader.isComplete) {
    try {
      await uploader.uploadChunk();
    } catch (err) {
      // arweave-js throws on FATAL chunk errors and after 100 consecutive soft ones.
      saveUploader(run.txId, uploader);
      record(run, 'chunk_fatal', { message: err.message, uploadedChunks: uploader.uploadedChunks });
      return false;
    }
    saveUploader(run.txId, uploader);

    if (uploader.lastResponseError) {
      consecutiveErrors++;
      record(run, 'chunk_error', {
        status: uploader.lastResponseStatus,
        error: uploader.lastResponseError,
        uploadedChunks: uploader.uploadedChunks,
      });
      if (stopAfterErrors && consecutiveErrors >= stopAfterErrors) {
        record(run, 'chunks_paused', { reason: `${consecutiveErrors} consecutive errors` });
        return false;
      }
    } else {
      consecutiveErrors = 0;
      process.stdout.write(`\r  chunks ${uploader.uploadedChunks}/${uploader.totalChunks} (${uploader.pctComplete}%)   `);
    }
  }

  const seconds = (Date.now() - start) / 1000;
  const sent = (uploader.uploadedChunks - startChunks) * 256 * 1024;
  process.stdout.write('\n');
  record(run, 'chunks_complete', {
    seconds,
    approxMiBps: seconds > 0 ? Number((sent / 1024 / 1024 / seconds).toFixed(2)) : null,
  });
  return true;
}

// Post the saved, signed header to each node. A node that already has it may answer
// with a non-200; every answer is recorded verbatim rather than interpreted (Q8).
async function broadcastHeader(run, nodes, label) {
  if (!nodes.length) return;
  const header = JSON.parse(fs.readFileSync(path.join(runDir(run.txId), 'header.json'), 'utf8'));
  const results = await Promise.all(
    nodes.map(async (url) => {
      try {
        const res = await arweaveFor(url).api.post('tx', header);
        const body = typeof res.data === 'string' ? res.data.slice(0, 200) : res.data;
        return { node: url, status: res.status, body };
      } catch (err) {
        return { node: url, error: err.message };
      }
    })
  );
  record(run, label, { results });
}

// D6: chunks go to ONE node at a time; on repeated errors, resume on the next node
// from the saved state. Chunk failover is Q9: does a second node accept the rest?
async function resumeChunks(run) {
  const dir = runDir(run.txId);
  const data = fs.readFileSync(path.join(dir, 'fixture.bin'));
  for (const url of NODES.slice(0, MAX_CHUNK_PEERS)) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'uploader.json'), 'utf8'));
    // The saved error belongs to the previous attempt; keeping it would make
    // arweave-js sleep ~40 s before the first request to a fresh node.
    state.lastResponseError = '';
    const uploader = await arweaveFor(url).transactions.getUploader(state, data);
    run.chunkNodes.push(url);
    record(run, 'chunks_resumed', { node: url, uploadedChunks: uploader.uploadedChunks, totalChunks: uploader.totalChunks });
    run.chunksComplete = await pushChunks(run, uploader, { stopAfterErrors: 5 });
    saveRun(run);
    if (run.chunksComplete) return;
  }
}

// Raw node responses, saved verbatim for Phase 2's test fakes.
async function snapshotTx(run, label) {
  const [tx, status] = await Promise.all([
    arweave.api.get(`tx/${run.txId}`).catch((e) => ({ status: -1, data: e.message })),
    arweave.api.get(`tx/${run.txId}/status`).catch((e) => ({ status: -1, data: e.message })),
  ]);
  const txData = tx.data && typeof tx.data === 'object' ? tx.data : null;
  if (txData && txData.id) run.checks.nodeReportsSameId = txData.id === run.txId;
  record(run, `snapshot_${label}`, {
    txStatus: tx.status,
    txBody: txData ? { id: txData.id, data_size: txData.data_size, data_root: txData.data_root } : tx.data,
    statusCode: status.status,
    statusBody: status.data,
  });
}

async function probeReads(run) {
  const prefixLen = Math.min(1024, run.bytes);
  const fixture = fs.readFileSync(path.join(runDir(run.txId), 'fixture.bin'));
  const expected = fixture.subarray(0, prefixLen);
  const results = {};

  // A plain node only serves /tx/{id}/data up to 12 MiB [D11].
  const node = run.chunkNodes[run.chunkNodes.length - 1] || NODES[0];
  try {
    const res = await fetch(`${node}/tx/${run.txId}/data`, { signal: AbortSignal.timeout(60_000) });
    const body = await readPrefix(res, 300);
    results.nodeTxData = {
      node,
      status: res.status,
      expectTooBig: run.bytes > SERVE_LIMIT,
      body: res.ok ? `(${body.length} bytes read)` : body.toString('utf8'),
    };
  } catch (err) {
    results.nodeTxData = { error: err.message };
  }

  for (const gw of GATEWAYS) {
    try {
      const res = await fetch(`${gw}/${run.txId}`, {
        headers: { Range: `bytes=0-${prefixLen - 1}` },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await readPrefix(res, prefixLen);
      results[gw] = {
        status: res.status,
        contentLength: res.headers.get('content-length'),
        // Byte-for-byte check against the fixture: a gateway can withhold, not forge.
        prefixMatchesFixture: res.ok && body.equals(expected),
      };
    } catch (err) {
      results[gw] = { error: err.message };
    }
  }

  run.lastProbe = { t: now(), results };
  record(run, 'read_probe', results);
}

async function cmdWatch() {
  const run = loadRun(positional);
  const interval = Number(option('interval', 30)) * 1000;
  console.log(`Watching ${run.txId} (${run.kind}, ${mib(run.bytes)}) — target ${CONFIRMATIONS} confirmations`);
  await selectNodes(run.headerNodes);

  // 1. Wait for the header to be mined, or for the anchor to expire (D1).
  let lastCode;
  while (!run.minedAt) {
    const status = await arweave.transactions.getStatus(run.txId);
    const h = await height();
    if (status.status !== lastCode) {
      record(run, 'status_change', { status: status.status, height: h, deadline: run.anchorDeadline });
      lastCode = status.status;
    }
    if (status.confirmed) {
      run.minedAt = now();
      run.minedHeight = status.confirmed.block_height;
      run.balances.afterMined = await balanceOf();
      record(run, 'mined', {
        blockHeight: status.confirmed.block_height,
        secondsSincePost: (Date.parse(run.minedAt) - Date.parse(run.postedAt)) / 1000,
        balanceAfterMined: run.balances.afterMined,
      });
      await snapshotTx(run, 'after_mined');
      break;
    }
    if (h > run.anchorDeadline + DROP_MARGIN) {
      // Q4's interesting case: a transaction that was never mined.
      run.droppedAt = now();
      run.balances.afterDrop = await balanceOf();
      record(run, 'dropped', { height: h, balanceAfterDrop: run.balances.afterDrop });
      return;
    }
    // Not known to the node at all (404, as opposed to 202 pending) and still inside
    // the anchor window: re-send the same signed header. Same id, so nothing breaks.
    if (status.status === 404 && h >= (run.lastHeaderPostHeight || run.heightAtSign) + REPOST_EVERY_BLOCKS) {
      run.lastHeaderPostHeight = h;
      await broadcastHeader(run, NODES.slice(0, HEADER_PEERS), 'header_reposted');
    }
    await sleep(interval);
  }

  // 2. Upload chunks now that the 50 MiB pending cap no longer applies (plan §2.3).
  if (!run.chunksComplete) await resumeChunks(run);
  if (!run.chunksComplete) {
    console.log(`Chunks not complete. Re-run: node scripts/arweave-spike.js watch ${run.txId}`);
    return;
  }

  // 3. Wait for the confirmation target (D2).
  while (!run.confirmedAt) {
    const status = await arweave.transactions.getStatus(run.txId);
    const confs = status.confirmed ? status.confirmed.number_of_confirmations : 0;
    process.stdout.write(`\r  confirmations ${confs}/${CONFIRMATIONS}   `);
    if (confs >= CONFIRMATIONS) {
      process.stdout.write('\n');
      run.confirmedAt = now();
      record(run, 'confirmed', {
        confirmations: confs,
        secondsSinceMined: (Date.parse(run.confirmedAt) - Date.parse(run.minedAt)) / 1000,
      });
      break;
    }
    await sleep(interval);
  }

  // 4. Can it be read back, and from where?
  await probeReads(run);
  console.log(`\nDone. Re-probe reads later with: node scripts/arweave-spike.js status ${run.txId}`);
}

async function cmdStatus() {
  const run = loadRun(positional);
  await selectNodes(run.headerNodes);
  const status = await arweave.transactions.getStatus(run.txId);
  console.log(`${run.txId}: ${JSON.stringify(status)}  (height ${await height()}, deadline ${run.anchorDeadline})`);
  await snapshotTx(run, 'status');
  await probeReads(run);
}

function cmdReport() {
  if (!fs.existsSync(RUNS_DIR)) return console.log('No runs yet.');
  const runs = fs
    .readdirSync(RUNS_DIR)
    .filter((d) => fs.existsSync(path.join(RUNS_DIR, d, 'run.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(RUNS_DIR, d, 'run.json'), 'utf8')));

  for (const r of runs) {
    const ev = (type) => r.events.filter((e) => e.type === type);
    const headerOnly = ev('header_posted')[0];
    const delta = (a, b) => (a && b ? (BigInt(a) - BigInt(b)).toString() : null);
    console.log(`\n── ${r.txId}  ${r.kind}/${r.mode}  ${mib(r.bytes)}  ×${r.rewardMultiplier}`);
    console.log(`Q1 id format     base64url43=${r.checks.idIsBase64url43}  sha256(sig)=${r.checks.idMatchesSha256OfSignature}  node same id=${r.checks.nodeReportsSameId ?? '?'}`);
    console.log(`Q2 header only   uploadedChunks after post=${headerOnly ? headerOnly.uploadedChunks : '?'} of ${r.totalChunks}`);
    console.log(`Q3 chunk errors  ${ev('chunk_error').length} soft, ${ev('chunk_fatal').length} fatal, paused=${ev('chunks_paused').length > 0}; first: ${JSON.stringify((ev('chunk_error')[0] || ev('chunk_fatal')[0] || {}).error || (ev('chunk_fatal')[0] || {}).message || null)}`);
    console.log(`Q4 charged       at post=${delta(r.balances.beforePost, r.balances.afterPost)}  at mined=${delta(r.balances.beforePost, r.balances.afterMined)}  dropped=${delta(r.balances.beforePost, r.balances.afterDrop)}  reward=${r.reward}`);
    console.log(`Q5 timings       mined=${(ev('mined')[0] || {}).secondsSincePost ?? '?'}s  chunks=${JSON.stringify((ev('chunks_complete')[0] || {}).seconds ?? '?')}s @ ${(ev('chunks_complete')[0] || {}).approxMiBps ?? '?'} MiB/s  →${CONFIRMATIONS} confs=${(ev('confirmed')[0] || {}).secondsSinceMined ?? '?'}s`);
    console.log(`Q6 reads         ${r.lastProbe ? JSON.stringify(r.lastProbe.results) : 'not probed yet'}`);
    console.log(`Q7 reward >price ${r.rewardMultiplier > 1 ? (r.minedAt ? 'accepted and mined' : r.droppedAt ? 'DROPPED' : 'pending') : 'n/a (×1)'}`);
    const bc = ev('header_broadcast')[0];
    console.log(`Q8 header nodes  first=${headerOnly ? headerOnly.status : '?'}  others=${bc ? JSON.stringify(bc.results.map((x) => x.status ?? x.error)) : 'n/a'}  reposts=${ev('header_reposted').length}`);
    console.log(`Q9 chunk nodes   ${JSON.stringify(r.chunkNodes || [])}  (more than one = failover happened)`);
    const gap = Number.isSafeInteger(r.anchorHeight) ? r.heightAtSign - r.anchorHeight : '?';
    console.log(`Q11 anchor       block ${r.anchorHeight ?? '?'}, signed at height ${r.heightAtSign} (anchor ${gap} blocks behind); deadline ${r.anchorDeadline} from ${r.anchorDeadlineFrom || 'height at signing'}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    // watch/status pick nodes themselves (preferring the run's own); report is offline.
    if (['wallet', 'quote', 'sign-test', 'small', 'large'].includes(command)) await selectNodes();
    switch (command) {
      case 'wallet':
        return await cmdWallet();
      case 'quote':
        return await cmdQuote();
      case 'sign-test':
        return await cmdSignTest();
      case 'small':
        return await startRun('small', {
          megabytes: Number(option('mb', 1)),
          mode: 'full',
          rewardMultiplier: Number(option('reward-multiplier', 1)),
        });
      case 'large':
        return await startRun('large', {
          megabytes: Number(option('mb', 150)), // our MAX_FILE_SIZE_MB: the worst case
          mode: flag('eager') ? 'full' : 'header',
          rewardMultiplier: Number(option('reward-multiplier', 1)),
        });
      case 'watch':
        if (!positional) throw new Error('Usage: watch <txId>');
        return await cmdWatch();
      case 'status':
        if (!positional) throw new Error('Usage: status <txId>');
        return await cmdStatus();
      case 'report':
        return cmdReport();
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n').replace(/^\/\/ ?/gm, ''));
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
})();
