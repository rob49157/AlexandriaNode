// Arweave L1 client — the storage wallet, node selection, balance, and price.
//
// Replaces config/irys.js (ARWEAVE-DIRECT-PLAN.md §4.1). Until Phase 6 both exist:
// controller/arweave.js still uploads through Irys, and nothing on the request
// path requires this file yet.
//
// No gateway or bundler sits on the write path (decision D6). Requests go to raw
// Arweave nodes, either the operator's own (ARWEAVE_NODE_URLS, the Option B path)
// or peers discovered via GET /peers and verified one by one with GET /info.
// A seed is asked only for addresses; nothing it says about the network is trusted.
//
// This wallet is a dedicated, low-privilege storage wallet: it can pay for Arweave
// bytes and nothing else. It is NOT the registrar (BACKEND_PRIVATE_KEY) and must
// never be merged with it.

const fs = require('fs');
const path = require('path');
const Arweave = require('arweave');

const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

const ROOT = path.resolve(__dirname, '..');

const ARWEAVE_WALLET_FILE = path.resolve(ROOT, process.env.ARWEAVE_WALLET_FILE || '.arweave-wallet.json'); // D3
const ARWEAVE_WALLET_ADDRESS = (process.env.ARWEAVE_WALLET_ADDRESS || '').trim();
const ARWEAVE_NODE_URLS = list(process.env.ARWEAVE_NODE_URLS);
const ARWEAVE_PEER_SEEDS = list(process.env.ARWEAVE_PEER_SEEDS || 'https://arweave.net');
// Read path only: fetching ciphertext back. Never used to upload or pay.
const ARWEAVE_GATEWAY_URLS = list(process.env.ARWEAVE_GATEWAY_URLS || 'https://arweave.net,https://turbo-gateway.com');
const ARWEAVE_CONFIRMATIONS = parseInt(process.env.ARWEAVE_CONFIRMATIONS, 10) || 15; // D2
// Ciphertext waiting to be chunked must outlive the request (plan §2.2): resuming
// an upload "must provide the same data as the original upload" [D4].
const ARWEAVE_SPOOL_DIR = path.resolve(ROOT, process.env.ARWEAVE_SPOOL_DIR || '.arweave-spool');

const WINSTON_PER_AR = 10n ** 12n;
const NETWORK = 'arweave.N.1'; // GET /info `network` on mainnet nodes (observed 2026-10-11)
const PEER_PROBE_LIMIT = 60;
const MAX_PEER_LAG = 2; // blocks; a lagging node misreports tx status and anchors
const PROBE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const NODE_CACHE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 4; // nodes tried per request before giving up

// Local-only client: key generation, address derivation, and signing do not touch
// the network, so they do not need a selected node.
const offline = Arweave.init({});

function arweaveFor(url) {
  const u = new URL(url);
  return Arweave.init({
    host: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
    protocol: u.protocol.replace(':', ''),
    timeout: 60_000,
  });
}

/** A request that no healthy node could answer. Maps to 503, never to "not found". */
class ArweaveUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArweaveUnavailableError';
    this.code = 'arweave_unavailable';
  }
}

function winstonToAr(winston) {
  const w = BigInt(winston);
  const frac = (w % WINSTON_PER_AR).toString().padStart(12, '0').replace(/0+$/, '');
  return `${w / WINSTON_PER_AR}${frac ? `.${frac}` : ''}`;
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

let _wallet;

/**
 * Check the wallet file before anything uses it.
 *
 * Each mistake is named, because each otherwise surfaces later as something
 * misleading (same reasoning as config/irys.js validateWalletKey):
 *   1. No file: the setup step was skipped.
 *   2. An EVM 0x address in ARWEAVE_WALLET_ADDRESS. Arweave and Ethereum addresses
 *      are not compatible, and AR sent to an Ethereum address is lost [ECDSA docs].
 *   3. A file holding only the PUBLIC key. It derives a valid address, so balance
 *      checks pass, and the first upload fails when signing.
 *   4. The wrong wallet. Silent otherwise: a perfectly valid key with no AR.
 *
 * @returns {Promise<string|null>} an error message, or null if the wallet is usable
 */
async function validateWallet() {
  try {
    await loadWallet();
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Load the JWK and derive its address. Memoized: the file does not change while
 * the process runs. A failure is not cached, so fixing .env and retrying works.
 * @returns {Promise<{ jwk: object, address: string }>}
 */
function loadWallet() {
  if (!_wallet) {
    _wallet = readWallet();
    _wallet.catch(() => {
      _wallet = undefined;
    });
  }
  return _wallet;
}

async function readWallet() {
  if (/^0x[0-9a-fA-F]{40}$/.test(ARWEAVE_WALLET_ADDRESS)) {
    throw new Error(
      `ARWEAVE_WALLET_ADDRESS (${ARWEAVE_WALLET_ADDRESS}) is an Ethereum address. Arweave addresses are 43 ` +
        'base64url characters and are not compatible with EVM addresses; AR sent to an Ethereum address is lost.'
    );
  }
  if (!fs.existsSync(ARWEAVE_WALLET_FILE)) {
    throw new Error(
      `No Arweave wallet at ${ARWEAVE_WALLET_FILE}. Create one with: node scripts/arweave-wallet-setup.js generate`
    );
  }

  let jwk;
  try {
    jwk = JSON.parse(fs.readFileSync(ARWEAVE_WALLET_FILE, 'utf8'));
  } catch {
    throw new Error(`${ARWEAVE_WALLET_FILE} is not valid JSON. It should be an Arweave JWK key file.`);
  }
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string') {
    throw new Error(`${ARWEAVE_WALLET_FILE} is not an Arweave RSA key (expected a JWK with kty "RSA" and "n").`);
  }
  if (typeof jwk.d !== 'string') {
    throw new Error(
      `${ARWEAVE_WALLET_FILE} holds only a PUBLIC key (no "d"). It can show a balance but cannot sign uploads.`
    );
  }

  const address = await offline.wallets.jwkToAddress(jwk);
  if (ARWEAVE_WALLET_ADDRESS && ARWEAVE_WALLET_ADDRESS !== address) {
    throw new Error(
      `${ARWEAVE_WALLET_FILE} derives ${address} but ARWEAVE_WALLET_ADDRESS is ${ARWEAVE_WALLET_ADDRESS}. ` +
        'One of them is from the wrong wallet; uploads would be paid from a wallet with no AR.'
    );
  }
  return { jwk, address };
}

// ─── Node selection ──────────────────────────────────────────────────────────

let _nodes; // { promise, at }

async function probeNode(url) {
  const t = Date.now();
  try {
    const res = await fetch(`${url}/info`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const info = await res.json();
    return { url, ok: res.ok && info.network === NETWORK, height: info.height, ms: Date.now() - t };
  } catch (err) {
    return { url, ok: false, error: (err.cause && err.cause.code) || err.name };
  }
}

async function peersFromSeeds() {
  const found = [];
  for (const seed of ARWEAVE_PEER_SEEDS) {
    try {
      const res = await fetch(`${seed}/peers`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // Peers are "ip:port" over plain HTTP. Acceptable: headers are signed and the
      // data is already AES-GCM ciphertext, so a node can refuse but not alter.
      found.push(...(await res.json()).map((p) => `http://${p}`));
    } catch (err) {
      console.warn(`[arweave] peer seed ${seed} failed: ${err.message}`);
    }
  }
  return found;
}

/**
 * Healthy nodes, best first: mainnet network name, within MAX_PEER_LAG blocks of
 * the best height seen, then one node per /24 address block before any repeats.
 * The fastest peers cluster in a few blocks (observed 2026-10-11), likely one
 * operator each; a /24 is only a proxy for "different operator".
 *
 * ARWEAVE_NODE_URLS, when set, is the whole candidate list, health-checked but kept
 * in the configured order. There is deliberately no fallback to discovery: an
 * operator who pinned nodes chose them.
 */
async function selectNodes() {
  const candidates = ARWEAVE_NODE_URLS.length
    ? ARWEAVE_NODE_URLS
    : [...new Set(await peersFromSeeds())].slice(0, PEER_PROBE_LIMIT);
  if (!candidates.length) {
    throw new ArweaveUnavailableError('No Arweave nodes to try. Set ARWEAVE_NODE_URLS or ARWEAVE_PEER_SEEDS.');
  }

  const probes = await Promise.all(candidates.map(probeNode));
  const ok = probes.filter((p) => p.ok);
  if (!ok.length) {
    throw new ArweaveUnavailableError(`None of ${probes.length} Arweave nodes answered /info as ${NETWORK}.`);
  }

  const tip = Math.max(...ok.map((p) => p.height));
  const healthy = ok.filter((p) => p.height >= tip - MAX_PEER_LAG);
  // Pinned nodes keep the operator's order: "our node first" (plan §4.1) must mean first.
  if (ARWEAVE_NODE_URLS.length) return healthy.map((p) => p.url);

  healthy.sort((a, b) => a.ms - b.ms);
  const block = (url) => new URL(url).hostname.split('.').slice(0, 3).join('.');
  const seen = new Set();
  const spread = [];
  const rest = [];
  for (const p of healthy) {
    if (seen.has(block(p.url))) rest.push(p);
    else {
      seen.add(block(p.url));
      spread.push(p);
    }
  }
  return [...spread, ...rest].map((p) => p.url);
}

/**
 * The cached node list, refreshed every NODE_CACHE_MS. Concurrent callers share
 * one discovery. A failed discovery is not cached.
 * @returns {Promise<string[]>}
 */
function getNodes() {
  if (!_nodes || Date.now() - _nodes.at > NODE_CACHE_MS) {
    const promise = selectNodes();
    _nodes = { promise, at: Date.now() };
    promise.catch(() => {
      if (_nodes && _nodes.promise === promise) _nodes = undefined;
    });
  }
  return _nodes.promise;
}

/** Force the next request to rediscover nodes. */
function invalidateNodes() {
  _nodes = undefined;
}

/**
 * GET an endpoint that answers a bare winston integer (balance, price), failing
 * over across healthy nodes. A 200 with anything else (an HTML error page from a
 * proxy, an empty body) counts as that node failing, rather than being parsed
 * into a wrong number.
 * @returns {Promise<{ node: string, winston: string }>}
 */
async function nodeGetWinston(pathname) {
  const nodes = await getNodes();
  const errors = [];
  for (const node of nodes.slice(0, MAX_ATTEMPTS)) {
    try {
      const res = await fetch(`${node}/${pathname}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = (await res.text()).trim();
      if (!res.ok) errors.push(`${node}: HTTP ${res.status}`);
      else if (!/^\d+$/.test(text)) errors.push(`${node}: non-numeric body ${JSON.stringify(text.slice(0, 80))}`);
      else return { node, winston: text };
    } catch (err) {
      errors.push(`${node}: ${(err.cause && err.cause.code) || err.message}`);
    }
  }
  // Every node we trusted just failed; the list is probably stale.
  invalidateNodes();
  throw new ArweaveUnavailableError(`GET /${pathname} failed on every node tried: ${errors.join('; ')}`);
}

// ─── Balance and price ───────────────────────────────────────────────────────

/**
 * Storage-wallet balance. Backs low-balance alerting: uploads fail once this is
 * below the next upload's fee, and that is easier to act on before it happens.
 * GET /wallet/{address}/balance [HTTP API]. Sends the address only, never the key.
 * @returns {Promise<{ winston: string, ar: string, address: string, node: string }>}
 */
async function getBalance() {
  const { address } = await loadWallet();
  const { node, winston } = await nodeGetWinston(`wallet/${address}/balance`);
  return { winston, ar: winstonToAr(winston), address, node };
}

/**
 * Network fee to store `bytes` bytes, in winston. GET /price/{bytes} [HTTP API].
 * Pre-flight cost check before signing; the signed `reward` is then fixed (D7).
 * @param {number} bytes
 * @returns {Promise<string>}
 */
async function getPrice(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError(`bytes must be a non-negative integer, got ${bytes}`);
  return (await nodeGetWinston(`price/${bytes}`)).winston;
}

/** Test hook: forget the memoized wallet and node list. */
function _reset() {
  _wallet = undefined;
  _nodes = undefined;
}

module.exports = {
  loadWallet,
  validateWallet,
  getNodes,
  invalidateNodes,
  selectNodes,
  getBalance,
  getPrice,
  winstonToAr,
  arweaveFor,
  offline,
  ArweaveUnavailableError,
  ARWEAVE_WALLET_FILE,
  ARWEAVE_WALLET_ADDRESS,
  ARWEAVE_NODE_URLS,
  ARWEAVE_PEER_SEEDS,
  ARWEAVE_GATEWAY_URLS,
  ARWEAVE_CONFIRMATIONS,
  ARWEAVE_SPOOL_DIR,
  _reset,
};
