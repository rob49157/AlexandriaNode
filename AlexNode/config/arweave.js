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
const WINSTON_PER_AR = 10n ** 12n;

// Env numbers are validated, not coerced: `parseInt(x) || 15` turned an explicit
// 0 into 15 and let -1 through. A bad value fails loudly when this module loads.
function positiveIntEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name}="${raw}" must be a whole number of 1 or more.`);
  }
  return Number(raw);
}

/** Exact AR → winston ("2.5" → 2500000000000n). Rejects anything not a plain decimal. */
function arToWinston(ar) {
  const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(String(ar).trim());
  if (!m) throw new Error(`"${ar}" is not an AR amount (a plain decimal with at most 12 places).`);
  return BigInt(m[1]) * WINSTON_PER_AR + BigInt((m[2] || '').padEnd(12, '0'));
}

const ARWEAVE_CONFIRMATIONS = positiveIntEnv('ARWEAVE_CONFIRMATIONS', 15); // D2
// The most one upload may pay, in AR. The fee comes from nodes over plain HTTP and
// becomes the signed reward (D7), so a lying node must not be able to set it.
// Default 3 AR ≈ 1.5× the largest allowed upload (150 MiB ≈ 2.02 AR on 2026-10-11).
// If the network price legitimately rises past it, uploads fail loudly; raise it.
const ARWEAVE_MAX_REWARD_WINSTON = (() => {
  let cap;
  try {
    cap = arToWinston(process.env.ARWEAVE_MAX_REWARD_AR || '3');
  } catch (err) {
    throw new Error(`ARWEAVE_MAX_REWARD_AR: ${err.message}`);
  }
  // 0 would refuse every upload, which is a misconfiguration, not a policy.
  if (cap <= 0n) throw new Error('ARWEAVE_MAX_REWARD_AR must be greater than 0.');
  return cap;
})();
// Ciphertext waiting to be chunked must outlive the request (plan §2.2): resuming
// an upload "must provide the same data as the original upload" [D4].
const ARWEAVE_SPOOL_DIR = path.resolve(ROOT, process.env.ARWEAVE_SPOOL_DIR || '.arweave-spool');

const NETWORK = 'arweave.N.1'; // GET /info `network` on mainnet nodes (observed 2026-10-11)
const PEER_PROBE_LIMIT = 60;
const MAX_PEER_LAG = 2; // blocks; a lagging node misreports tx status and anchors
const PROBE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const NODE_CACHE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 4; // nodes tried per request before giving up
const PRICE_QUORUM = 3; // independent price quotes collected before taking the median
// The median only outvotes a bad value when there are at least 3 values. With 1 or
// 2, a liar and an honest-but-different node are indistinguishable, so robustAgg()
// falls back to the highest value instead (see there for why highest).
const MEDIAN_MIN = 3;

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

/** The quoted fee exceeds ARWEAVE_MAX_REWARD_AR. Nothing is signed or paid. */
class ArweavePriceCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArweavePriceCapError';
    this.code = 'arweave_price_above_cap';
  }
}

/**
 * Combine values reported by untrusted nodes (heights, price quotes).
 *
 * 3 or more values: the lower median, which ignores a minority of bad values in
 * either direction.
 *
 * Fewer than 3: the HIGHEST value. Two values cannot say which one is wrong, so
 * pick the failure that is cheaper:
 *   - heights: a pinned node that is restarting/lagging is far likelier than one
 *     that lies, and a lagging node hands out anchors that are already expiring.
 *     The lower median picked exactly that node (reproduced 2026-10-11 with
 *     pinned [ours@950, public@1000] → only ours kept).
 *   - prices: a low quote makes an unminable reward (a drop, D1); a high quote is
 *     bounded by ARWEAVE_MAX_REWARD_AR. The lower median picked the low one
 *     (reproduced: quotes [1, 13530674461] → 1).
 *
 * @template T
 * @param {T[]} values non-empty
 * @param {(a: T, b: T) => number} compare
 * @returns {T}
 */
function robustAgg(values, compare) {
  const sorted = [...values].sort(compare);
  if (sorted.length < MEDIAN_MIN) return sorted[sorted.length - 1];
  return sorted[Math.floor((sorted.length - 1) / 2)];
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
    // A missing or non-integer height is unhealthy. Accepting it made the tip NaN,
    // every comparison false, and an EMPTY node list got cached as a success.
    const ok = res.ok && info.network === NETWORK && Number.isSafeInteger(info.height) && info.height > 0;
    return { url, ok, height: info.height, ms: Date.now() - t };
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
 * Healthy nodes, best first: mainnet network name, a height within MAX_PEER_LAG
 * blocks of the tip, then one node per /24 address block before any repeats. The
 * fastest peers cluster in a few blocks (observed 2026-10-11), likely one operator
 * each; a /24 is only a proxy for "different operator".
 *
 * The tip is robustAgg() of the reported heights: the median when 3+ nodes are
 * healthy, the highest when fewer. Heights come from unauthenticated peers. With
 * the max alone, one peer claiming height 10^12 became "the tip" and every honest
 * node fell outside the window, leaving only the liar; discovery probes dozens of
 * peers, so the median applies there. It does not defend against an attacker who
 * controls most of the probed peers; pin ARWEAVE_NODE_URLS to nodes you trust for
 * that, and with 1–2 pinned nodes the highest height wins (see robustAgg).
 *
 * ARWEAVE_NODE_URLS, when set, is the whole candidate list, health-checked but kept
 * in the configured order. There is deliberately no fallback to discovery: an
 * operator who pinned nodes chose them.
 *
 * @param {string[]} [preferred] nodes to put first if still healthy (a resumed
 *   spike run reuses the nodes it posted to)
 * @returns {Promise<string[]>} never empty; throws ArweaveUnavailableError instead
 */
async function selectNodes(preferred = []) {
  const candidates = ARWEAVE_NODE_URLS.length
    ? ARWEAVE_NODE_URLS
    : [...new Set([...preferred, ...(await peersFromSeeds()).slice(0, PEER_PROBE_LIMIT)])];
  if (!candidates.length) {
    throw new ArweaveUnavailableError('No Arweave nodes to try. Set ARWEAVE_NODE_URLS or ARWEAVE_PEER_SEEDS.');
  }

  const probes = await Promise.all(candidates.map(probeNode));
  const ok = probes.filter((p) => p.ok);
  const tip = ok.length ? robustAgg(ok.map((p) => p.height), (a, b) => a - b) : 0;
  const healthy = ok.filter((p) => Math.abs(p.height - tip) <= MAX_PEER_LAG);
  if (!healthy.length) {
    throw new ArweaveUnavailableError(`None of ${probes.length} Arweave nodes answered /info as a healthy ${NETWORK} node.`);
  }
  // Pinned nodes keep the operator's order: "our node first" (plan §4.1) must mean first.
  if (ARWEAVE_NODE_URLS.length) return healthy.map((p) => p.url);

  healthy.sort((a, b) => preferred.includes(b.url) - preferred.includes(a.url) || a.ms - b.ms);
  const block = (url) => new URL(url).hostname.split('.').slice(0, 3).join('.');
  const seen = new Set();
  const spread = [];
  const rest = [];
  for (const p of healthy) {
    if (seen.has(block(p.url)) && !preferred.includes(p.url)) rest.push(p);
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
 *
 * The candidate nodes are asked in PARALLEL, so a dead node costs one timeout,
 * not one timeout each (sequentially, up to 6 × 30 s for a price). Answers are
 * returned in node order, at most `want` of them. At least one, or it throws.
 * @returns {Promise<Array<{ node: string, winston: string }>>}
 */
async function nodeGetWinston(pathname, want = 1) {
  const nodes = (await getNodes()).slice(0, MAX_ATTEMPTS + want - 1);
  const results = await Promise.all(
    nodes.map(async (node) => {
      try {
        const res = await fetch(`${node}/${pathname}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const text = (await res.text()).trim();
        if (!res.ok) return { node, error: `HTTP ${res.status}` };
        if (!/^\d+$/.test(text)) return { node, error: `non-numeric body ${JSON.stringify(text.slice(0, 80))}` };
        return { node, winston: text };
      } catch (err) {
        return { node, error: (err.cause && err.cause.code) || err.message };
      }
    })
  );
  const answers = results.filter((r) => r.winston !== undefined).slice(0, want);
  const errors = results.filter((r) => r.error !== undefined).map((r) => `${r.node}: ${r.error}`);
  if (answers.length) return answers;
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
  const [{ node, winston }] = await nodeGetWinston(`wallet/${address}/balance`);
  return { winston, ar: winstonToAr(winston), address, node };
}

/**
 * Network fee to store `bytes` bytes, in winston. GET /price/{bytes} [HTTP API].
 * Pre-flight cost check before signing; the signed `reward` is then fixed (D7).
 *
 * The quote comes from nodes over plain HTTP and becomes money, so it is not taken
 * from one node: up to PRICE_QUORUM nodes are asked and robustAgg() combines them.
 * With 3 quotes, one inflated quote cannot raise the fee and one deflated quote
 * cannot shrink it into a reward too low to be mined (a drop, D1). With 1–2 quotes
 * the highest is used: underpaying guarantees a drop, while overpaying is bounded
 * by ARWEAVE_MAX_REWARD_AR, which is then the only guard.
 *
 * @param {number} bytes
 * @returns {Promise<string>} winston
 * @throws {ArweavePriceCapError} if the fee exceeds ARWEAVE_MAX_REWARD_AR
 */
async function getPrice(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError(`bytes must be a non-negative integer, got ${bytes}`);
  const answers = await nodeGetWinston(`price/${bytes}`, PRICE_QUORUM);
  const price = robustAgg(
    answers.map((a) => BigInt(a.winston)),
    (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  );
  if (price > ARWEAVE_MAX_REWARD_WINSTON) {
    throw new ArweavePriceCapError(
      `Fee for ${bytes} bytes is ${winstonToAr(price)} AR, above ARWEAVE_MAX_REWARD_AR=${winstonToAr(ARWEAVE_MAX_REWARD_WINSTON)}. ` +
        `Quotes: ${answers.map((a) => `${a.node}=${a.winston}`).join(', ')}.`
    );
  }
  return price.toString();
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
  arToWinston,
  arweaveFor,
  offline,
  ArweaveUnavailableError,
  ArweavePriceCapError,
  ARWEAVE_MAX_REWARD_WINSTON,
  ARWEAVE_WALLET_FILE,
  ARWEAVE_WALLET_ADDRESS,
  ARWEAVE_NODE_URLS,
  ARWEAVE_PEER_SEEDS,
  ARWEAVE_GATEWAY_URLS,
  ARWEAVE_CONFIRMATIONS,
  ARWEAVE_SPOOL_DIR,
  _reset,
};
