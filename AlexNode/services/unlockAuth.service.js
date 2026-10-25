// Pre-check for a reader's signed unlock request (POST /api/rental/unlock/:arweaveHash).
//
// The decryption Lit Action is the check that counts: it re-verifies every one of
// these rules inside the TEE, on the chain's clock. This copy exists so a request
// that is going to be refused is refused here, before it spends a Lit credit —
// and so the per-wallet rate limit is keyed on a proven address, not a claimed one.
//
// The message format is EIP-4361 ("Sign-In with Ethereum"), exactly as the
// frontend builds it (AlexandriaFrontEnd src/services/unlockMessage.js) and the
// Action parses it (src/services/litAction.js). Change one and the others must
// follow. Drift fails closed: a stricter copy here refuses good requests loudly;
// a looser one only costs credits, since the Action still refuses.

const crypto = require('crypto');

const {
  CHAIN_ID,
  MAX_WINDOW_SECONDS,
  MAX_CLOCK_SKEW_SECONDS,
  allowedDomains,
  sha256Hex,
  buildWalletMessage,
  parseWalletMessage,
  checkScope,
  checkSignature,
  checkTimes,
  refuse,
} = require('./walletMessage.service');

const UNLOCK_STATEMENT = 'Unlock one Alexandria book for reading.';
const UNLOCK_CHAIN_ID = CHAIN_ID;
const MAX_UNLOCK_WINDOW_SECONDS = MAX_WINDOW_SECONDS;
const SEALED_KEY_URN = 'urn:alexandria:sealed-key:sha256:';
const SESSION_KEY_URN = 'urn:alexandria:session-key:sha256:';
const UNLOCK_SHAPE = { statement: UNLOCK_STATEMENT, resources: [SEALED_KEY_URN, SESSION_KEY_URN] };

/** Same fields, same order, same lines as the frontend builder. Used by tests. */
function buildUnlockMessage({ sealedKeyHash, sessionKeyHash, ...fields }) {
  return buildWalletMessage({
    ...fields,
    statement: UNLOCK_STATEMENT,
    resources: [`${SEALED_KEY_URN}${sealedKeyHash}`, `${SESSION_KEY_URN}${sessionKeyHash}`],
  });
}

/**
 * Strict EIP-4361 parse of exactly the shape the frontend builds. Anything else,
 * including extra optional fields, is null rather than interpreted.
 *
 * @param {string} text
 * @returns {null | { domain, address, chainId, issuedAt, expirationTime, sealedKeyHash, sessionKeyHash }}
 *   issuedAt / expirationTime are unix seconds
 */
function parseUnlockMessage(text) {
  const msg = parseWalletMessage(text, UNLOCK_SHAPE);
  if (!msg) return null;
  const { resourceHashes, ...rest } = msg;
  return { ...rest, sealedKeyHash: resourceHashes[0], sessionKeyHash: resourceHashes[1] };
}

/** The session public key must be an RSA SPKI the Action can import (RSA-OAEP, ≥ 2048 bits). */
function decodeSessionKey(base64) {
  if (typeof base64 !== 'string' || base64.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const der = Buffer.from(base64, 'base64');
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') return null;
    if (!key.asymmetricKeyDetails || key.asymmetricKeyDetails.modulusLength < 2048) return null;
  } catch {
    return null;
  }
  return der;
}

/**
 * Everything the Action checks except the chain.
 *
 * @param {object} p
 * @param {string} p.authMessage
 * @param {string} p.authSignature
 * @param {string} p.sessionPublicKey  base64 SPKI
 * @param {string} p.sealedKey         the book's litEncryptedKeyId, from Postgres
 * @param {number} [p.now]             unix seconds (tests)
 * @returns {{ ok: true, address: string, message: object } | { ok: false, status: number, error: string, message: string }}
 */
function verifyUnlockRequest({ authMessage, authSignature, sessionPublicKey, sealedKey, now }) {
  const nowSeconds = now === undefined ? Math.floor(Date.now() / 1000) : now;

  const msg = parseUnlockMessage(authMessage);
  if (!msg) return refuse(400, 'auth_message_invalid', 'The unlock message is not in the expected format.');
  const outOfScope = checkScope(msg);
  if (outOfScope) return outOfScope;

  if (msg.sealedKeyHash !== sha256Hex(Buffer.from(sealedKey, 'utf8'))) {
    return refuse(400, 'auth_wrong_key', 'The signed message is for a different book.');
  }
  const sessionKeyDer = decodeSessionKey(sessionPublicKey);
  if (!sessionKeyDer) return refuse(400, 'session_key_invalid', 'The session key is not a usable RSA public key.');
  if (msg.sessionKeyHash !== sha256Hex(sessionKeyDer)) {
    return refuse(400, 'auth_session_key', 'The session key is not the one named in the signed message.');
  }

  const signer = checkSignature(authMessage, authSignature, msg);
  if (!signer.ok) return signer;

  const badTime = checkTimes(msg, nowSeconds);
  if (badTime) return badTime;

  return { ok: true, address: signer.address, message: msg };
}

module.exports = {
  UNLOCK_STATEMENT,
  UNLOCK_CHAIN_ID,
  MAX_UNLOCK_WINDOW_SECONDS,
  MAX_CLOCK_SKEW_SECONDS,
  allowedDomains,
  buildUnlockMessage,
  parseUnlockMessage,
  verifyUnlockRequest,
  sha256Hex,
};
