// Arweave L1 storage — direct to raw nodes, no bundler, no gateway (ARWEAVE-DIRECT-PLAN.md).
//
// Every behaviour here is pinned to something observed on mainnet in Phase 0
// (§9 of the plan, raw responses in .arweave-spike/*/run.json and
// tests/fixtures/arweave-node-responses.json), not to documentation alone:
//
//   prepareUpload()  sign locally. Free and offline. Yields the arweaveHash
//                    (= base64url(sha256(signature)), 43 chars, Q1) BEFORE any
//                    spend, which is what lets the Lit envelope bind to it.
//   postHeader()     send the signed header, without data, to several nodes (Q2, Q8).
//                    Paid only if mined; the fee is deducted at mining (Q4).
//   pushChunks()     send the data, chunk by chunk, to ARWEAVE_MIN_HOLDERS nodes
//                    that answer 200 (Q12, D9). Resumable from a saved state.
//   verifyHolders()  read chunks back from each holder and check them (D9, Q13).
//   fetchEncrypted() read a whole book back from raw nodes, proof-checked (D8).
//
// arweave-js is used only for local work (build, chunk, sign, Merkle proofs).
// It makes no network calls here: the anchor and fee are fetched by us and passed
// in, so createTransaction() has nothing to look up [S3]. Its uploader is NOT
// used: it treats the 303 most nodes answer as an error and re-sends the same
// chunk forever (Q12).

const crypto = require('crypto');
const Transaction = require('arweave/node/lib/transaction').default;
const { validatePath } = require('arweave/node/lib/merkle');
const cfg = require('../config/arweave');

const APP_NAME = 'Alexandria';
const APP_VERSION = '1';

const REQUEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 60_000;
// Arweave caps tags at 2048 bytes for names + values combined [D: HTTP API].
const MAX_TAGS_BYTES = 2048;
// Per free-text value. 3 × 500 = 1500 bytes plus ~300 fixed bytes stays under the
// cap even when every character is 4-byte UTF-8. Layer 5 already caps lengths in
// characters, which is not the same thing.
const MAX_FREE_TAG_BYTES = 500;
const CHUNK_RETRIES = 3;
const PROBE_CANDIDATES = 30;
const VERIFY_SAMPLE = 10;

// POST /chunk errors after which re-sending the same chunk can never succeed
// (arweave-js FATAL_CHUNK_UPLOAD_ERRORS [S4]).
const FATAL_CHUNK_ERRORS = [
  'invalid_json',
  'chunk_too_big',
  'data_path_too_big',
  'offset_too_big',
  'data_size_too_big',
  'chunk_proof_ratio_not_attractive',
  'invalid_proof',
];

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

// ─── Ids ─────────────────────────────────────────────────────────────────────

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a transaction id to its 32 raw bytes. Arweave L1 ids are always
 * base64url, 43 characters (Q1, every Phase 0 run); anything else is not an id.
 * @returns {Buffer|null}
 */
function decodeTransactionId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const buf = Buffer.from(id, 'base64url');
  return buf.length === 32 ? buf : null;
}

/** Same id? Compared as decoded bytes, never as strings (CLAUDE.md, "id encoding"). */
function sameTransactionId(a, b) {
  const da = decodeTransactionId(a);
  const db = decodeTransactionId(b);
  return Boolean(da && db && da.equals(db));
}

const ARWEAVE_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Format check only: 43-char base64url. Says nothing about existence. */
function isValidArweaveHash(hash) {
  return typeof hash === 'string' && ARWEAVE_HASH_PATTERN.test(hash);
}

// ─── Tags ────────────────────────────────────────────────────────────────────

// Cut a string to at most `maxBytes` of UTF-8 without splitting a character.
function truncateUtf8(value, maxBytes) {
  const s = String(value ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

function tagsByteLength(tags) {
  return tags.reduce((n, t) => n + Buffer.byteLength(t.name, 'utf8') + Buffer.byteLength(t.value, 'utf8'), 0);
}

/**
 * The public, permanent tag set for an encrypted upload.
 *
 * The IV and auth tag live here because without them the ciphertext is
 * undecryptable, and Arweave keeps them forever. Metadata makes the stored
 * object self-describing, so the search index is rebuildable from storage alone.
 * Nothing secret goes in tags: they are public and unencrypted.
 *
 * @param {{ iv: Buffer, authTag: Buffer, metadata: object, uploader: string, sha256Hash: string }} params
 * @returns {Array<{name: string, value: string}>}
 */
function buildTags({ iv, authTag, metadata, uploader, sha256Hash }) {
  const tags = [
    { name: 'Content-Type', value: 'application/octet-stream' },
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: APP_VERSION },
    { name: 'Encryption', value: 'AES-256-GCM' },
    { name: 'Encryption-IV', value: iv.toString('base64') },
    { name: 'Encryption-Auth-Tag', value: authTag.toString('base64') },
    { name: 'Title', value: truncateUtf8(metadata.title, MAX_FREE_TAG_BYTES) },
    { name: 'Author', value: truncateUtf8(metadata.author, MAX_FREE_TAG_BYTES) },
    { name: 'Category', value: truncateUtf8(metadata.category, MAX_FREE_TAG_BYTES) },
    { name: 'Uploader', value: String(uploader ?? '') },
    { name: 'SHA-256', value: String(sha256Hash ?? '') },
  ];
  // Unreachable with the caps above; kept so a future tag cannot silently push a
  // header past the node's limit and fail only at post time, after sealing.
  const bytes = tagsByteLength(tags);
  if (bytes > MAX_TAGS_BYTES) {
    throw new StorageError('tags_too_large', `Tags are ${bytes} bytes; Arweave allows ${MAX_TAGS_BYTES}.`);
  }
  return tags;
}

// ─── Node HTTP helpers ───────────────────────────────────────────────────────

async function http(node, pathname, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`${node}/${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    return { node, status: res.status, text: await res.text() };
  } catch (err) {
    return { node, status: -1, text: (err.cause && err.cause.code) || err.message };
  }
}

function errorCode(text) {
  try {
    return JSON.parse(text).error || text;
  } catch {
    return text;
  }
}

// /24 address block: a proxy for "different operator" (observed clusters,
// 2026-10-11). The protocol does not expose who runs a node.
function blockOf(node) {
  return new URL(node).hostname.split('.').slice(0, 3).join('.');
}

/** First node (in health order) whose answer passes `accept`; fails over. */
async function firstAnswer(pathname, accept, what) {
  const nodes = await cfg.getNodes();
  const errors = [];
  for (const node of nodes.slice(0, 5)) {
    const r = await http(node, pathname);
    const value = r.status === 200 ? accept(r.text) : undefined;
    if (value !== undefined) return { node, value };
    errors.push(`${node}: ${r.status} ${String(r.text).slice(0, 60)}`);
  }
  cfg.invalidateNodes();
  throw new cfg.ArweaveUnavailableError(`Could not get ${what}: ${errors.join('; ')}`);
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// ─── Network state ───────────────────────────────────────────────────────────

/** Current block height. */
async function getTipHeight() {
  const { value } = await firstAnswer(
    'info',
    (t) => {
      const j = parseJson(t);
      return j && Number.isSafeInteger(j.height) ? j.height : undefined;
    },
    'block height'
  );
  return value;
}

/**
 * Where a transaction stands. GET /tx/{id}/status answers 200 + JSON when mined,
 * 202 "Pending" while in the mempool, 404 "Not Found." otherwise (fixtures).
 * @returns {Promise<{ state: 'mined'|'pending'|'not_found', blockHeight?: number, confirmations?: number }>}
 */
async function getTxStatus(txId) {
  const nodes = await cfg.getNodes();
  const errors = [];
  let notFound = 0;
  for (const node of nodes.slice(0, 5)) {
    const r = await http(node, `tx/${txId}/status`);
    if (r.status === 200) {
      const j = parseJson(r.text);
      if (j && Number.isSafeInteger(j.block_height) && Number.isSafeInteger(j.number_of_confirmations)) {
        return { state: 'mined', blockHeight: j.block_height, confirmations: j.number_of_confirmations };
      }
    } else if (r.status === 202) {
      return { state: 'pending' };
    } else if (r.status === 404) {
      // One node not knowing a tx proves little (it may not have seen it yet), so
      // ask more before concluding.
      notFound++;
      if (notFound >= 2) return { state: 'not_found' };
      continue;
    }
    errors.push(`${node}: ${r.status}`);
  }
  if (notFound) return { state: 'not_found' };
  throw new cfg.ArweaveUnavailableError(`Could not get status of ${txId}: ${errors.join('; ')}`);
}

// ─── Prepare (free, local) ───────────────────────────────────────────────────

/**
 * Build and sign the transaction. Nothing is sent and nothing is spent.
 *
 * The fee is the network quote (median of several nodes, capped by
 * ARWEAVE_MAX_REWARD_AR) plus ARWEAVE_REWARD_MARGIN_PERCENT: a higher reward
 * is accepted and mined (Q7). The anchor comes from /tx_anchor; its block height
 * sets the deadline after which the header can never be mined (anchor + 50, Q11).
 *
 * @param {Buffer} ciphertext
 * @param {Array<{name: string, value: string}>} tags
 * @returns {Promise<{ arweaveHash: string, tx: Transaction, header: object, reward: string, anchor: string, anchorHeight: number }>}
 */
async function prepareUpload(ciphertext, tags) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
    throw new Error('prepareUpload requires a non-empty ciphertext Buffer.');
  }
  const { jwk } = await cfg.loadWallet();

  const { value: anchor } = await firstAnswer(
    'tx_anchor',
    (t) => (/^[A-Za-z0-9_-]{43,64}$/.test(t.trim()) ? t.trim() : undefined),
    'a transaction anchor'
  );
  // The anchor's own height, not "now": the tx stays valid while that block is
  // among the last 50. Falls back to the tip, which is later than the truth, so
  // the deadline errs late (safe) rather than declaring a live tx failed.
  let anchorHeight;
  try {
    ({ value: anchorHeight } = await firstAnswer(
      `block/hash/${anchor}`,
      (t) => {
        const j = parseJson(t);
        return j && Number.isSafeInteger(j.height) ? j.height : undefined;
      },
      'the anchor block height'
    ));
  } catch {
    anchorHeight = await getTipHeight();
  }

  const quote = BigInt(await cfg.getPrice(ciphertext.length));
  const reward = (quote * BigInt(100 + cfg.ARWEAVE_REWARD_MARGIN_PERCENT)) / 100n;
  if (reward > cfg.ARWEAVE_MAX_REWARD_WINSTON) {
    throw new cfg.ArweavePriceCapError(
      `Fee ${cfg.winstonToAr(reward)} AR (quote + ${cfg.ARWEAVE_REWARD_MARGIN_PERCENT}%) exceeds ARWEAVE_MAX_REWARD_AR.`
    );
  }

  const tx = await cfg.offline.createTransaction({ data: ciphertext, last_tx: anchor, reward: reward.toString() }, jwk);
  for (const t of tags) tx.addTag(t.name, t.value);
  await cfg.offline.transactions.sign(tx, jwk);

  // Q1: the id is base64url(sha256(signature)). Checked on every upload rather
  // than trusted, because the Lit envelope is about to be bound to it forever.
  const derived = toBase64Url(crypto.createHash('sha256').update(Buffer.from(tx.signature, 'base64url')).digest());
  if (!isValidArweaveHash(tx.id) || derived !== tx.id) {
    throw new StorageError('bad_tx_id', `Signed tx id ${tx.id} is not base64url(sha256(signature)).`);
  }

  return { arweaveHash: tx.id, tx, header: headerOf(tx), reward: reward.toString(), anchor, anchorHeight };
}

/** The signed header without data: what is posted to /tx and saved for re-posting. */
function headerOf(tx) {
  return { ...tx.toJSON(), data: '' };
}

// ─── Header (paid only if mined) ─────────────────────────────────────────────

/**
 * POST the signed header to up to `count` healthy nodes from different /24
 * blocks, in parallel. Always without data, even for one-chunk files ("for v2
 * transactions there is no need ... to use this field" [HTTP API]), so every
 * book takes the same chunk path and the same holder checks.
 *
 * Never throws for node errors: a node can accept a header and still time out
 * on the reply, so "every node failed" is not proof the tx is dead. The worker
 * re-posts until the anchor expires.
 *
 * @returns {Promise<{ accepted: string[], results: Array<{node, status, text}> }>}
 */
async function postHeader(header, count = 3) {
  const nodes = await cfg.getNodes();
  const picked = [];
  const blocks = new Set();
  for (const n of nodes) {
    if (picked.length >= count) break;
    if (blocks.has(blockOf(n))) continue;
    blocks.add(blockOf(n));
    picked.push(n);
  }
  const results = await Promise.all(picked.map((n) => http(n, 'tx', { method: 'POST', body: header })));
  return {
    accepted: results.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.node),
    results: results.map((r) => ({ node: r.node, status: r.status, text: String(r.text).slice(0, 200) })),
  };
}

/** A re-post answered this: the anchor is past its 50 blocks, the tx can never be mined (fixture). */
function isExpiredAnchorAnswer(result) {
  return result.status === 400 && /invalid anchor/i.test(String(result.text));
}

// ─── Chunks (free to send; D9) ───────────────────────────────────────────────

/** Rebuild a signed tx from its saved header and the spooled data; check they match. */
async function transactionFor(header, data) {
  const tx = new Transaction({ ...header, data: new Uint8Array(0) });
  await tx.prepareChunks(data);
  if (tx.data_root !== header.data_root) {
    // The spool is not the data that was signed. Sending it would be rejected
    // (invalid_proof); worse, it means the stored book could never be read back.
    throw new StorageError('spool_mismatch', `Spooled data does not match data_root ${header.data_root}.`);
  }
  return tx;
}

async function postChunk(node, tx, data, index) {
  return http(node, 'chunk', { method: 'POST', body: tx.getChunk(index, data), timeout: CHUNK_TIMEOUT_MS });
}

/**
 * Nodes that answer 200 to chunk 0 (they will keep it long term), excluding
 * nodes already tried and /24 blocks already holding a copy. Re-posting a chunk
 * is idempotent, so probing is harmless; it costs bandwidth, not AR.
 */
async function findLongTermNodes(tx, data, { excludeNodes, excludeBlocks }) {
  const candidates = (await cfg.getNodes())
    .filter((n) => !excludeNodes.has(n) && !excludeBlocks.has(blockOf(n)))
    .slice(0, PROBE_CANDIDATES);
  const t0 = Date.now();
  const results = await Promise.all(
    candidates.map(async (n) => {
      const r = await postChunk(n, tx, data, 0);
      return { ...r, ms: Date.now() - t0 };
    })
  );
  // Several nodes calling our chunk itself invalid, and none accepting it, is not
  // "no node has room": it would repeat on every node, forever. Stop.
  const fatal = results.filter((r) => FATAL_CHUNK_ERRORS.includes(errorCode(r.text)));
  if (!results.some((r) => r.status === 200) && fatal.length >= 2) {
    throw new StorageError('chunk_fatal', `Chunk 0 rejected as ${errorCode(fatal[0].text)} by ${fatal.length} nodes.`);
  }
  const seen = new Set();
  return results
    .filter((r) => r.status === 200)
    .sort((a, b) => a.ms - b.ms)
    .filter((r) => !seen.has(blockOf(r.node)) && seen.add(blockOf(r.node)))
    .map((r) => r.node);
}

const holderList = (state) => Object.entries(state.holders || {});
const doneHolders = (state) => holderList(state).filter(([, h]) => h.done).map(([n]) => n);

/**
 * Send every chunk to `minHolders` nodes from different /24 blocks that answer
 * 200, in parallel across nodes, sequentially within a node.
 *
 * `state` is mutated and handed to `onState` after progress so the caller can
 * persist it (Upload.arweaveUploaderState); calling again with the saved state
 * resumes where it stopped. Shape: { holders: { [node]: { next, done, failed? } } }.
 *
 * Per node: 200 advances; 303 means "accepted but not kept long term" (Q12), so
 * that node is dropped and another found; a fatal error aborts (it would repeat
 * on any node); anything else is retried, then the node is dropped.
 *
 * @returns {Promise<object>} the final state, with >= minHolders done holders
 * @throws {StorageError} 'no_long_term_nodes' (retry later) or 'chunk_fatal' / 'spool_mismatch'
 */
async function pushChunks({ header, data, state = {}, minHolders = cfg.ARWEAVE_MIN_HOLDERS, onState = async () => {} }) {
  state.holders = state.holders || {};
  const tx = await transactionFor(header, data);
  const total = tx.chunks.chunks.length;

  const uploadTo = async (node) => {
    const h = state.holders[node];
    let retries = 0;
    while (h.next < total) {
      const r = await postChunk(node, tx, data, h.next);
      if (r.status === 200) {
        h.next++;
        retries = 0;
        if (h.next % 10 === 0) await onState(state);
        continue;
      }
      const code = errorCode(r.text);
      if (r.status === 303) {
        h.failed = 'temporary';
        return;
      }
      if (FATAL_CHUNK_ERRORS.includes(code)) {
        throw new StorageError('chunk_fatal', `Chunk ${h.next} rejected by ${node}: ${code}`);
      }
      if (++retries > CHUNK_RETRIES) {
        h.failed = `${r.status} ${String(code).slice(0, 80)}`;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000 * retries));
    }
    h.done = true;
  };

  while (doneHolders(state).length < minHolders) {
    const active = holderList(state).filter(([, h]) => !h.done && !h.failed).map(([n]) => n);
    const need = minHolders - doneHolders(state).length - active.length;
    if (need > 0) {
      const used = holderList(state).filter(([, h]) => !h.failed).map(([n]) => blockOf(n));
      const fresh = await findLongTermNodes(tx, data, {
        excludeNodes: new Set(Object.keys(state.holders)),
        excludeBlocks: new Set(used),
      });
      // The probe already delivered chunk 0 to each of these.
      for (const n of fresh.slice(0, need)) {
        state.holders[n] = { next: 1, done: total <= 1 };
        active.push(n);
      }
      if (!active.length) {
        await onState(state);
        throw new StorageError(
          'no_long_term_nodes',
          `Only ${doneHolders(state).length} of ${minHolders} holders; no other node answered 200 for chunk 0.`
        );
      }
    }
    await Promise.all(active.filter((n) => !state.holders[n].done).map(uploadTo));
    await onState(state);
  }
  return state;
}

// ─── Reads (proof-checked) ───────────────────────────────────────────────────

/**
 * GET /chunk/{absoluteOffset} and prove it belongs to the tx: the Merkle path
 * must lead to `dataRoot`, and sha256(chunk) must equal the path's leaf hash.
 * validatePath() checks the first but not the second. With both, a node can
 * withhold data but cannot substitute it.
 *
 * @returns {Promise<{ chunk: Buffer, rightBound: number } | { error: string }>}
 */
async function readChunkVerified(node, absoluteOffset, relativeOffset, dataRoot, dataSize) {
  const r = await http(node, `chunk/${absoluteOffset}`, { timeout: CHUNK_TIMEOUT_MS });
  if (r.status !== 200) return { error: `${r.status}` };
  const j = parseJson(r.text);
  if (!j || typeof j.chunk !== 'string' || typeof j.data_path !== 'string') return { error: 'bad_body' };
  const chunk = Buffer.from(j.chunk, 'base64url');
  const path = Buffer.from(j.data_path, 'base64url');
  const proof = await validatePath(Buffer.from(dataRoot, 'base64url'), relativeOffset, 0, dataSize, path);
  if (!proof) return { error: 'invalid_proof' };
  const leafHash = path.subarray(path.length - 64, path.length - 32);
  const chunkHash = crypto.createHash('sha256').update(chunk).digest();
  if (!chunkHash.equals(leafHash) || chunk.length !== proof.rightBound - proof.leftBound) {
    return { error: 'chunk_does_not_match_proof' };
  }
  return { chunk, leftBound: proof.leftBound, rightBound: proof.rightBound };
}

async function txOffsetFrom(node, txId) {
  const r = await http(node, `tx/${txId}/offset`);
  const j = r.status === 200 ? parseJson(r.text) : undefined;
  if (!j || !/^\d+$/.test(String(j.offset)) || !/^\d+$/.test(String(j.size))) return null;
  const end = BigInt(j.offset);
  const size = Number(j.size);
  return { start: end - BigInt(size) + 1n, size };
}

/**
 * Does each node serve this tx's data? Reads a sample of chunks (first, last, and
 * evenly spaced; all of them for small files) from each node, proof-checked and,
 * when `data` is given, compared byte for byte with what we uploaded.
 * Needs the tx mined: /tx/{id}/offset only exists once it is in a block.
 *
 * @returns {Promise<{ verified: string[], failures: Object<string,string> }>}
 */
async function verifyHolders({ txId, header, nodes, data }) {
  const size = Number(header.data_size);
  let bounds;
  if (data) {
    const tx = await transactionFor(header, data);
    bounds = tx.chunks.chunks.map((c) => [c.minByteRange, c.maxByteRange]);
  }
  const verified = [];
  const failures = {};
  await Promise.all(
    nodes.map(async (node) => {
      const loc = await txOffsetFrom(node, txId);
      if (!loc) return (failures[node] = 'no_offset');
      if (loc.size !== size) return (failures[node] = `size ${loc.size} != ${size}`);
      // Without the spool, chunk starts are found by walking: sample the first chunk
      // and the last byte. With it, sample exact chunk boundaries.
      const starts = bounds
        ? sampleIndexes(bounds.length).map((i) => bounds[i][0])
        : [0, size - 1];
      for (const rel of starts) {
        const got = await readChunkVerified(node, loc.start + BigInt(rel), rel, header.data_root, size);
        if (got.error) return (failures[node] = `chunk@${rel}: ${got.error}`);
        if (data && !got.chunk.equals(data.subarray(got.leftBound, got.rightBound))) {
          return (failures[node] = `chunk@${rel}: bytes differ from upload`);
        }
      }
      verified.push(node);
    })
  );
  return { verified, failures };
}

/**
 * Is a verifyHolders() failure proof that the node's copy is wrong (drop it now),
 * rather than "not readable yet" (no_offset, 404, a timeout), which a node that
 * just got the data or just saw the block can answer for a while (live,
 * 2026-10-13: `no_offset` from a holder right after mining)?
 */
function isDefinitiveVerifyFailure(reason) {
  return /bytes differ|invalid_proof|chunk_does_not_match_proof|^size /.test(String(reason));
}

function sampleIndexes(total) {
  if (total <= VERIFY_SAMPLE) return [...Array(total).keys()];
  const out = new Set([0, total - 1]);
  for (let k = 1; out.size < VERIFY_SAMPLE; k++) out.add(Math.floor((k * (total - 1)) / (VERIFY_SAMPLE - 1)));
  return [...out].sort((a, b) => a - b);
}

/**
 * Read a whole book back from raw nodes, chunk by chunk, every chunk
 * proof-checked against the signed header's data_root (D8). No 12 MiB limit,
 * unlike /tx/{id}/data (which answers tx_data_too_big above it, Q6). Gateways in
 * ARWEAVE_GATEWAY_URLS, if any are configured, are a last resort.
 *
 * A fresh book may sit on only the nodes we copied it to (Q13): pass them as
 * `preferNodes` (Upload.arweaveUploaderState.verified.nodes). Without a hint,
 * every healthy node is tried, in parallel batches, until one has the data.
 * (Found live 2026-10-13: trying only the first 8 healthy nodes missed both
 * holders of a just-stored book.)
 *
 * @param {string} arweaveHash
 * @param {{ preferNodes?: string[] }} [opts]
 * @returns {Promise<Buffer>} the stored ciphertext
 */
async function fetchEncrypted(arweaveHash, { preferNodes = [] } = {}) {
  if (!isValidArweaveHash(arweaveHash)) throw new Error(`Not an Arweave id: ${arweaveHash}`);
  const nodes = [...new Set([...preferNodes, ...(await cfg.getNodes())])];

  // The header is self-authenticating: its id is sha256(signature) and the
  // signature covers data_root. Verify both before trusting data_root.
  const { value: header } = await firstAnswer(
    `tx/${arweaveHash}`,
    (t) => parseJson(t),
    `the header of ${arweaveHash}`
  );
  const tx = new Transaction(header);
  // Compared as decoded bytes, never as strings (CLAUDE.md, id encoding): tx.id
  // comes from a node and arweaveHash from the caller.
  const idOk = sameTransactionId(
    toBase64Url(crypto.createHash('sha256').update(Buffer.from(tx.signature, 'base64url')).digest()),
    arweaveHash
  );
  if (!sameTransactionId(tx.id, arweaveHash) || !idOk || !(await cfg.offline.transactions.verify(tx))) {
    throw new StorageError('bad_header', `Header served for ${arweaveHash} does not verify.`);
  }
  const size = Number(tx.data_size);

  const errors = [];
  // Where the tx sits in the weave is chain data: any node that has indexed the
  // block knows it, holder or not. The first answer with the signed size is used;
  // a wrong offset would only make every proof check below fail, never pass.
  let loc = null;
  for (const node of nodes.slice(0, 10)) {
    loc = await txOffsetFrom(node, arweaveHash);
    if (loc && loc.size === size) break;
    loc = null;
  }

  if (loc) {
    // Each chunk: the last node that served one first, then preferred nodes,
    // then everyone else in parallel batches (most nodes do not hold a given book).
    let order = nodes;
    const parts = [];
    let rel = 0;
    const tryNodes = async (candidates, offset) => {
      for (let i = 0; i < candidates.length; i += 8) {
        const batch = candidates.slice(i, i + 8);
        const results = await Promise.all(
          batch.map(async (n) => ({ n, got: await readChunkVerified(n, loc.start + BigInt(offset), offset, tx.data_root, size) }))
        );
        const hit = results.find((r) => !r.got.error);
        if (hit) return hit;
      }
      return null;
    };
    while (rel < size) {
      const first = await readChunkVerified(order[0], loc.start + BigInt(rel), rel, tx.data_root, size);
      const hit = first.error ? await tryNodes(order.slice(1), rel) : { n: order[0], got: first };
      if (!hit) break;
      order = [hit.n, ...order.filter((x) => x !== hit.n)];
      parts.push(hit.got.chunk);
      rel = hit.got.rightBound;
    }
    if (rel === size) return Buffer.concat(parts, size);
    errors.push(`no node served byte ${rel} of ${size} (${nodes.length} nodes tried)`);
  } else {
    errors.push('no node knows where the tx sits (not mined, or not indexed yet)');
  }

  for (const gw of cfg.ARWEAVE_GATEWAY_URLS) {
    try {
      const res = await fetch(`${gw}/${arweaveHash}`, { signal: AbortSignal.timeout(120_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      // A gateway cannot be proof-checked chunk by chunk here; AES-GCM's auth
      // tag still rejects any altered byte at decryption.
      if (res.ok && buf.length === size) return buf;
      errors.push(`${gw}: ${res.status}, ${buf.length} bytes`);
    } catch (err) {
      errors.push(`${gw}: ${err.message}`);
    }
  }
  throw new cfg.ArweaveUnavailableError(`Could not read ${arweaveHash}: ${errors.join('; ') || 'no node had it'}`);
}

module.exports = {
  buildTags,
  prepareUpload,
  postHeader,
  isExpiredAnchorAnswer,
  pushChunks,
  verifyHolders,
  isDefinitiveVerifyFailure,
  readChunkVerified,
  fetchEncrypted,
  getTxStatus,
  getTipHeight,
  headerOf,
  toBase64Url,
  isValidArweaveHash,
  decodeTransactionId,
  sameTransactionId,
  truncateUtf8,
  tagsByteLength,
  blockOf,
  StorageError,
  MAX_TAGS_BYTES,
};
