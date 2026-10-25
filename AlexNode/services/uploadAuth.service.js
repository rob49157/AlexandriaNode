// Proof that an upload comes from the wallet it names (POST /api/upload).
//
// Without it the walletAddress form field is a claim anyone can make, so every
// per-wallet upload rule (uploadQuota.service.js) could be dodged by typing a
// different address. The archivist's wallet signs an EIP-4361 message naming the
// SHA-256 of the exact PDF being uploaded, so a signature authorizes that file
// and nothing else, for at most 30 minutes. Built by the frontend in
// src/services/unlockMessage.js (buildUploadMessage).
//
// 30 minutes, not the unlock message's 10: the signature is checked only once
// the whole file has arrived, and a large book on a slow uplink takes a while.
// The longer window costs nothing: replaying a captured signature can only
// re-upload the same file, which the SHA-256 duplicate check rejects.

const {
  sha256Hex,
  buildWalletMessage,
  parseWalletMessage,
  checkScope,
  checkSignature,
  checkTimes,
  refuse,
} = require('./walletMessage.service');

const UPLOAD_STATEMENT = 'Upload one book to Alexandria.';
const PDF_URN = 'urn:alexandria:pdf:sha256:';
const UPLOAD_MAX_WINDOW_SECONDS = 1800;
const UPLOAD_SHAPE = { statement: UPLOAD_STATEMENT, resources: [PDF_URN] };

/** Same fields, same order, same lines as the frontend builder. Used by tests. */
function buildUploadMessage({ pdfHash, ...fields }) {
  return buildWalletMessage({ ...fields, statement: UPLOAD_STATEMENT, resources: [`${PDF_URN}${pdfHash}`] });
}

/**
 * @param {object} p
 * @param {string} p.authMessage
 * @param {string} p.authSignature
 * @param {Buffer} p.fileBuffer      the uploaded PDF, exactly as received
 * @param {string} p.walletAddress   the walletAddress form field
 * @param {number} [p.now]           unix seconds (tests)
 * @returns {{ ok: true, address: string } | { ok: false, status: number, error: string, message: string }}
 */
function verifyUploadRequest({ authMessage, authSignature, fileBuffer, walletAddress, now }) {
  const nowSeconds = now === undefined ? Math.floor(Date.now() / 1000) : now;

  if (typeof authMessage !== 'string' || !authMessage) {
    return refuse(401, 'auth_missing', 'Sign the upload with your wallet. The request carried no signed message.');
  }
  const msg = parseWalletMessage(authMessage, UPLOAD_SHAPE);
  if (!msg) return refuse(400, 'auth_message_invalid', 'The signed upload message is not in the expected format.');
  const outOfScope = checkScope(msg, { maxWindowSeconds: UPLOAD_MAX_WINDOW_SECONDS });
  if (outOfScope) return outOfScope;

  if (msg.resourceHashes[0] !== sha256Hex(fileBuffer)) {
    return refuse(400, 'auth_wrong_file', 'The signature is for a different file than the one uploaded.');
  }

  const signer = checkSignature(authMessage, authSignature, msg);
  if (!signer.ok) return signer;
  if (typeof walletAddress !== 'string' || signer.address.toLowerCase() !== walletAddress.toLowerCase()) {
    return refuse(401, 'auth_wallet_mismatch', 'The upload was signed by a different wallet than the one it names.');
  }

  const badTime = checkTimes(msg, nowSeconds);
  if (badTime) return badTime;

  return { ok: true, address: signer.address };
}

module.exports = { UPLOAD_STATEMENT, PDF_URN, UPLOAD_MAX_WINDOW_SECONDS, buildUploadMessage, verifyUploadRequest };
