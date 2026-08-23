// On-chain event listener — mirrors Alexandria contract events into Postgres.
//
// Strictly read-only. It watches logs and moves the `status` column on Upload;
// it never sends a transaction. The chain remains the source of truth, and this
// index is a cache that must be reconstructable by replaying from the deployment
// block — which is exactly what a cold start does.
//
// ─── The indexed-string problem ──────────────────────────────────────────────
//
// Every book-scoped event declares `string indexed arweaveHash`. A log topic is
// a fixed 32 bytes, so Solidity stores keccak256(utf8(hash)) and throws the
// plaintext away. It is not recoverable from the log — keccak256 is one-way, and
// ethers hands back an `Indexed` placeholder rather than a string.
//
// So resolution runs forwards, never backwards: hash the arweaveHashes we
// already know and match the digest. Two sources, in order of cost:
//
//   1. Upload.arweaveHashTopic — written at upload time. Covers every book this
//      backend uploaded, which in the PoC is all of them. One indexed query.
//   2. library.getUploaderHashes(uploader) — `uploader` is an indexed *address*
//      and so is readable straight off the log. Lists that archivist's books
//      on-chain, which are then hashed and matched. Covers books registered
//      without going through this backend.
//
// A log that resolves to neither is still recorded, with arweaveHash null and
// the raw topic kept, so it can be back-filled later rather than lost.
//
// ─── Restart and reorg safety ────────────────────────────────────────────────
//
// Event rows are upserted on (transactionHash, logIndex), so replaying a range
// is a no-op rather than a duplicate. Ranges are always processed oldest-first
// and always extend to the current safe head, so the last status write for a
// book is the newest one on chain regardless of where the scan started.

const prisma = require('../config/db');
const {
  getProvider,
  getContracts,
  contractAddresses,
  topicForHash,
  topicFromEventArg,
  CHAIN_ID,
  START_BLOCK,
  POLL_INTERVAL_MS,
} = require('../config/blockchain');
const { UPLOAD_STATUS } = require('./blockchain.service');

// ─── Configuration ───────────────────────────────────────────────────────────

const SYNC_ID = `chain-${CHAIN_ID}`;

// Blocks behind the head to stay. A shallow reorg that reverts a log we already
// applied would leave a wrong status until the next event for that book, and
// Base reorgs are shallow, so a small buffer removes almost all of that risk.
const CONFIRMATIONS = Number(process.env.CHAIN_CONFIRMATIONS || 3);

// Measured against the public endpoints: publicnode caps getLogs at a 50k block
// range, drpc rejects above ~10k. 10k works on both; a provider that dislikes it
// gets handled by the halving retry in fetchLogs().
const MAX_CHUNK = Number(process.env.CHAIN_LOG_CHUNK || 10_000);
const MIN_CHUNK = 500;

const POLL_MS = POLL_INTERVAL_MS;

// Events worth storing. Deliberately curated — Transfer/Approval/Paused/
// OwnershipTransferred would bury the interesting rows in noise.
const WATCHED = {
  library: ['UploadRegistered', 'UploadStatusChanged', 'AddressBlacklisted'],
  stake: [
    'Staked',
    'Unstaked',
    'slashed', // lower-case in the contract
    'challengeInitiated', // lower-case in the contract
    'ChallengeResolved',
    'LibrarianStaked',
    'LibrarianUnstaked',
    'LibrarianSlashed',
  ],
  rent: ['BookRented', 'BookPriceSet', 'BookDelisted', 'AddressBlacklisted'],
};

// ─── Log source registry ─────────────────────────────────────────────────────

let _registry;

/**
 * address (lowercase) → { name, contract, interface, topic0s }
 * Built once so every log can be routed to the right ABI by its emitter.
 */
function registry() {
  if (_registry) return _registry;

  const contracts = getContracts();
  _registry = new Map();

  for (const [name, eventNames] of Object.entries(WATCHED)) {
    const contract = contracts[name];
    const iface = contract.interface;
    const topic0s = new Set();

    for (const eventName of eventNames) {
      const fragment = iface.getEvent(eventName);
      if (!fragment) {
        // A renamed event after a redeploy must not fail silently — a listener
        // that quietly stops tracking challenges looks perfectly healthy.
        throw new Error(
          `[events] ${name} ABI has no event "${eventName}". Re-run scripts/sync-abis.js and update WATCHED.`
        );
      }
      topic0s.add(fragment.topicHash);
    }

    _registry.set(contract.target.toLowerCase(), { name, contract, iface, topic0s });
  }

  return _registry;
}

/** Every topic0 we care about, across all contracts. */
function watchedTopic0s() {
  const all = new Set();
  for (const entry of registry().values()) {
    for (const t of entry.topic0s) all.add(t);
  }
  return [...all];
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/**
 * Make a decoded ethers value JSON-safe for the Event.args column.
 * BigInt is the main offender — JSON.stringify throws on it outright.
 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    // An indexed dynamic type (string/bytes): only the digest exists on-chain.
    if (typeof value.hash === 'string' && value._isIndexed) {
      return { indexed: true, hash: value.hash };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

/**
 * Decode one log into a normalized record, or null if it is not one of ours.
 */
function decodeLog(log) {
  const entry = registry().get(log.address.toLowerCase());
  if (!entry || !entry.topic0s.has(log.topics[0])) return null;

  let parsed;
  try {
    parsed = entry.iface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null; // Same topic0 on a different ABI shape — not ours.
  }
  if (!parsed) return null;

  // Book-scoped events all declare arweaveHash as their first input. Reading it
  // off the fragment rather than assuming topics[1] keeps address-first events
  // like LibrarianStaked from being misread as books.
  const first = parsed.fragment.inputs[0];
  const isBookScoped = first && first.name === 'arweaveHash' && first.indexed;
  const arweaveHashTopic = isBookScoped ? topicFromEventArg(parsed.args[0]) : null;

  const args = {};
  parsed.fragment.inputs.forEach((input, i) => {
    args[input.name || `arg${i}`] = jsonSafe(parsed.args[i]);
  });

  return {
    contract: entry.name,
    eventName: parsed.name,
    arweaveHashTopic,
    args,
    blockNumber: log.blockNumber,
    logIndex: log.index,
    transactionHash: log.transactionHash,
  };
}

// ─── Topic → arweaveHash resolution ──────────────────────────────────────────

/**
 * Build topic → plaintext arweaveHash for a batch of decoded events.
 *
 * @param {Array<object>} events
 * @returns {Promise<Map<string, string>>}
 */
async function resolveHashes(events) {
  const topics = [...new Set(events.map((e) => e.arweaveHashTopic).filter(Boolean))];
  const resolved = new Map();
  if (!topics.length) return resolved;

  // Source 1 — books this backend uploaded. One indexed query for the batch.
  const rows = await prisma.upload.findMany({
    where: { arweaveHashTopic: { in: topics } },
    select: { arweaveHash: true, arweaveHashTopic: true },
  });
  for (const row of rows) resolved.set(row.arweaveHashTopic, row.arweaveHash);

  // Source 2 — anything left over, via the uploader address on the log.
  const unresolved = topics.filter((t) => !resolved.has(t));
  if (!unresolved.length) return resolved;

  const uploaders = new Set();
  for (const e of events) {
    if (e.arweaveHashTopic && !resolved.has(e.arweaveHashTopic) && e.args.uploader) {
      uploaders.add(e.args.uploader);
    }
  }

  const { library } = getContracts();
  for (const uploader of uploaders) {
    try {
      const hashes = await library.getUploaderHashes(uploader);
      for (const hash of hashes) {
        const topic = topicForHash(hash);
        if (unresolved.includes(topic)) resolved.set(topic, hash);
      }
    } catch (err) {
      console.warn(`[events] could not list uploads for ${uploader}: ${err.shortMessage || err.message}`);
    }
  }

  return resolved;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Apply a decoded event's side effect on the Upload row, if it has one.
 *
 * Only library events move status. That is on purpose: stake.sol and rent.sol
 * route their own status changes through library.updateUploadStatus(), which
 * emits UploadStatusChanged — so the library is the single authority and the
 * stake events are recorded as history rather than interpreted twice.
 */
async function applyStatus(event, arweaveHash) {
  if (!arweaveHash || event.contract !== 'library') return;

  if (event.eventName === 'UploadRegistered') {
    // Only advances a row that is still waiting for registration. Guarding on
    // status means replaying an old log cannot drag an approved book back to
    // pending.
    const { count } = await prisma.upload.updateMany({
      where: { arweaveHash, status: 'pending_stake' },
      data: { status: 'pending', onChainTxHash: event.transactionHash },
    });
    if (count) console.log(`[events] ${arweaveHash} registered on-chain → pending`);
    return;
  }

  if (event.eventName === 'UploadStatusChanged') {
    const next = UPLOAD_STATUS[Number(event.args.newStatus)];
    if (!next) {
      console.warn(`[events] unknown UploadStatus ${event.args.newStatus} for ${arweaveHash}`);
      return;
    }
    const { count } = await prisma.upload.updateMany({
      where: { arweaveHash },
      data: { status: next },
    });
    if (count) console.log(`[events] ${arweaveHash} → ${next}`);
  }
}

/**
 * Store a batch of events and apply their status effects, oldest first.
 */
async function persist(events, blockTimes) {
  const resolved = await resolveHashes(events);

  const ordered = [...events].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
  );

  for (const event of ordered) {
    const arweaveHash = event.arweaveHashTopic ? resolved.get(event.arweaveHashTopic) ?? null : null;
    const timestamp = blockTimes.get(event.blockNumber) ?? new Date();

    const data = {
      eventName: event.eventName,
      contract: event.contract,
      arweaveHash,
      arweaveHashTopic: event.arweaveHashTopic,
      args: event.args,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      transactionHash: event.transactionHash,
      timestamp,
    };

    // Upsert, not create: a re-scanned range must be a no-op. The update branch
    // also back-fills arweaveHash on a row stored before the book was known.
    await prisma.event.upsert({
      where: {
        transactionHash_logIndex: {
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
        },
      },
      create: data,
      update: { arweaveHash, arweaveHashTopic: event.arweaveHashTopic },
    });

    await applyStatus(event, arweaveHash);
  }
}

// ─── Fetching ────────────────────────────────────────────────────────────────

/** One getLogs call over a single chunk. */
async function fetchLogs(fromBlock, toBlock) {
  return getProvider().getLogs({
    address: Object.values(contractAddresses()),
    fromBlock,
    toBlock,
    topics: [watchedTopic0s()],
  });
}

/** Block number → timestamp, fetched once per distinct block. */
async function blockTimestamps(blockNumbers) {
  const provider = getProvider();
  const times = new Map();

  for (const bn of new Set(blockNumbers)) {
    try {
      const block = await provider.getBlock(bn);
      if (block) times.set(bn, new Date(Number(block.timestamp) * 1000));
    } catch {
      // A missing timestamp is not worth dropping the event over; persist()
      // falls back to now. The block number is the ordering key that matters.
    }
  }

  return times;
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

async function readCursor() {
  const row = await prisma.syncState.findUnique({ where: { id: SYNC_ID } });
  return row ? row.lastProcessedBlock : null;
}

async function writeCursor(blockNumber) {
  await prisma.syncState.upsert({
    where: { id: SYNC_ID },
    create: { id: SYNC_ID, lastProcessedBlock: blockNumber },
    update: { lastProcessedBlock: blockNumber },
  });
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Process every watched log in [fromBlock, toBlock] and advance the cursor.
 *
 * Walks the range in chunks and commits the cursor after each one. A cold start
 * spans ~3M blocks; doing the whole range before the first commit would mean a
 * crash at 99% restarts from zero, and would hold every log in memory at once.
 *
 * The chunk size only ever shrinks. Once a provider has rejected a span as too
 * wide, every later chunk in the same run would hit the same cap, so re-trying
 * the larger size each time just buys a guaranteed failure per chunk.
 *
 * @returns {Promise<number>} how many events were stored
 */
async function syncRange(fromBlock, toBlock) {
  if (fromBlock > toBlock) return 0;

  let cursor = fromBlock;
  let chunk = MAX_CHUNK;
  let stored = 0;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + chunk - 1, toBlock);

    let logs;
    try {
      logs = await fetchLogs(cursor, end);
    } catch (err) {
      // Providers disagree on the maximum getLogs span (publicnode 50k, drpc
      // ~10k). Halve and retry rather than hard-coding one provider's limit.
      if (chunk > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
        console.warn(`[events] getLogs ${cursor}-${end} failed, retrying with ${chunk}-block chunks`);
        continue;
      }
      throw err;
    }

    const events = logs.map(decodeLog).filter(Boolean);
    if (events.length) {
      const times = await blockTimestamps(events.map((e) => e.blockNumber));
      await persist(events, times);
      stored += events.length;
    }

    // Commit progress before moving on, so an interrupted backfill resumes here.
    await writeCursor(end);
    cursor = end + 1;
  }

  return stored;
}

/**
 * Catch up from the stored cursor to the current safe head.
 * @returns {Promise<{ from: number, to: number, events: number }|null>}
 */
async function syncToHead() {
  const provider = getProvider();
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;

  const cursor = await readCursor();
  const from = cursor === null ? START_BLOCK : cursor + 1;

  if (from > safeHead) return null; // Nothing new that is deep enough yet.

  const events = await syncRange(from, safeHead);
  return { from, to: safeHead, events };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let timer = null;
let running = false;
let stopped = false;
let lastError = null;

async function tick() {
  if (running || stopped) return;
  running = true;

  try {
    const result = await syncToHead();
    if (result && result.events) {
      console.log(`[events] synced ${result.from}-${result.to}: ${result.events} event(s)`);
    }
    lastError = null;
  } catch (err) {
    // Never rethrow: a transient RPC failure must not take the API down with
    // it. The cursor did not advance, so the range is retried on the next tick.
    lastError = err.shortMessage || err.message;
    console.error(`[events] sync failed: ${lastError}`);
  } finally {
    running = false;
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
}

/**
 * Start polling. Returns immediately — a cold backfill can span millions of
 * blocks, and the HTTP server must not wait on it.
 *
 * @returns {{ stop: () => void }}
 */
function start() {
  if (timer || running) return { stop };

  stopped = false;
  const addresses = contractAddresses();
  console.log(
    `[events] listener starting on chain ${CHAIN_ID} (library ${addresses.library}), ` +
      `polling every ${POLL_MS}ms, ${CONFIRMATIONS} confirmations`
  );

  readCursor()
    .then((cursor) => {
      if (cursor === null) {
        console.log(`[events] no cursor stored — cold backfill from block ${START_BLOCK}`);
      } else {
        console.log(`[events] resuming from block ${cursor + 1}`);
      }
    })
    .catch(() => {});

  tick();
  return { stop };
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Listener state, for the chain status endpoint.
 */
async function getSyncStatus() {
  const provider = getProvider();
  const [cursor, head, eventCount] = await Promise.all([
    readCursor(),
    provider.getBlockNumber().catch(() => null),
    prisma.event.count().catch(() => null),
  ]);

  const behind = cursor !== null && head !== null ? Math.max(0, head - CONFIRMATIONS - cursor) : null;

  // Base produces a block roughly every 2s while the listener polls every
  // POLL_MS, so a healthy listener is always a handful of blocks behind. Judging
  // "caught up" as exactly zero would report the normal steady state as a
  // failure; the tolerance is one poll interval's worth of blocks.
  const lagTolerance = Math.max(CONFIRMATIONS, Math.ceil(POLL_MS / 2000));

  return {
    chainId: CHAIN_ID,
    running: Boolean(timer) || running,
    startBlock: START_BLOCK,
    lastProcessedBlock: cursor,
    headBlock: head,
    confirmations: CONFIRMATIONS,
    blocksBehind: behind,
    // A cold index reports its progress through the backfill rather than just
    // "behind by 3 million", which reads like a failure.
    caughtUp: behind !== null && behind <= lagTolerance,
    lagTolerance,
    storedEvents: eventCount,
    lastError,
    contracts: contractAddresses(),
  };
}

module.exports = {
  start,
  stop,
  tick,
  syncRange,
  syncToHead,
  getSyncStatus,
  decodeLog,
  resolveHashes,
  persist,
  readCursor,
  writeCursor,
  WATCHED,
  SYNC_ID,
  CONFIRMATIONS,
};
