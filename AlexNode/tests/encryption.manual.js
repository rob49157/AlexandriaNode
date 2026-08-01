// Manual Phase 3 verification: connect to Lit + encrypt a sample buffer.
//
// Run this on a machine with unrestricted internet (the CI/dev sandbox blocks
// egress to *.litprotocol.com, so it can only be verified locally):
//
//   node tests/encryption.manual.js
//
// Expected: prints a base64 ciphertext + a dataToEncryptHash, then "RESULT: OK".
// Encryption is free and keyless on datil-dev — no wallet or funds required.

require('dotenv').config();
process.env.LIT_NETWORK = process.env.LIT_NETWORK || 'datil-dev';
// Placeholder rental contract + hash — encryption embeds the access condition
// but never calls the contract, so real values aren't needed to prove encryption.
process.env.RENT_CONTRACT_ADDRESS =
  process.env.RENT_CONTRACT_ADDRESS || '0x1111111111111111111111111111111111111111';

const { encryptForRental, buildRentalAccessControlConditions } = require('../controller/litProtocol');
const { disconnectLit } = require('../config/lit');

const guard = setTimeout(() => {
  console.error('TIMEOUT after 90s — is *.litprotocol.com reachable from this network?');
  process.exit(2);
}, 90000);

(async () => {
  try {
    console.log('Network:', process.env.LIT_NETWORK);
    console.log('ACC:', JSON.stringify(buildRentalAccessControlConditions('placeholder-arweave-hash')[0]));

    const pdf = Buffer.from('%PDF-1.4\nsample content for the Phase 3 encryption test\n%%EOF', 'latin1');
    console.log(`Encrypting ${pdf.length} bytes ...`);

    const t0 = Date.now();
    const { ciphertext, dataToEncryptHash } = await encryptForRental(pdf, 'placeholder-arweave-hash');

    console.log(`\nDone in ${Date.now() - t0}ms`);
    console.log('ciphertext (head):', ciphertext.slice(0, 48) + '...');
    console.log('ciphertext length:', ciphertext.length);
    console.log('dataToEncryptHash:', dataToEncryptHash);

    const ok = Boolean(ciphertext) && Boolean(dataToEncryptHash);
    console.log(`\nRESULT: ${ok ? 'OK' : 'FAILED'} — ciphertext=${!!ciphertext} hash=${!!dataToEncryptHash}`);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(guard);
    await disconnectLit().catch(() => {});
    process.exit(process.exitCode || 0);
  }
})();
