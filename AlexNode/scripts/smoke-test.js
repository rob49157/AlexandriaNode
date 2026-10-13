#!/usr/bin/env node
// Live end-to-end test against real infrastructure: Phase 5 of ARWEAVE-DIRECT-PLAN.md.
//
//   node scripts/smoke-test.js            # Part A: storage roundtrip on Arweave mainnet
//   node scripts/smoke-test.js --full     # + Part B: real HTTP upload → worker → Base Sepolia
//
// ⚠️ MAINNET + PERMANENT. Each part publishes one small test PDF to Arweave
// mainnet, paid from the storage wallet (≈0.0135 AR each), and it stays public
// forever (encrypted). Part B also REGISTERS the book on Base Sepolia, and
// AlexandriaLibrary.registerUpload has no delete. The archivist is a fresh
// throwaway address, so nobody can ever stake on that entry.
//
// Nothing is stubbed: real Arweave nodes, real Lit, real Neon, real Base Sepolia.
// This is the only test that proves the pieces work together.
//
// Part A keeps the symmetric key in-process, so it can prove that bytes read
// back from Arweave decrypt to the original PDF. The upload path cannot: it
// zeroes the key, and only the (not yet built) decryption Lit Action can release
// the sealed copy (KEY-BINDING.md). Part B therefore proves storage, indexing and
// registration, and checks the stored bytes against the signed data_root.
//
// Part B needs the server running with this code:
//   nvm use 22.21.1 && npm start      (STORAGE_WORKER_ENABLED not false)

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const { ethers } = require('ethers');

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node ${process.versions.node}: arweave-js 2.x needs Node >= 22. Run: nvm use 22.21.1`);
  process.exit(1);
}

const FULL = process.argv.includes('--full');
const PORT = process.env.PORT || 3001;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function assert(condition, name, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}
const section = (name) => console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

/** Minimal but structurally valid PDF: passes magic bytes, parses, 1 page. */
function makePdf(marker) {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
      `4 0 obj<</Marker(${marker})>>endobj`,
      'xref',
      '0 4',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000058 00000 n ',
      '0000000115 00000 n ',
      'trailer<</Size 4/Root 1 0 R>>',
      'startxref',
      '190',
      '%%EOF',
    ].join('\n'),
    'latin1'
  );
}

// ─── Part A: storage roundtrip (key kept in-process) ─────────────────────────

async function storageRoundtrip() {
  section('Part A — encrypt → store on mainnet → read back from raw nodes → decrypt');
  const cfg = require('../config/arweave');
  const arweave = require('../controller/arweave');
  const { aesEncryptPdf } = require('../controller/litProtocol');

  const pdf = makePdf(`live-A-${Date.now()}`);
  const before = await cfg.getBalance();
  console.log(`  PDF ${pdf.length} bytes; wallet ${before.address} holds ${before.ar} AR`);

  const { ciphertext, iv, authTag, symmetricKey } = aesEncryptPdf(Buffer.from(pdf));
  const tags = arweave.buildTags({
    iv,
    authTag,
    metadata: { title: 'Alexandria live storage test (Part A)', author: 'Alexandria', category: 'other' },
    uploader: '0x0000000000000000000000000000000000000001',
    sha256Hash: crypto.createHash('sha256').update(pdf).digest('hex'),
  });

  const prepared = await arweave.prepareUpload(ciphertext, tags);
  const hash = prepared.arweaveHash;
  assert(arweave.isValidArweaveHash(hash), 'arweaveHash is 43-char base64url', hash);
  console.log(`  arweaveHash ${hash}  fee ${cfg.winstonToAr(prepared.reward)} AR`);

  const post = await arweave.postHeader(prepared.header);
  assert(post.accepted.length >= 1, `header accepted by ${post.accepted.length} node(s)`, JSON.stringify(post.results));

  console.log(`  [${stamp()}] waiting for the header to be mined...`);
  let status;
  for (let i = 0; i < 60; i++) {
    status = await arweave.getTxStatus(hash).catch(() => ({ state: 'error' }));
    if (status.state === 'mined') break;
    if (status.state === 'not_found' && i % 10 === 9) await arweave.postHeader(prepared.header);
    await sleep(15_000);
  }
  assert(status.state === 'mined', 'header mined', JSON.stringify(status));
  if (status.state !== 'mined') return null;
  console.log(`  [${stamp()}] mined in block ${status.blockHeight}`);

  const after = await cfg.getBalance();
  assert(BigInt(before.winston) - BigInt(after.winston) === BigInt(prepared.reward), 'wallet charged exactly the signed fee at mining (Q4)', `${before.winston} → ${after.winston}`);

  const state = { holders: {} };
  await arweave.pushChunks({ header: prepared.header, data: ciphertext, state, minHolders: cfg.ARWEAVE_MIN_HOLDERS });
  const holders = Object.entries(state.holders).filter(([, h]) => h.done).map(([n]) => n);
  assert(holders.length >= cfg.ARWEAVE_MIN_HOLDERS, `chunks on ${holders.length} long-term nodes`, holders.join(', '));
  assert(new Set(holders.map(arweave.blockOf)).size === holders.length, 'copies are in different /24 blocks');

  // Right after mining a holder can answer "not readable yet" (no_offset) for a
  // while (seen live 2026-10-13); the worker waits for 16 confirmations first.
  // Here: retry for up to 10 minutes.
  let check;
  for (let i = 0; i < 20; i++) {
    check = await arweave.verifyHolders({ txId: hash, header: prepared.header, nodes: holders, data: ciphertext });
    if (check.verified.length >= cfg.ARWEAVE_MIN_HOLDERS) break;
    console.log(`  [${stamp()}] verified ${check.verified.length}/${holders.length}: ${JSON.stringify(check.failures)}; retrying`);
    await sleep(30_000);
  }
  assert(check.verified.length >= cfg.ARWEAVE_MIN_HOLDERS, 'each copy reads back byte for byte', JSON.stringify(check.failures));

  const fetched = await arweave.fetchEncrypted(hash, { preferNodes: holders });
  assert(fetched.equals(ciphertext), 'fetchEncrypted (raw nodes, no gateway) returns the exact ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', symmetricKey, iv);
  decipher.setAuthTag(authTag);
  let decrypted = null;
  try {
    decrypted = Buffer.concat([decipher.update(fetched), decipher.final()]);
  } catch (err) {
    assert(false, 'decrypts without an auth-tag failure', err.message);
  }
  if (decrypted) assert(decrypted.equals(pdf), 'bytes read from Arweave decrypt to the ORIGINAL PDF');
  symmetricKey.fill(0);
  return hash;
}

// ─── Part B: the real request path ───────────────────────────────────────────

async function fullPipeline() {
  section('Part B — POST /api/upload → storage worker → Base Sepolia');
  const prisma = require('../config/db');
  const { getContracts } = require('../config/blockchain');
  const arweave = require('../controller/arweave');

  const health = await fetch(`${BASE}/api/storage/status`).catch(() => null);
  assert(health && health.status === 200, `server reachable and storage worker running at ${BASE}`);
  if (!health || health.status !== 200) return null;

  // A fresh address no one holds the key to: the on-chain entry stays inert.
  const ARCHIVIST = ethers.Wallet.createRandom().address;
  const pdf = makePdf(`live-B-${Date.now()}`);
  const title = `Alexandria live storage test ${new Date().toISOString().slice(0, 16)}`;
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'live-test.pdf');
  form.append('title', title);
  form.append('author', 'Alexandria Live Test');
  form.append('category', 'philosophy');
  form.append('description', 'Phase 5 verification upload (direct Arweave L1). Safe to ignore.');
  form.append('walletAddress', ARCHIVIST);

  console.log(`  archivist (throwaway): ${ARCHIVIST}`);
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  const body = await res.json();
  assert(res.status === 202, 'POST /api/upload → 202 Accepted', `${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (res.status !== 202) return null;
  const hash = body.arweaveHash;
  console.log(`  arweaveHash ${hash}  fee ${body.storage.rewardAr} AR  header accepted by ${body.storage.headerAcceptedBy}`);
  assert(body.status === 'pending_confirmation', 'status is pending_confirmation');

  // The worker takes it from here. Poll the public progress route.
  console.log(`  [${stamp()}] following GET /api/storage/${hash} (≈30–40 min for 16 confirmations)`);
  let p = {};
  let last = '';
  const deadline = Date.now() + 90 * 60_000;
  while (Date.now() < deadline) {
    p = await (await fetch(`${BASE}/api/storage/${hash}`)).json();
    const line = `${p.status} mined=${p.mined} conf=${p.confirmations}/${p.confirmationsRequired} copies=${p.copiesComplete}/${p.copiesRequired} verified=${p.verifiedCopies}${p.error ? ` err=${p.error}` : ''}`;
    if (line !== last) console.log(`  [${stamp()}] ${line}`);
    last = line;
    if (!['pending_confirmation'].includes(p.status)) break;
    await sleep(30_000);
  }
  assert(['pending_stake', 'pending'].includes(p.status), 'worker stored it: status left pending_confirmation', p.status);
  assert(p.confirmations >= p.confirmationsRequired, `${p.confirmations} confirmations (>= ${p.confirmationsRequired})`);
  assert(p.verifiedCopies >= p.copiesRequired, `${p.verifiedCopies} verified copies (>= ${p.copiesRequired})`);
  assert(p.status === 'pending', 'registered on-chain → pending', p.status);

  const row = await prisma.upload.findUnique({ where: { arweaveHash: hash } });
  assert(row && row.storageProvider === 'arweave-l1', 'row is storageProvider arweave-l1');
  assert(row && row.uploader.toLowerCase() === ARCHIVIST.toLowerCase(), 'row records the archivist as uploader');
  assert(row && row.arweaveHashTopic === ethers.id(hash), 'arweaveHashTopic = keccak256(hash)');
  assert(row && Boolean(row.onChainTxHash), 'registration tx recorded on the row', row && row.onChainTxHash);

  const { library } = getContracts();
  const onChain = await library.getUpload(hash);
  assert(onChain.uploader.toLowerCase() === ARCHIVIST.toLowerCase(), 'Base Sepolia records the ARCHIVIST as uploader');
  assert(JSON.parse(onChain.metadata).t === title, 'on-chain metadata carries the title');

  const lookup = await (await fetch(`${BASE}/api/upload/${hash}`)).json();
  assert(lookup.arweaveHash === hash && lookup.litEncryptedKeyId === undefined, 'GET /api/upload/:hash returns it without key material');
  const params = await (await fetch(`${BASE}/api/rental/decrypt-params/${hash}/${ARCHIVIST}`)).json();
  assert(params.grantedVia === 'uploader' && Boolean(params.litEncryptedKeyId), 'uploader carve-out returns the decrypt payload');

  const stored = await arweave.fetchEncrypted(hash, { preferNodes: (row && row.arweaveUploaderState.verified.nodes) || [] });
  assert(stored.length === pdf.length && !stored.equals(pdf), 'read back from raw nodes: right length, ciphertext not plaintext');

  console.log('  waiting for the event listener to see UploadRegistered...');
  let event = null;
  for (let i = 0; i < 24 && !event; i++) {
    event = await prisma.event.findFirst({ where: { arweaveHash: hash, eventName: 'UploadRegistered' } });
    if (!event) await sleep(5000);
  }
  assert(Boolean(event), 'event listener resolved UploadRegistered to this hash');

  await prisma.$disconnect();
  return hash;
}

(async () => {
  console.log(`\nAlexandria live test — ${FULL ? 'Part A + Part B (writes on-chain)' : 'Part A only'}\n`);
  const a = await storageRoundtrip();
  const b = FULL ? await fullPipeline() : null;
  if (!FULL) console.log('\n  (Part B skipped — pass --full)');
  console.log(`\n${'='.repeat(64)}\nRESULT: ${failed === 0 ? 'ALL PASSED ✓' : 'FAILURES ✗'}   passed ${passed}, failed ${failed}`);
  if (a) console.log(`  Part A tx: ${a}`);
  if (b) console.log(`  Part B tx: ${b}`);
  console.log(`${'='.repeat(64)}\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nLive test crashed:', err);
  process.exit(1);
});
