// Manual Phase 3 verification: two-layer encryption (AES-256-GCM + Lit PKP).
//
// Run on a machine with unrestricted internet access:
//
//   node tests/encryption.manual.js
//
// Prerequisites:
//   1. Create a Lit Chipotle account at dashboard.chipotle.litprotocol.com
//   2. Mint a PKP wallet via the dashboard
//   3. Set LIT_API_KEY and LIT_PKP_ID in your .env
//
// Expected: prints AES ciphertext stats + Lit-encrypted key + hash, then "RESULT: OK".

require('dotenv').config();

const { LIT_API_URL, LIT_API_KEY, LIT_PKP_ID } = require('../config/lit');
const { generateSymmetricKey, aesEncrypt, encryptKeyWithLit, encryptPdf } = require('../controller/litProtocol');

// ── Pre-flight checks ────────────────────────────────────────────────────────

function preflight() {
  const missing = [];
  if (!LIT_API_KEY) missing.push('LIT_API_KEY');
  if (!LIT_PKP_ID) missing.push('LIT_PKP_ID');
  if (missing.length) {
    console.error(`\nMissing env vars: ${missing.join(', ')}`);
    console.error('Set them in .env — see .env.example for guidance.\n');
    process.exit(2);
  }
}

// ── Guard timer ──────────────────────────────────────────────────────────────

const guard = setTimeout(() => {
  console.error('TIMEOUT after 90s — is api.chipotle.litprotocol.com reachable?');
  process.exit(2);
}, 90000);

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    preflight();

    console.log('=== Phase 3 Encryption Test (Chipotle v3 REST API) ===\n');
    console.log('Lit API URL:', LIT_API_URL);
    console.log('PKP ID:     ', LIT_PKP_ID);

    // --- Layer 1: Local AES-256-GCM ---
    console.log('\n--- Layer 1: AES-256-GCM (local) ---');

    const pdf = Buffer.from(
      '%PDF-1.4\nsample content for the Phase 3 encryption test\n%%EOF',
      'latin1'
    );
    console.log(`Input PDF: ${pdf.length} bytes`);

    const key = generateSymmetricKey();
    console.log(`Symmetric key: ${key.length} bytes (${key.length * 8}-bit)`);

    const { ciphertext: aesCiphertext, iv, authTag } = aesEncrypt(pdf, key);
    console.log(`AES ciphertext: ${aesCiphertext.length} bytes`);
    console.log(`IV: ${iv.toString('hex')} (${iv.length} bytes)`);
    console.log(`Auth tag: ${authTag.toString('hex')} (${authTag.length} bytes)`);

    // Verify AES decryption roundtrip locally
    const crypto = require('crypto');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(aesCiphertext), decipher.final()]);
    const aesOk = decrypted.equals(pdf);
    console.log(`AES roundtrip: ${aesOk ? 'OK ✓' : 'FAILED ✗'}`);

    if (!aesOk) {
      throw new Error('AES-256-GCM roundtrip failed — decrypted data does not match input.');
    }

    // --- Layer 2: Lit PKP encryption of the symmetric key ---
    console.log('\n--- Layer 2: Lit PKP Encryption (TEE via REST) ---');
    console.log('Encrypting 32-byte symmetric key via Lit Action ...');

    const t0 = Date.now();
    const { encryptedSymmetricKey, dataToEncryptHash } = await encryptKeyWithLit(key);
    console.log(`Done in ${Date.now() - t0}ms`);

    console.log(`Encrypted key (head): ${String(encryptedSymmetricKey).slice(0, 48)}...`);
    console.log(`Encrypted key length: ${String(encryptedSymmetricKey).length}`);
    console.log(`dataToEncryptHash:    ${dataToEncryptHash}`);

    // Zero the plaintext key
    key.fill(0);

    // --- Full pipeline test ---
    console.log('\n--- Full Pipeline: encryptPdf() ---');
    const t1 = Date.now();
    const result = await encryptPdf(pdf);
    console.log(`Full pipeline done in ${Date.now() - t1}ms`);
    console.log(`encryptedPdf length:        ${result.encryptedPdf.length} (base64)`);
    console.log(`iv:                         ${result.iv}`);
    console.log(`authTag:                    ${result.authTag}`);
    console.log(`encryptedSymmetricKey head: ${String(result.encryptedSymmetricKey).slice(0, 48)}...`);
    console.log(`dataToEncryptHash:          ${result.dataToEncryptHash}`);

    // --- Final verdict ---
    const allOk =
      aesOk &&
      Boolean(encryptedSymmetricKey) &&
      Boolean(dataToEncryptHash) &&
      Boolean(result.encryptedPdf) &&
      Boolean(result.encryptedSymmetricKey) &&
      Boolean(result.dataToEncryptHash);

    console.log(`\nRESULT: ${allOk ? 'OK ✓' : 'FAILED ✗'}`);
    console.log(
      `  AES-256-GCM local:  ${aesOk ? 'PASS' : 'FAIL'}`,
      `\n  Lit PKP encrypt:    ${encryptedSymmetricKey ? 'PASS' : 'FAIL'}`,
      `\n  Full pipeline:      ${result.encryptedPdf ? 'PASS' : 'FAIL'}`
    );
    process.exitCode = allOk ? 0 : 1;
  } catch (err) {
    console.error('\nFAILED:', err.message);
    if (err.cause) console.error('Cause:', err.cause);
    process.exitCode = 1;
  } finally {
    clearTimeout(guard);
    process.exit(process.exitCode || 0);
  }
})();
