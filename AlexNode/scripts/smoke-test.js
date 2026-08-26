#!/usr/bin/env node
// Live end-to-end smoke test against real infrastructure.
//
//   node scripts/smoke-test.js            # storage integrity only (no chain writes)
//   node scripts/smoke-test.js --full     # + real upload through HTTP + on-chain registration
//
// ⚠️ --full REGISTERS A BOOK ON-CHAIN PERMANENTLY. AlexandriaLibrary.registerUpload
// has no delete. Run it deliberately, with metadata you are content to leave on
// Base Sepolia forever.
//
// Nothing here is stubbed: real Irys devnet, real Lit API, real Base Sepolia,
// real Neon. This is the only test that proves the pieces work *together* —
// every other suite mocks at least one boundary.
//
// Part A (storage integrity) keeps the symmetric key in-process so it can prove
// the bytes Arweave hands back decrypt to the original PDF. The upload path
// deliberately cannot do this: it zeroes the key, and only a Lit Action can
// release the sealed copy. Part A is therefore the only place the full crypto
// round-trip over *really stored* bytes is verifiable today.

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const { ethers } = require('ethers');

const FULL = process.argv.includes('--full');

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

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal but structurally valid PDF — passes magic bytes, parses, 1 page. */
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

/**
 * Poll the Irys gateway until the data item is served.
 * Freshly-pushed items take a few seconds to become retrievable.
 */
async function fetchFromGateway(arweaveHash, { attempts = 12, delayMs = 5000 } = {}) {
  const { IRYS_GATEWAY_URL } = require('../config/irys');
  const url = `${IRYS_GATEWAY_URL}/${arweaveHash}`;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      process.stdout.write(`    gateway ${res.status}, retry ${i}/${attempts}\r`);
    } catch (err) {
      process.stdout.write(`    gateway unreachable, retry ${i}/${attempts}\r`);
    }
    await sleep(delayMs);
  }
  return null;
}

// ─── Part A: storage integrity ───────────────────────────────────────────────

async function storageIntegrity() {
  section('Part A — storage integrity (key retained in-process)');

  const { aesEncryptPdf } = require('../controller/litProtocol');
  const { prepareUpload, commitUpload, buildTags, isValidArweaveHash } = require('../controller/arweave');
  const { getBalance, getPrice } = require('../config/irys');

  const pdf = makePdf(`smoke-${Date.now()}`);
  console.log(`  PDF: ${pdf.length} bytes`);

  const before = await getBalance();
  const quote = await getPrice(pdf.length);
  console.log(`  quote: ${(Number(quote) / 1e18).toFixed(10)} ETH`);

  // Encrypt, keeping the key so the round-trip is checkable.
  const { ciphertext, iv, authTag, symmetricKey } = aesEncryptPdf(Buffer.from(pdf));
  assert(!ciphertext.equals(pdf), 'ciphertext differs from plaintext');
  assert(iv.length === 12, 'IV is 12 bytes (GCM standard)');
  assert(authTag.length === 16, 'auth tag is 16 bytes');

  const tags = buildTags({
    iv,
    authTag,
    metadata: { title: 'Smoke Test', author: 'Alexandria', category: 'philosophy', description: 'storage check' },
    uploader: '0x0000000000000000000000000000000000000001',
    sha256Hash: crypto.createHash('sha256').update(pdf).digest('hex'),
  });

  const { arweaveHash, tx } = await prepareUpload(ciphertext, tags);
  assert(isValidArweaveHash(arweaveHash), 'arweaveHash is 43-char base64url', arweaveHash);
  console.log(`  arweaveHash: ${arweaveHash}`);

  await commitUpload(tx, arweaveHash);
  console.log('  pushed to Irys devnet');

  const after = await getBalance();
  const spent = BigInt(before.atomic) - BigInt(after.atomic);

  // Irys does not charge for data items under 100 KiB, so a small fixture is
  // free and the balance legitimately does not move. Assert it never went UP,
  // and report which regime we are in rather than pretending to measure cost.
  const FREE_TIER_BYTES = 100 * 1024;
  const freeTier = ciphertext.length < FREE_TIER_BYTES;
  assert(spent >= 0n, 'storage credit did not increase');
  if (freeTier) {
    console.log(`  spent: 0 (under Irys' ${FREE_TIER_BYTES}-byte free tier — no charge expected)`);
  } else {
    assert(spent > 0n, 'storage credit was spent for an above-free-tier upload', `${spent} atomic`);
    console.log(`  spent: ${(Number(spent) / 1e18).toFixed(10)} ETH`);
  }

  console.log('  waiting for gateway propagation...');
  const fetched = await fetchFromGateway(arweaveHash);
  assert(fetched !== null, 'ciphertext retrievable from the gateway');

  if (fetched) {
    assert(fetched.equals(ciphertext), 'retrieved bytes are byte-identical to what was uploaded');
    assert(!fetched.equals(pdf), 'what Arweave stores is NOT the plaintext PDF');

    // The real proof: decrypt what the gateway returned.
    const decipher = crypto.createDecipheriv('aes-256-gcm', symmetricKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = null;
    try {
      decrypted = Buffer.concat([decipher.update(fetched), decipher.final()]);
    } catch (err) {
      assert(false, 'decrypts without an auth-tag failure', err.message);
    }
    if (decrypted) {
      assert(decrypted.equals(pdf), 'gateway bytes decrypt to the ORIGINAL PDF, byte for byte');
    }
  }

  symmetricKey.fill(0);
  return arweaveHash;
}

// ─── Part B: full pipeline over HTTP ─────────────────────────────────────────

async function fullPipeline() {
  section('Part B — full pipeline (HTTP → Irys → Lit → Postgres → chain)');

  const prisma = require('../config/db');
  const { getContracts } = require('../config/blockchain');
  const PORT = process.env.PORT || 3001;
  const BASE = `http://localhost:${PORT}`;

  // The archivist. Recorded on-chain as `uploader`, so this is the address that
  // would have to sign stake.stake() afterwards.
  const ARCHIVIST = '0x5F47ecD28155790f1271df965373fD9aCEA643b9';

  const pdf = makePdf(`e2e-${Date.now()}`);
  const title = `Smoke Test ${new Date().toISOString().slice(0, 16)}`;

  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'smoke.pdf');
  form.append('title', title);
  form.append('author', 'Alexandria Smoke Test');
  form.append('category', 'philosophy');
  form.append('description', 'End-to-end verification upload. Safe to ignore.');
  form.append('walletAddress', ARCHIVIST);

  console.log(`  POST ${BASE}/api/upload ...`);
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  const body = await res.json();

  assert(res.status === 201, `upload returns 201`, `got ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  if (res.status !== 201) return null;

  const { arweaveHash } = body;
  console.log(`  arweaveHash: ${arweaveHash}`);
  console.log(`  registration: ${JSON.stringify(body.registration)}`);

  assert(Boolean(arweaveHash), 'response carries an arweaveHash');
  assert(Boolean(body.litEncryptedKeyId), 'response carries the sealed key id');
  assert(body.registration.registered === true, 'registered on-chain', body.registration.message);
  assert(Boolean(body.registration.txHash), 'registration transaction hash returned');
  assert(body.status === 'pending', 'status advanced to pending', body.status);

  // --- Postgres ---
  const row = await prisma.upload.findUnique({ where: { arweaveHash } });
  assert(Boolean(row), 'row indexed in Postgres');
  if (row) {
    assert(row.status === 'pending', 'row status is pending');
    assert(row.uploader.toLowerCase() === ARCHIVIST.toLowerCase(), 'row records the archivist as uploader');
    assert(Boolean(row.arweaveHashTopic), 'arweaveHashTopic written (event listener join key)');
    assert(
      row.arweaveHashTopic === ethers.id(arweaveHash),
      'arweaveHashTopic is keccak256 of the hash'
    );
    assert(Boolean(row.litEncryptedKeyId && row.encryptionIv && row.encryptionAuthTag), 'key material persisted');
    assert(row.onChainTxHash === body.registration.txHash, 'registration tx recorded on the row');
  }

  // --- On-chain ---
  const { library } = getContracts();
  const onChain = await library.getUpload(arweaveHash);
  assert(onChain.uploader.toLowerCase() === ARCHIVIST.toLowerCase(), 'chain records the ARCHIVIST as uploader');
  assert(Number(onChain.status) === 0, 'chain status is Pending (0)');
  const meta = JSON.parse(onChain.metadata);
  assert(meta.t === title, 'on-chain metadata carries the title');

  // --- Read endpoints ---
  const lookup = await (await fetch(`${BASE}/api/upload/${arweaveHash}`)).json();
  assert(lookup.arweaveHash === arweaveHash, 'GET /api/upload/:hash returns the book');
  assert(lookup.litEncryptedKeyId === undefined, 'public lookup does NOT leak key material');

  const stake = await (await fetch(`${BASE}/api/stake/status/${arweaveHash}`)).json();
  assert(stake.registered === true, 'GET /api/stake/status sees the on-chain registration');
  assert(stake.staked === false, 'not staked yet — that is the archivist’s next step');

  const params = await (await fetch(`${BASE}/api/rental/decrypt-params/${arweaveHash}/${ARCHIVIST}`)).json();
  assert(params.grantedVia === 'uploader', 'uploader carve-out grants decrypt params without a rental');
  assert(Boolean(params.litEncryptedKeyId && params.encryptionIv && params.encryptionAuthTag), 'decrypt payload is complete');

  const stranger = await fetch(`${BASE}/api/rental/decrypt-params/${arweaveHash}/0x2222222222222222222222222222222222222222`);
  assert(stranger.status === 403, 'a stranger without a rental is refused', `got ${stranger.status}`);

  // --- Gateway ---
  console.log('  waiting for gateway propagation...');
  const stored = await fetchFromGateway(arweaveHash);
  assert(stored !== null, 'ciphertext retrievable from the gateway');
  if (stored) {
    assert(!stored.equals(pdf), 'stored bytes are not the plaintext PDF');
    assert(
      stored.length === pdf.length,
      'ciphertext length matches plaintext (AES-GCM does not pad)',
      `${stored.length} vs ${pdf.length}`
    );
  }

  // --- Event listener ---
  // The listener resolves the keccak topic back to this hash via
  // Upload.arweaveHashTopic, which is the whole reason that column exists.
  console.log('  waiting for the event listener to see UploadRegistered...');
  let event = null;
  for (let i = 0; i < 24; i++) {
    event = await prisma.event.findFirst({ where: { arweaveHash, eventName: 'UploadRegistered' } });
    if (event) break;
    await sleep(5000);
  }
  assert(Boolean(event), 'event listener recorded UploadRegistered');
  if (event) {
    assert(event.arweaveHash === arweaveHash, 'listener resolved the keccak topic back to the plaintext hash');
    assert(event.transactionHash === body.registration.txHash, 'event matches the registration transaction');
  }

  await prisma.$disconnect();
  return arweaveHash;
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nAlexandria smoke test — ${FULL ? 'FULL (writes on-chain)' : 'storage only'}\n`);

  const storedHash = await storageIntegrity();

  let e2eHash = null;
  if (FULL) {
    e2eHash = await fullPipeline();
  } else {
    console.log('\n  (skipping Part B — pass --full to run the on-chain pipeline)');
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`RESULT: ${failed === 0 ? 'ALL PASSED ✓' : 'FAILURES ✗'}   passed ${passed}, failed ${failed}`);
  if (storedHash) console.log(`  storage test : https://gateway.irys.xyz/${storedHash}`);
  if (e2eHash) console.log(`  end-to-end   : https://gateway.irys.xyz/${e2eHash}`);
  console.log(`${'='.repeat(64)}\n`);

  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
