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
//
// ─── Why the sealed payload is an envelope, not a bare key ───────────────────
// The decryption Lit Action must gate on Rent.isRentalActive(arweaveHash, user).
// If that arweaveHash arrives as a caller-supplied js_param, the gate is
// trivially bypassed: rent one cheap book, then submit *that* hash alongside a
// *different* book's ciphertext. The TEE has no way to tell they don't match.
//
// So the hash is sealed *inside* the ciphertext, as { v, k, arweaveHash }. The
// decryption Action reads it out of the decrypted plaintext and gates on that
// value, which the caller cannot forge.
//
// This is why encryption is split into two calls: the arweaveHash only exists
// once the Irys data item is signed, which happens between them.

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

// Envelope format version. Bump if the sealed JSON shape ever changes, so a
// future decryption Lit Action can tell old payloads from new ones.
const ENVELOPE_VERSION = 1;

/**
 * Build the plaintext that gets sealed by the PKP.
 *
 * Binds the symmetric key to the specific Arweave object it decrypts, so the
 * decryption Lit Action can read the hash from inside the ciphertext instead of
 * trusting a caller-supplied parameter. See the header note.
 *
 * @param {Buffer} symmetricKey — 32-byte AES key
 * @param {string} arweaveHash  — the object this key unlocks
 * @returns {string} JSON string
 */
function buildKeyEnvelope(symmetricKey, arweaveHash) {
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    k: symmetricKey.toString('base64'),
    arweaveHash,
  });
}

/**
 * Seal the symmetric key (bound to its arweaveHash) via the Lit Chipotle REST API.
 *
 * Calls POST /lit_action with inline JS that invokes Lit.Actions.Encrypt
 * inside the TEE using the configured PKP.
 *
 * @param {Buffer} symmetricKey  — 32-byte AES key to protect
 * @param {string} arweaveHash   — Arweave tx id this key decrypts; sealed into the payload
 * @returns {Promise<{ encryptedSymmetricKey: string, dataToEncryptHash: string }>}
 */
async function sealKey(symmetricKey, arweaveHash) {
  if (!LIT_PKP_ID) {
    throw new Error(
      'LIT_PKP_ID is not set. Mint a PKP at dashboard.chipotle.litprotocol.com and add it to .env.'
    );
  }
  if (!Buffer.isBuffer(symmetricKey) || symmetricKey.length !== 32) {
    throw new Error('sealKey requires a 32-byte Buffer.');
  }
  if (typeof arweaveHash !== 'string' || !arweaveHash) {
    throw new Error('sealKey requires the arweaveHash the key is bound to.');
  }

  const envelope = buildKeyEnvelope(symmetricKey, arweaveHash);

  const litResponse = await litApiCall('/lit_action', {
    code: LIT_ENCRYPT_ACTION_CODE,
    js_params: {
      pkpId: LIT_PKP_ID,
      message: envelope,
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
    // Fall back to hashing the sealed envelope, not the raw key — this value is
    // persisted to Postgres as litEncryptedKeyId, and a digest of secret key
    // material has no business living in the database.
    dataToEncryptHash = crypto.createHash('sha256').update(envelope).digest('hex');
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
 * Layer 1 only: AES-256-GCM encrypt the PDF and hand back the live key.
 *
 * The caller owns the returned symmetricKey and MUST zero it (`.fill(0)`) once
 * sealKey has consumed it. It is split out from sealKey because the upload
 * pipeline has to sign the Irys transaction in between, to learn the arweaveHash
 * that gets sealed alongside the key.
 *
 * Ciphertext comes back as a raw Buffer, not base64. Base64 would inflate the
 * Arweave payload by 33% — 33% more cost on the one path where bytes are paid
 * for permanently — and doubles peak RAM on an already memory-bound request.
 *
 * @param {Buffer} pdfBuffer — raw PDF bytes
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer, symmetricKey: Buffer }}
 */
function aesEncryptPdf(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('aesEncryptPdf requires a non-empty Buffer.');
  }

  const symmetricKey = generateSymmetricKey();
  const { ciphertext, iv, authTag } = aesEncrypt(pdfBuffer, symmetricKey);

  return { ciphertext, iv, authTag, symmetricKey };
}

/**
 * Encrypt a PDF buffer using two-layer envelope encryption, in one call.
 *
 * Convenience wrapper over aesEncryptPdf + sealKey for callers that already know
 * the arweaveHash. The upload pipeline uses the two phases directly instead,
 * because it has to sign the Irys transaction between them.
 *
 * arweaveHash is REQUIRED and has no default. An optional binding would be no
 * binding at all — the whole point is that a sealed key cannot exist without
 * naming the object it unlocks.
 *
 * @param {Buffer} pdfBuffer — raw PDF bytes
 * @param {string} arweaveHash — object this key unlocks; sealed into the payload
 * @returns {Promise<{
 *   encryptedPdf: string,           // base64-encoded AES ciphertext
 *   iv: string,                      // base64-encoded 12-byte IV
 *   authTag: string,                 // base64-encoded 16-byte auth tag
 *   encryptedSymmetricKey: string,   // Lit-encrypted key (opaque string)
 *   dataToEncryptHash: string        // integrity hash from Lit (= litEncryptedKeyId)
 * }>}
 */
async function encryptPdf(pdfBuffer, arweaveHash) {
  const { ciphertext, iv, authTag, symmetricKey } = aesEncryptPdf(pdfBuffer);

  try {
    const { encryptedSymmetricKey, dataToEncryptHash } = await sealKey(symmetricKey, arweaveHash);

    return {
      encryptedPdf: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encryptedSymmetricKey,
      dataToEncryptHash,
    };
  } finally {
    // Zero the plaintext key even if sealing threw.
    symmetricKey.fill(0);
  }
}

/**
 * @deprecated Use aesEncryptPdf + sealKey (or encryptPdf) instead.
 *
 * Superseded once the arweaveHash became part of the sealed payload: this
 * signature implies the hash is optional, which is exactly the assumption the
 * envelope binding exists to remove.
 *
 * @param {Buffer} pdfBuffer
 * @param {string} arweaveHash
 * @returns {Promise<object>}
 */
async function encryptForRental(pdfBuffer, arweaveHash) {
  return encryptPdf(pdfBuffer, arweaveHash);
}

module.exports = {
  generateSymmetricKey,
  aesEncrypt,
  aesEncryptPdf,
  sealKey,
  buildKeyEnvelope,
  encryptPdf,
  encryptForRental,
  ENVELOPE_VERSION,
};
