// Phase 5 test: full upload orchestration — encrypt → sign → seal → upload → persist.
//
// Run: node tests/uploadFlow.test.js
//
// External services (Irys, Lit, Postgres) are stubbed by replacing their config
// modules in require.cache before the controller is loaded. Layers 1/2/3/5 run
// for real against a fake Prisma client, so validation is genuinely exercised.
//
// Tests:
//   1. Happy path returns 201 { arweaveHash, litEncryptedKeyId }
//   2. Persisted row carries all four simHashBand* columns
//   3. AES-GCM roundtrip: stored ciphertext decrypts back to the original PDF
//   4. The sealed Lit envelope is bound to the arweaveHash
//   5. Lit failure → 502, nothing pushed to Arweave, nothing persisted
//   6. Irys push failure → 502, nothing persisted
//   7. Postgres failure after push → 500 + [ORPHAN] log carrying the hash
//   8. Exact duplicate → 409 with zero Lit/Irys calls (no spend)
//   9. Near-duplicate → persists with isNearDuplicate + nearDuplicateOf
//  10. arweaveHash is base64url (43 chars), never the SDK's base58 id

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');

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

// ─────────────────────────────────────────────────────────────────────────────
// Stub installation — must happen before the controller is required
// ─────────────────────────────────────────────────────────────────────────────

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    path: path.dirname(resolved),
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return exports;
}

const toBase64Url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// --- Fake Postgres ---
const db = { rows: [], failCreate: false };

stub('../config/db', {
  upload: {
    findUnique: async ({ where }) =>
      db.rows.find((r) => r.sha256Hash === where.sha256Hash) || null,
    // The real query filters on the indexed band columns; the JS verification
    // pass in dedup.service re-checks Hamming distance regardless, so returning
    // every row here is a looser prefilter with an identical outcome.
    findMany: async () => db.rows,
    create: async ({ data }) => {
      if (db.failCreate) throw new Error('simulated Neon outage');
      db.rows.push(data);
      return data;
    },
  },
  $connect: async () => {},
  $disconnect: async () => {},
});

// --- Fake Lit ---
const lit = { calls: 0, fail: false, lastMessage: null };

stub('../config/lit', {
  LIT_PKP_ID: 'pkp_test_0001',
  LIT_API_KEY: 'test-key',
  LIT_API_URL: 'https://api.test.invalid/core/v1',
  disconnectLit: async () => {},
  litApiCall: async (_endpoint, body) => {
    lit.calls++;
    if (lit.fail) throw new Error('simulated Lit outage');
    lit.lastMessage = body.js_params.message;
    return {
      has_error: false,
      response: JSON.stringify({
        ciphertext: 'SEALED::' + crypto.createHash('sha256').update(lit.lastMessage).digest('hex'),
        dataToEncryptHash: 'dth_' + crypto.randomBytes(8).toString('hex'),
      }),
    };
  },
});

// --- Fake Irys ---
const irys = {
  prepared: 0,
  committed: 0,
  fail: null,
  lastCiphertext: null,
  lastTags: null,
  // When set, the fake node reports a different id than the one we derived —
  // simulating the id-encoding trap actually biting in production.
  receiptIdOverride: null,
};

stub('../config/irys', {
  IRYS_NETWORK: 'devnet',
  IRYS_GATEWAY_URL: 'https://gateway.test.invalid',
  getBalance: async () => ({ atomic: '0', network: 'devnet', address: '0xtest' }),
  getPrice: async () => '0',
  getIrys: async () => ({
    address: '0xtestwallet',
    createTransaction(data, opts) {
      if (irys.fail === 'prepare') throw new Error('simulated Irys outage');
      irys.prepared++;
      irys.lastCiphertext = Buffer.from(data);
      irys.lastTags = opts.tags;

      // Real data items derive rawId as sha256(signature). Any deterministic
      // 32-byte value stands in — what matters is that the id is fixed at
      // signing time and that commitUpload's receipt check sees a match.
      const rawId = crypto.createHash('sha256').update(data).digest();

      return {
        rawId,
        get id() {
          // Mirrors the SDK's base58 getter, so test 10 fails if the production
          // code ever reads tx.id instead of deriving base64url from rawId.
          return 'BASE58_' + rawId.toString('hex').slice(0, 20);
        },
        async sign() {
          return Buffer.alloc(64);
        },
        async upload() {
          if (irys.fail === 'commit') throw new Error('simulated Irys push failure');
          irys.committed++;
          return {
            id: irys.receiptIdOverride !== null ? irys.receiptIdOverride : toBase64Url(rawId),
            timestamp: Date.now(),
          };
        },
      };
    },
  }),
});

// --- Validation: real by default, overridable for cases that need exotic state ---
const realValidation = require('../services/validation.service');
let validateOverride = null;

stub('../services/validation.service', {
  ...realValidation,
  validateUpload: async (file, body) =>
    validateOverride ? validateOverride(file, body) : realValidation.validateUpload(file, body),
});

const { createUpload } = require('../controller/upload.controller');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePdf(extraContent = '') {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
      extraContent,
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

const METADATA = {
  title: 'On the Origin of Species',
  author: 'Charles Darwin',
  category: 'science',
  description: 'A foundational work of evolutionary biology, published 1859.',
};

function mockReq(pdf, metadata = METADATA) {
  return {
    // Fresh copy every call — the controller zeroes this buffer.
    file: {
      originalname: 'book.pdf',
      mimetype: 'application/pdf',
      size: pdf.length,
      buffer: Buffer.from(pdf),
    },
    body: { ...metadata },
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
  };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function runUpload(req) {
  const res = mockRes();
  let nextErr = null;
  await createUpload(req, res, (e) => {
    nextErr = e;
  });
  if (nextErr) throw nextErr;
  return res;
}

function resetState() {
  db.rows = [];
  db.failCreate = false;
  lit.calls = 0;
  lit.fail = false;
  lit.lastMessage = null;
  irys.prepared = 0;
  irys.committed = 0;
  irys.fail = null;
  irys.lastCiphertext = null;
  irys.lastTags = null;
  irys.receiptIdOverride = null;
  validateOverride = null;
}

const tagValue = (name) => (irys.lastTags.find((t) => t.name === name) || {}).value;

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const pdf = makePdf();

  // ── 1. Happy path ────────────────────────────────────────────────────────
  console.log('\n=== Happy path ===\n');
  resetState();
  const okRes = await runUpload(mockReq(pdf));

  assert(okRes.statusCode === 201, `Successful upload returns 201 (got ${okRes.statusCode})`);
  assert(Boolean(okRes.body && okRes.body.arweaveHash), 'Response carries arweaveHash');
  assert(Boolean(okRes.body && okRes.body.litEncryptedKeyId), 'Response carries litEncryptedKeyId');
  assert(okRes.body.status === 'pending_stake', 'Status is pending_stake');
  assert(irys.committed === 1, 'Exactly one Arweave push occurred');
  assert(db.rows.length === 1, 'Exactly one Postgres row written');

  // ── 2. Band columns persisted ────────────────────────────────────────────
  console.log('\n=== Banded-LSH columns ===\n');
  const row = db.rows[0];
  const bandsPresent = [0, 1, 2, 3].every((i) => typeof row[`simHashBand${i}`] === 'number');
  assert(bandsPresent, 'All four simHashBand* columns are written');
  assert(typeof row.simHash === 'string', 'simHash is persisted alongside its bands');

  // ── 3. AES roundtrip ─────────────────────────────────────────────────────
  console.log('\n=== Encryption roundtrip ===\n');
  // The key is recovered from the sealed envelope the fake Lit captured — the
  // controller zeroes its own copy, which is exactly the behaviour we want.
  const envelope = JSON.parse(lit.lastMessage);
  const recoveredKey = Buffer.from(envelope.k, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    recoveredKey,
    Buffer.from(tagValue('Encryption-IV'), 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagValue('Encryption-Auth-Tag'), 'base64'));
  const decrypted = Buffer.concat([decipher.update(irys.lastCiphertext), decipher.final()]);

  assert(decrypted.equals(pdf), 'Stored ciphertext decrypts back to the original PDF byte-for-byte');
  assert(!irys.lastCiphertext.equals(pdf), 'What Arweave received is not the plaintext');
  assert(
    row.encryptionIv === tagValue('Encryption-IV') &&
      row.encryptionAuthTag === tagValue('Encryption-Auth-Tag'),
    'Postgres IV/authTag match the Arweave tags'
  );

  // ── 4. Envelope binding ──────────────────────────────────────────────────
  console.log('\n=== Key/hash binding ===\n');
  assert(
    envelope.arweaveHash === okRes.body.arweaveHash,
    'Sealed envelope is bound to the returned arweaveHash'
  );
  assert(envelope.v === 1, 'Envelope carries a version field');
  assert(recoveredKey.length === 32, 'Sealed key is 32 bytes');

  // ── 10. Hash encoding ────────────────────────────────────────────────────
  console.log('\n=== arweaveHash encoding ===\n');
  const hash = okRes.body.arweaveHash;
  assert(/^[A-Za-z0-9_-]{43}$/.test(hash), `arweaveHash is 43-char base64url (got "${hash}")`);
  assert(!hash.startsWith('BASE58_'), 'arweaveHash is NOT the SDK base58 tx.id');

  // ── 11. Receipt mismatch is caught, not persisted ────────────────────────
  // This is the guard that turns the base58/base64url trap from a silent
  // corruption into a loud failure. If the derived hash and the node's id ever
  // diverge, the sealed key names a different object than the one stored.
  console.log('\n=== Receipt id mismatch guard ===\n');
  resetState();
  irys.receiptIdOverride = 'BASE58_ThisIsTheWrongEncodingEntirely00000';
  const mismatchRes = await runUpload(mockReq(pdf));

  assert(
    mismatchRes.statusCode === 502,
    `Receipt/derived hash mismatch is rejected (got ${mismatchRes.statusCode})`
  );
  assert(db.rows.length === 0, 'No row persisted when the stored id disagrees with the sealed hash');

  // Sanity: the guard is not simply always-on — the happy path still passes it.
  resetState();
  const guardOkRes = await runUpload(mockReq(pdf));
  assert(guardOkRes.statusCode === 201, 'Matching receipt id still passes the guard');

  // ── 5. Lit failure ───────────────────────────────────────────────────────
  console.log('\n=== Failure: Lit unavailable ===\n');
  resetState();
  lit.fail = true;
  const litRes = await runUpload(mockReq(pdf));

  assert(litRes.statusCode === 502, `Lit failure returns 502 (got ${litRes.statusCode})`);
  assert(litRes.body.reason === 'lit_unavailable', 'Reason is lit_unavailable');
  assert(irys.committed === 0, 'No Arweave push — nothing was paid for');
  assert(db.rows.length === 0, 'No Postgres row written');

  // ── 6. Irys push failure ─────────────────────────────────────────────────
  console.log('\n=== Failure: Arweave push ===\n');
  resetState();
  irys.fail = 'commit';
  const irysRes = await runUpload(mockReq(pdf));

  assert(irysRes.statusCode === 502, `Irys failure returns 502 (got ${irysRes.statusCode})`);
  assert(irysRes.body.reason === 'arweave_upload_failed', 'Reason is arweave_upload_failed');
  assert(db.rows.length === 0, 'No Postgres row written');

  // ── 7. Postgres failure after a paid push ────────────────────────────────
  console.log('\n=== Failure: index write after paid upload ===\n');
  resetState();
  db.failCreate = true;

  const errorLines = [];
  const realError = console.error;
  console.error = (...args) => errorLines.push(args.join(' '));
  const orphanRes = await runUpload(mockReq(pdf));
  console.error = realError;

  assert(orphanRes.statusCode === 500, `Post-push DB failure returns 500 (got ${orphanRes.statusCode})`);
  assert(Boolean(orphanRes.body.arweaveHash), 'Response still carries the arweaveHash for recovery');
  assert(irys.committed === 1, 'The Arweave push did happen (this is the lossy case)');
  const orphanLog = errorLines.find((l) => l.includes('[ORPHAN]'));
  assert(Boolean(orphanLog), 'An [ORPHAN] line was logged');
  assert(
    Boolean(orphanLog && orphanLog.includes(orphanRes.body.arweaveHash)),
    'The [ORPHAN] log contains the arweaveHash needed to rebuild the row'
  );

  // ── 8. Exact duplicate short-circuits before any spend ───────────────────
  console.log('\n=== Deduplication: exact duplicate ===\n');
  resetState();
  const { computeSha256 } = require('../services/dedup.service');
  db.rows.push({
    arweaveHash: 'PreExistingHash0000000000000000000000000000',
    title: 'Already Archived',
    sha256Hash: computeSha256(pdf),
    simHash: '0000000000000000',
  });

  const dupRes = await runUpload(mockReq(pdf));
  assert(dupRes.statusCode === 409, `Exact duplicate returns 409 (got ${dupRes.statusCode})`);
  assert(dupRes.body.reason === 'exact_duplicate', 'Reason is exact_duplicate');
  assert(lit.calls === 0, 'Lit was never called — no key sealed for a duplicate');
  assert(irys.prepared === 0 && irys.committed === 0, 'Irys was never touched — nothing spent');

  // ── 9. Near-duplicate persists with its flag ─────────────────────────────
  console.log('\n=== Deduplication: near-duplicate flag ===\n');
  resetState();
  // The minimal test PDF has no extractable text, so its SimHash is all zeros
  // and the near-dup path short-circuits. Drive the controller directly with a
  // validation result that reports a near match; the distance maths itself is
  // covered by securityAndDedup.test.js.
  validateOverride = async () => ({
    valid: true,
    pageCount: 1,
    metadata: { ...METADATA },
    sha256Hash: crypto.randomBytes(32).toString('hex'),
    simHash: 'ffffffffffffffff',
    simHashBands: {
      simHashBand0: 65535,
      simHashBand1: 65535,
      simHashBand2: 65535,
      simHashBand3: 65535,
    },
    isNearDuplicate: true,
    nearDuplicateMatches: [
      { arweaveHash: 'NeighbourHash000000000000000000000000000000', title: 'A Close Match', distance: 2, similarity: 96.9 },
    ],
    clamavSkipped: true,
  });

  const nearRes = await runUpload(mockReq(pdf));
  assert(nearRes.statusCode === 201, 'Near-duplicate is accepted, not rejected');
  assert(nearRes.body.isNearDuplicate === true, 'Response flags the near-duplicate');
  assert(db.rows[0].isNearDuplicate === true, 'Row persists isNearDuplicate = true');
  assert(
    db.rows[0].nearDuplicateOf === 'NeighbourHash000000000000000000000000000000',
    'Row records which upload it resembles'
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${failed === 0 ? 'ALL PASSED ✓' : 'SOME FAILED ✗'}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
