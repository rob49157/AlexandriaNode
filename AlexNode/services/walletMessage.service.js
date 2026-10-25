// Messages a wallet signs to prove who is asking: EIP-4361 ("Sign-In with
// Ethereum"), in exactly one shape per purpose.
//
//   unlock  "Unlock one Alexandria book for reading."  (unlockAuth.service.js)
//           resources: the sealed key, the browser's session key
//   upload  "Upload one book to Alexandria."           (uploadAuth.service.js)
//           resources: the PDF
//
// The shape is fixed — fourteen-ish lines, fixed order, no optional fields — and
// parsed strictly: anything else is refused rather than interpreted. The unlock
// shape is also parsed by the decryption Lit Action and built by the frontend
// (src/services/unlockMessage.js); change it and all three must change together.
//
// Each message names one or more resources as `urn:alexandria:<kind>:sha256:<hex>`,
// which is what binds a signature to one book, one file, or one browser.

const crypto = require('crypto');
const { verifyMessage } = require('ethers');

const CHAIN_ID = 84532;
const MAX_WINDOW_SECONDS = 600;
const MAX_CLOCK_SKEW_SECONDS = 60;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * host[:port] values a message may name. Must match UNLOCK_ALLOWED_DOMAINS in the
 * decryption Action; configurable only so a new host can be added in step with a
 * re-registered Action.
 */
function allowedDomains() {
  return (process.env.UNLOCK_ALLOWED_DOMAINS || 'localhost:5173')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * @param {object} f
 * @param {string} f.statement
 * @param {string[]} f.resources  full URNs, each ending in a sha256 hex digest
 * @returns {string}
 */
function buildWalletMessage({ domain, uri, address, nonce, issuedAt, expirationTime, statement, resources }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
    'Resources:',
    ...resources.map((urn) => `- ${urn}`),
  ].join('\n');
}

/**
 * Strict parse of exactly the shape buildWalletMessage produces.
 *
 * @param {string} text
 * @param {{ statement: string, resources: string[] }} shape
 *   resources: the URN prefixes expected, in order (each followed by 64 hex chars)
 * @returns {null | { domain, address, chainId, issuedAt, expirationTime, resourceHashes: string[] }}
 *   issuedAt / expirationTime are unix seconds
 */
function parseWalletMessage(text, { statement, resources }) {
  if (typeof text !== 'string' || text.includes('\r')) return null;
  const lines = text.split('\n');
  if (lines.length !== 12 + resources.length) return null;

  const header = /^([A-Za-z0-9.-]+(?::[0-9]{1,5})?) wants you to sign in with your Ethereum account:$/.exec(lines[0]);
  if (!header) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(lines[1])) return null;
  if (lines[2] !== '' || lines[3] !== statement || lines[4] !== '') return null;

  const field = (line, name, pattern) => {
    const prefix = `${name}: `;
    if (!line.startsWith(prefix)) return null;
    const value = line.slice(prefix.length);
    return pattern.test(value) ? value : null;
  };
  const uri = field(lines[5], 'URI', /^https?:\/\/\S+$/);
  const version = field(lines[6], 'Version', /^1$/);
  const chainId = field(lines[7], 'Chain ID', /^[0-9]{1,12}$/);
  const nonce = field(lines[8], 'Nonce', /^[A-Za-z0-9]{8,64}$/);
  const issuedAt = field(lines[9], 'Issued At', TIME);
  const expirationTime = field(lines[10], 'Expiration Time', TIME);
  if (!uri || !version || !chainId || !nonce || !issuedAt || !expirationTime) return null;
  if (lines[11] !== 'Resources:') return null;

  const resourceHashes = [];
  for (let i = 0; i < resources.length; i++) {
    const prefix = `- ${resources[i]}`;
    const line = lines[12 + i];
    if (!line.startsWith(prefix)) return null;
    const digest = line.slice(prefix.length);
    if (!HEX_64.test(digest)) return null;
    resourceHashes.push(digest);
  }

  const domain = header[1];
  if (uri !== `http://${domain}` && uri !== `https://${domain}`) return null;

  const issued = Date.parse(issuedAt) / 1000;
  const expires = Date.parse(expirationTime) / 1000;
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return null;

  return {
    domain,
    address: lines[1],
    chainId: Number(chainId),
    issuedAt: Math.floor(issued),
    expirationTime: Math.floor(expires),
    resourceHashes,
  };
}

const refuse = (status, error, message) => ({ ok: false, status, error, message });

/**
 * The checks every signed message gets before its resources are compared:
 * the site, the chain, and the length of the window.
 * @param {{ maxWindowSeconds?: number }} [o]  unlock messages keep the Action's 600 s
 * @returns {null | { ok: false, status, error, message }}
 */
function checkScope(msg, { maxWindowSeconds = MAX_WINDOW_SECONDS } = {}) {
  if (!allowedDomains().includes(msg.domain)) {
    return refuse(400, 'auth_domain', `Messages must be signed on ${allowedDomains().join(' or ')}.`);
  }
  if (msg.chainId !== CHAIN_ID) return refuse(400, 'auth_chain', `Messages are for chain ${CHAIN_ID}.`);
  if (msg.expirationTime - msg.issuedAt > maxWindowSeconds) {
    return refuse(
      400,
      'auth_window_too_long',
      `This signed message may be valid for at most ${Math.round(maxWindowSeconds / 60)} minutes.`
    );
  }
  return null;
}

/**
 * Recover the signer and require it to be the wallet the message names.
 * Ordinary (EOA) wallets only: a contract wallet's signature does not recover to
 * its address, so it is refused (KEY-BINDING.md R1, deferred).
 * @returns {{ ok: true, address: string } | { ok: false, status, error, message }}
 */
function checkSignature(message, signature, msg) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return refuse(401, 'bad_signature', 'The signature is not a wallet signature.');
  }
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch {
    return refuse(401, 'bad_signature', 'The signature could not be verified.');
  }
  if (recovered.toLowerCase() !== msg.address.toLowerCase()) {
    return refuse(401, 'auth_wallet_mismatch', 'The signature was not made by the wallet the message names.');
  }
  return { ok: true, address: recovered };
}

/**
 * @param {number} nowSeconds
 * @returns {null | { ok: false, status, error, message }}
 */
function checkTimes(msg, nowSeconds) {
  if (msg.issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
    return refuse(401, 'auth_not_yet_valid', 'The signed message is dated in the future.');
  }
  if (nowSeconds >= msg.expirationTime) return refuse(401, 'auth_expired', 'The signed message has expired.');
  return null;
}

module.exports = {
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
};
