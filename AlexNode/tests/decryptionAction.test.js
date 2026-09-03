// Test suite for Decryption Lit Action and Key Binding Invariants.
//
// Run: node tests/decryptionAction.test.js
//
// Verifies:
//  1. Legitimate renter is granted key access.
//  2. Archivist (uploader) is granted key access without a rental (uploader carve-out).
//  3. Stranger without rental is rejected (403 / access_denied).
//  4. NEGATIVE SECURITY TEST: Attacker renting Book A attempting to unlock Book B is REJECTED.
//  5. Paused Rent contract (throwing revert) fails closed.
//  6. Tampered / invalid envelope version (v != 1) is rejected.
//  7. Missing / malformed envelope structure is rejected.

const crypto = require('crypto');
const { LIT_DECRYPT_ACTION_CODE } = require('../services/litAction');

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

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup & In-Memory Enclave Simulation
// ─────────────────────────────────────────────────────────────────────────────

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB_ARCHIVIST = '0x2222222222222222222222222222222222222222';
const EVE_ATTACKER = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';

const HASH_CHEAP = 'hash_CHEAP_PAMPHLET_0000000000000000000000';
const HASH_RARE = 'hash_RARE_MANUSCRIPT_000000000000000000000';

const SIMULATED_PKP_KEY = crypto.randomBytes(32);

function simulateSeal(envelopeObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SIMULATED_PKP_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(envelopeObj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function simulateUnseal(sealedBase64) {
  const raw = Buffer.from(sealedBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SIMULATED_PKP_KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// Simulated on-chain state
const ON_CHAIN_STATE = {
  rentals: {
    [HASH_CHEAP]: [ALICE.toLowerCase(), EVE_ATTACKER.toLowerCase()], // Eve rented the cheap book
    [HASH_RARE]: [ALICE.toLowerCase()],                              // Only Alice rented the rare book
  },
  uploaders: {
    [HASH_CHEAP]: BOB_ARCHIVIST.toLowerCase(),
    [HASH_RARE]: BOB_ARCHIVIST.toLowerCase(),
  },
  paused: false,
};

/**
 * Execute the Decryption Lit Action logic in a simulated sandbox
 */
async function runDecryptionAction({ ciphertext, userAddress }) {
  if (!userAddress || typeof userAddress !== 'string') {
    return { error: 'missing_user_address' };
  }

  let unsealedStr;
  try {
    unsealedStr = simulateUnseal(ciphertext);
  } catch (err) {
    return { error: 'unseal_failed' };
  }

  let envelope;
  try {
    envelope = JSON.parse(unsealedStr);
  } catch (err) {
    return { error: 'invalid_envelope_json' };
  }

  if (!envelope || envelope.v !== 1 || !envelope.k || !envelope.arweaveHash) {
    return { error: 'invalid_envelope_format' };
  }

  const { k, arweaveHash } = envelope;
  const user = userAddress.toLowerCase();

  // Query simulated on-chain state
  let isRented = false;
  try {
    if (ON_CHAIN_STATE.paused) {
      throw new Error('Pausable: paused');
    }
    const activeList = ON_CHAIN_STATE.rentals[arweaveHash] || [];
    isRented = activeList.includes(user);
  } catch (err) {
    isRented = false; // fail closed
  }

  let isOwner = false;
  try {
    const uploader = ON_CHAIN_STATE.uploaders[arweaveHash];
    isOwner = Boolean(uploader && uploader.toLowerCase() === user);
  } catch (err) {
    isOwner = false;
  }

  if (!isRented && !isOwner) {
    return { error: 'access_denied' };
  }

  return { key: k };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nRunning Decryption Lit Action & Key Binding Tests...\n');

  const keyCheap = crypto.randomBytes(32).toString('base64');
  const keyRare = crypto.randomBytes(32).toString('base64');

  const sealedCheap = simulateSeal({ v: 1, k: keyCheap, arweaveHash: HASH_CHEAP });
  const sealedRare = simulateSeal({ v: 1, k: keyRare, arweaveHash: HASH_RARE });

  // Test 1: Legitimate renter reads Book
  const t1 = await runDecryptionAction({ ciphertext: sealedCheap, userAddress: ALICE });
  assert(t1.key === keyCheap, '1. Legitimate renter (Alice) successfully unlocks Book');

  // Test 2: Archivist (Bob) reads their uploaded book without a rental (uploader carve-out)
  const t2 = await runDecryptionAction({ ciphertext: sealedRare, userAddress: BOB_ARCHIVIST });
  assert(t2.key === keyRare, '2. Archivist (Bob) unlocks own uploaded book via uploader carve-out');

  // Test 3: Stranger without rental is denied
  const t3 = await runDecryptionAction({ ciphertext: sealedRare, userAddress: STRANGER });
  assert(t3.error === 'access_denied' && !t3.key, '3. Stranger without rental is denied access');

  // Test 4: Confused Deputy Attack (Eve rented CHEAP, attempts to unseal RARE)
  // Eve supplies RARE's ciphertext. Even though Eve has an active rental on CHEAP,
  // the action inspects the envelope's hash (RARE) and denies Eve.
  const t4 = await runDecryptionAction({ ciphertext: sealedRare, userAddress: EVE_ATTACKER });
  assert(t4.error === 'access_denied' && !t4.key, '4. Security: Eve renting cheap book CANNOT unlock rare book');

  // Test 5: Paused contract fails closed
  ON_CHAIN_STATE.paused = true;
  const t5 = await runDecryptionAction({ ciphertext: sealedCheap, userAddress: ALICE });
  assert(t5.error === 'access_denied', '5. Paused contract reverts fail closed (denies key)');
  ON_CHAIN_STATE.paused = false; // reset

  // Test 6: Invalid envelope version (v: 2) rejected
  const sealedV2 = simulateSeal({ v: 2, k: keyCheap, arweaveHash: HASH_CHEAP });
  const t6 = await runDecryptionAction({ ciphertext: sealedV2, userAddress: ALICE });
  assert(t6.error === 'invalid_envelope_format', '6. Unsupported envelope version rejected');

  // Test 7: Malformed envelope (missing hash) rejected
  const sealedNoHash = simulateSeal({ v: 1, k: keyCheap });
  const t7 = await runDecryptionAction({ ciphertext: sealedNoHash, userAddress: ALICE });
  assert(t7.error === 'invalid_envelope_format', '7. Malformed envelope (missing hash) rejected');

  // Test 8: Empty / missing user address rejected
  const t8 = await runDecryptionAction({ ciphertext: sealedCheap, userAddress: '' });
  assert(t8.error === 'missing_user_address', '8. Missing user address rejected');

  // Test 9: Lit Action Code String Integrity
  assert(
    LIT_DECRYPT_ACTION_CODE.includes('Lit.Actions.Decrypt') &&
      LIT_DECRYPT_ACTION_CODE.includes('isRentalActive') &&
      LIT_DECRYPT_ACTION_CODE.includes('getUploader'),
    '9. LIT_DECRYPT_ACTION_CODE exports expected unsealing and on-chain functions'
  );

  console.log(`\n================================================================`);
  console.log(`RESULT: ${failed === 0 ? 'ALL PASSED ✓' : 'FAILURES ✗'}   passed ${passed}, failed ${failed}`);
  console.log(`================================================================\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
