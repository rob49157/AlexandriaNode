// Lit Protocol encryption for validated PDFs — two-layer envelope encryption.
//
// Layer 1 (local):  AES-256-GCM encrypts the raw PDF with a random symmetric key.
// Layer 2 (Lit):    The symmetric key is encrypted by a PKP inside a Lit Chipotle
//                   TEE via Lit.Actions.Encrypt. Only permitted Lit Actions on this
//                   PKP can recover the key (decryption is a Phase 5+ / frontend concern).
//
// This design keeps large PDF payloads out of the TEE (only the 32-byte key travels
// over the network) and decouples access control from encryption time:
//   • Old Datil: JSON-based ACCs (isRentalActive) baked into the ciphertext at encrypt.
//   • Chipotle:  Access gating lives in the *decryption* Lit Action (JS in TEE).
//                The backend only encrypts — it is never in the decryption path.
//
// Returns { encryptedPdf, iv, authTag, encryptedSymmetricKey, dataToEncryptHash }
//   • encryptedPdf + iv + authTag  → stored on Arweave via Irys
//   • encryptedSymmetricKey + dataToEncryptHash → persisted to Postgres
//     (dataToEncryptHash is the "litEncryptedKeyId" referenced elsewhere)

const crypto = require('crypto');
const { litApiCall, LIT_PKP_ID } = require('../config/lit');

// ──────────────────────────────────────────────────────────────────────────────
// Layer 1: Local AES-256-GCM encryption
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 256-bit symmetric key.
 * @returns {Buffer} 32-byte key
 */
function generateSymmetricKey() {
  return crypto.randomBytes(32);
}

/**
 * Encrypt a buffer with AES-256-GCM.
 *
 * @param {Buffer} plaintext  — raw data (PDF bytes from multer memoryStorage)
 * @param {Buffer} key        — 32-byte symmetric key
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }}
 */
function aesEncrypt(plaintext, key) {
  const iv = crypto.randomBytes(12); // 96-bit IV per NIST recommendation
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 128-bit tag

  return { ciphertext: encrypted, iv, authTag };
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer 2: Lit Protocol PKP encryption of the symmetric key
// ──────────────────────────────────────────────────────────────────────────────

// The Lit Action JS that runs inside the TEE.
// Chipotle uses Lit.Actions.Encrypt (capital E) with { pkpId, message }.
// Chipotle injects js_params as arguments to the main() function.
// MUST exactly match the code registered via scripts/lit-setup.js so the
// IPFS CID the API derives matches the one permitted in the group.
const LIT_ENCRYPT_ACTION_CODE = [
  'async function main({ pkpId, message }) {',
  '  const result = await Lit.Actions.Encrypt({ pkpId, message });',
  '  Lit.Actions.setResponse({ response: JSON.stringify(result) });',
  '}',
].join('\n');

/**
 * Encrypt the symmetric key via Lit Chipotle REST API.
 *
 * Calls POST /lit_action with inline JS that invokes Lit.Actions.Encrypt
 * inside the TEE using the configured PKP.
 *
 * @param {Buffer} symmetricKey  — 32-byte AES key to protect
 * @returns {Promise<{ encryptedSymmetricKey: string, dataToEncryptHash: string }>}
 */
async function encryptKeyWithLit(symmetricKey) {
  if (!LIT_PKP_ID) {
    throw new Error(
      'LIT_PKP_ID is not set. Mint a PKP at dashboard.chipotle.litprotocol.com and add it to .env.'
    );
  }
  if (!Buffer.isBuffer(symmetricKey) || symmetricKey.length !== 32) {
    throw new Error('encryptKeyWithLit requires a 32-byte Buffer.');
  }

  // Encode key as base64 for JSON transport into the Lit Action
  const keyBase64 = symmetricKey.toString('base64');

  const litResponse = await litApiCall('/lit_action', {
    code: LIT_ENCRYPT_ACTION_CODE,
    js_params: {
      pkpId: LIT_PKP_ID,
      message: keyBase64,
    },
  });

  if (litResponse.has_error) {
    throw new Error(`Lit Action encryption failed: ${litResponse.logs || litResponse.response}`);
  }

  let encryptedSymmetricKey;
  let dataToEncryptHash;

  if (typeof litResponse.response === 'string') {
    try {
      const parsed = JSON.parse(litResponse.response);
      if (typeof parsed === 'object' && parsed !== null) {
        encryptedSymmetricKey = parsed.ciphertext || parsed.encryptedSymmetricKey || litResponse.response;
        dataToEncryptHash = parsed.dataToEncryptHash;
      } else {
        encryptedSymmetricKey = parsed;
      }
    } catch {
      encryptedSymmetricKey = litResponse.response;
    }
  } else if (typeof litResponse.response === 'object' && litResponse.response !== null) {
    encryptedSymmetricKey = litResponse.response.ciphertext || litResponse.response.encryptedSymmetricKey;
    dataToEncryptHash = litResponse.response.dataToEncryptHash;
  }

  if (!dataToEncryptHash) {
    // SHA-256 hash of the symmetric key payload (litEncryptedKeyId)
    dataToEncryptHash = crypto.createHash('sha256').update(symmetricKey).digest('hex');
  }

  if (!encryptedSymmetricKey || !dataToEncryptHash) {
    throw new Error(
      `Lit encryption returned incomplete result: ciphertext=${!!encryptedSymmetricKey} hash=${!!dataToEncryptHash}`
    );
  }

  return { encryptedSymmetricKey, dataToEncryptHash };
}

// ──────────────────────────────────────────────────────────────────────────────
// Combined two-layer encryption
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Encrypt a PDF buffer using two-layer envelope encryption.
 *
 * 1. Generate random AES-256 key
 * 2. AES-256-GCM encrypt the PDF locally (fast, no network)
 * 3. Encrypt the AES key via Lit PKP in TEE (small network call)
 *
 * @param {Buffer} pdfBuffer — raw PDF bytes
 * @returns {Promise<{
 *   encryptedPdf: string,           // base64-encoded AES ciphertext
 *   iv: string,                      // base64-encoded 12-byte IV
 *   authTag: string,                 // base64-encoded 16-byte auth tag
 *   encryptedSymmetricKey: string,   // Lit-encrypted key (opaque string)
 *   dataToEncryptHash: string        // integrity hash from Lit (= litEncryptedKeyId)
 * }>}
 */
async function encryptPdf(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('encryptPdf requires a non-empty Buffer.');
  }

  // Layer 1: local AES-256-GCM
  const symmetricKey = generateSymmetricKey();
  const { ciphertext: encryptedPdfRaw, iv, authTag } = aesEncrypt(pdfBuffer, symmetricKey);

  // Layer 2: Lit PKP encrypts the symmetric key
  const { encryptedSymmetricKey, dataToEncryptHash } = await encryptKeyWithLit(symmetricKey);

  // Zero out the plaintext key from memory
  symmetricKey.fill(0);

  return {
    encryptedPdf: encryptedPdfRaw.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedSymmetricKey,
    dataToEncryptHash,
  };
}

/**
 * Convenience wrapper for the upload pipeline.
 * Kept for API compatibility — arweaveHash is no longer needed at encrypt time
 * (access control moved to the decryption Lit Action in Phase 5+).
 *
 * @param {Buffer} pdfBuffer
 * @param {string} _arweaveHash — unused in Chipotle (kept for call-site compat)
 * @returns {Promise<object>}
 */
async function encryptForRental(pdfBuffer, _arweaveHash) {
  return encryptPdf(pdfBuffer);
}

module.exports = {
  generateSymmetricKey,
  aesEncrypt,
  encryptKeyWithLit,
  encryptPdf,
  encryptForRental,
};
