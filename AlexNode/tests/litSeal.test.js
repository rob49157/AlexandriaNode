// sealKey — what gets sealed, and what gets stored about it.
//
// Run: node tests/litSeal.test.js   (or npm run test:seal)
//
// Lit is stubbed with the response shape measured live on 2026-10-17
// (KEY-BINDING.md, T1): `response` is the ciphertext alone, a bare hex string.
// What this proves:
//   1–3.  The PKP seals the full envelope { v: 1, k, arweaveHash }, with the
//         configured PKP.
//   4–6.  litDataToEncryptHash is sha256 of the SEALED envelope — the value a
//         reader signs — and never a digest of the plaintext envelope or the key.
//   7–8.  A dataToEncryptHash supplied by Lit is ignored; a missing ciphertext throws.

const path = require('path');
const crypto = require('crypto');

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

const lit = { calls: [], respond: null };

stub('../config/lit', {
  LIT_PKP_ID: '0x97ac4b09a4d7cc562e030c75f2054a9d4ce7f2d2',
  LIT_API_KEY: 'upload-key',
  litApiCall: async (endpoint, body) => {
    lit.calls.push({ endpoint, body });
    return lit.respond(body);
  },
  disconnectLit: async () => {},
});

const { sealKey } = require('../controller/litProtocol');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const ARWEAVE_HASH = '0Nefi7adj5CU0hIYhDsRF3XXT1LGAUwB4i0rfDjSMCA';

// A ciphertext shaped like the live one: plaintext + 28 bytes, as hex.
const sealedFor = (plaintext) => crypto.randomBytes(Buffer.byteLength(plaintext) + 28).toString('hex');

async function run() {
  console.log('\nsealKey');

  const key = crypto.randomBytes(32);
  let sealed;
  lit.respond = (body) => {
    sealed = sealedFor(body.js_params.message);
    return { response: sealed, logs: '', has_error: false };
  };

  const result = await sealKey(key, ARWEAVE_HASH);
  const sent = lit.calls[0].body.js_params;
  const envelope = JSON.parse(sent.message);

  assert(
    envelope.v === 1 && envelope.k === key.toString('base64') && envelope.arweaveHash === ARWEAVE_HASH,
    '1. the PKP seals { v: 1, k, arweaveHash } — the key bound to its book'
  );
  assert(sent.pkpId === '0x97ac4b09a4d7cc562e030c75f2054a9d4ce7f2d2', '2. with the configured PKP');
  assert(result.encryptedSymmetricKey === sealed, '3. the sealed envelope is returned as Lit gave it');

  assert(
    result.dataToEncryptHash === sha256(Buffer.from(sealed, 'utf8')),
    '4. litDataToEncryptHash is sha256 of the sealed envelope'
  );
  assert(
    result.dataToEncryptHash !== sha256(sent.message) && result.dataToEncryptHash !== sha256(key),
    '5. and is not a digest of the plaintext envelope, nor of the key'
  );

  // The unlock message names the sealed envelope by this same hash
  // (services/unlockAuth.service.js), so the stored value is the one readers sign.
  const { sha256Hex } = require('../services/unlockAuth.service');
  assert(
    result.dataToEncryptHash === sha256Hex(Buffer.from(sealed, 'utf8')),
    "6. it equals the sealed-key hash in a reader's unlock message"
  );

  lit.respond = (body) => ({
    response: { ciphertext: sealedFor(body.js_params.message), dataToEncryptHash: sha256(body.js_params.message) },
    has_error: false,
  });
  const wrapped = await sealKey(crypto.randomBytes(32), ARWEAVE_HASH);
  assert(
    wrapped.dataToEncryptHash === sha256(Buffer.from(wrapped.encryptedSymmetricKey, 'utf8')),
    "7. a dataToEncryptHash supplied by Lit (a plaintext hash, Datil-style) is ignored"
  );

  lit.respond = () => ({ response: { somethingElse: true }, has_error: false });
  let threw = false;
  try {
    await sealKey(crypto.randomBytes(32), ARWEAVE_HASH);
  } catch {
    threw = true;
  }
  assert(threw, '8. a response without a ciphertext throws instead of storing nothing');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
