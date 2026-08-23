// Phase 6b test: on-chain read paths + event listener.
//
// Run: node tests/chainReads.test.js
//
// The chain is replaced with fake contracts, but the *event encoding is real* —
// logs are produced with ethers from the committed ABIs, so the decoder is
// tested against bytes Solidity would actually emit rather than against an
// assumption about them. That matters most for `string indexed arweaveHash`,
// where the plaintext genuinely is not in the log.
//
// Postgres is a small in-memory stand-in implementing the subset of Prisma this
// code uses (findUnique/findMany/updateMany/count, event.upsert with a compound
// unique key, syncState upsert).
//
// Tests:
//   1-10.  decodeLog: real encoding, indexed-string handling, arg serialization
//  11-17.  resolveHashes: topic → hash via the index, and via getUploaderHashes
//  18-26.  persist: status transitions, no downgrades, idempotent replay
//  27-32.  syncRange / cursor handling
//  33-41.  blockchain.service: revert vs. network failure translation
//  42-53.  rental + stake + chain controllers

require('dotenv').config();

// Small chunks so a range can be walked in a few steps and the incremental
// cursor commit is observable. Must be set before the listener is required.
process.env.CHAIN_LOG_CHUNK = '1000';

const path = require('path');
const { ethers } = require('ethers');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ ${testName}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub installation — must happen before anything under test is required
// ─────────────────────────────────────────────────────────────────────────────

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    path: path.dirname(resolved),
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return exports;
}

// Keep the Irys and Lit SDKs off the require path — no read path here uses them.
stub('../config/irys', { getIrys: async () => ({}), IRYS_GATEWAY_URL: 'https://gateway.test.invalid' });
stub('../config/lit', {
  LIT_PKP_ID: 'pkp_test_0001',
  LIT_API_KEY: 'test-key',
  LIT_API_URL: 'https://api.test.invalid/core/v1',
  litApiCall: async () => {
    throw new Error('read paths must never call Lit');
  },
  disconnectLit: async () => {},
});

// ─── Fake chain ──────────────────────────────────────────────────────────────

const libraryAbi = require('../abis/library.json');
const stakeAbi = require('../abis/stake.json');
const rentAbi = require('../abis/rent.json');
const tokenAbi = require('../abis/token.json');
const paymentAbi = require('../abis/payment.json');

const IFACES = {
  library: new ethers.Interface(libraryAbi.abi),
  stake: new ethers.Interface(stakeAbi.abi),
  rent: new ethers.Interface(rentAbi.abi),
};

// Mutable chain state the fake contracts read from.
const chain = {
  uploads: new Map(), // arweaveHash → { uploader, timestamp, status, metadata }
  uploaderHashes: new Map(), // address → [arweaveHash]
  stakes: new Map(),
  challenges: new Map(),
  rentals: new Map(), // `${hash}:${addr}` → expiry seconds
  blacklisted: new Set(),
  bookPrices: new Map(),
  delisted: new Set(),
  rentPaused: false,
  // Registrar state
  authorizedCallers: new Set(),
  libraryOwner: '0x5F47ecD28155790f1271df965373fD9aCEA643b9',
  signer: null,
  signerError: null,
  signerBalance: 0n,
  sentTransactions: [],
  staticCallRevert: null,
  sendRevert: null,
  logs: [],
  head: 42_800_000,
  // Force a specific failure out of a named call, to test error translation.
  failures: new Map(),
  getLogsCalls: 0,
  getLogsFailAfter: null,
};

function revert(reason) {
  const err = new Error(`execution reverted: ${reason}`);
  err.code = 'CALL_EXCEPTION';
  err.reason = reason;
  throw err;
}

function networkDown() {
  const err = new Error('could not detect network');
  err.code = 'NETWORK_ERROR';
  throw err;
}

function maybeFail(name) {
  const mode = chain.failures.get(name);
  if (mode === 'network') networkDown();
  if (typeof mode === 'string') revert(mode);
}

const ZERO = '0x0000000000000000000000000000000000000000';

const fakeContracts = {
  library: {
    interface: IFACES.library,
    target: libraryAbi.address,
    async getUpload(hash) {
      maybeFail('library.getUpload');
      const u = chain.uploads.get(hash);
      if (!u) revert('Upload not found');
      return {
        arweaveHash: hash,
        uploader: u.uploader,
        timestamp: BigInt(u.timestamp),
        status: BigInt(u.status),
        metadata: u.metadata ?? '',
      };
    },
    async getUploadStatus(hash) {
      maybeFail('library.getUploadStatus');
      const u = chain.uploads.get(hash);
      if (!u) revert('Upload not found');
      return BigInt(u.status);
    },
    async getUploaderHashes(addr) {
      maybeFail('library.getUploaderHashes');
      return chain.uploaderHashes.get(addr.toLowerCase()) ?? [];
    },
    async uploadExists(hash) {
      maybeFail('library.uploadExists');
      return chain.uploads.has(hash);
    },
    async authorizedCallers(addr) {
      maybeFail('library.authorizedCallers');
      return chain.authorizedCallers.has(addr.toLowerCase());
    },
    async owner() {
      return chain.libraryOwner;
    },
  },
  stake: {
    interface: IFACES.stake,
    target: stakeAbi.address,
    async getStakeStatus(hash) {
      maybeFail('stake.getStakeStatus');
      const s = chain.stakes.get(hash);
      return s
        ? { staker: s.staker, amount: BigInt(s.amount), timestamp: BigInt(s.timestamp), active: s.active }
        : { staker: ZERO, amount: 0n, timestamp: 0n, active: false };
    },
    async challenges(hash) {
      maybeFail('stake.challenges');
      const c = chain.challenges.get(hash);
      return c
        ? { challenger: c.challenger, timestamp: BigInt(c.timestamp), resolved: c.resolved, reason: c.reason }
        : { challenger: ZERO, timestamp: 0n, resolved: false, reason: '' };
    },
    async CHALLENGE_PERIOD() {
      return BigInt(14 * 24 * 60 * 60);
    },
  },
  rent: {
    interface: IFACES.rent,
    target: rentAbi.address,
    async rentals(hash, addr) {
      maybeFail('rent.rentals');
      return BigInt(chain.rentals.get(`${hash}:${addr.toLowerCase()}`) ?? 0);
    },
    async blacklisted(addr) {
      return chain.blacklisted.has(addr.toLowerCase());
    },
    async paused() {
      return chain.rentPaused;
    },
    async isRentalActive(hash, addr) {
      // Mirrors the real modifier: a paused contract makes even this view revert.
      if (chain.rentPaused) revert('EnforcedPause');
      maybeFail('rent.isRentalActive');
      const expiry = chain.rentals.get(`${hash}:${addr.toLowerCase()}`) ?? 0;
      return expiry > Math.floor(Date.now() / 1000) && !chain.blacklisted.has(addr.toLowerCase());
    },
    async bookPrices(hash) {
      return BigInt(chain.bookPrices.get(hash) ?? 0);
    },
    async delisted(hash) {
      return chain.delisted.has(hash);
    },
  },
  token: { interface: new ethers.Interface(tokenAbi.abi), target: tokenAbi.address },
  payment: { interface: new ethers.Interface(paymentAbi.abi), target: paymentAbi.address },
};

const fakeProvider = {
  pollingInterval: 0,
  async getBlockNumber() {
    maybeFail('provider.getBlockNumber');
    return chain.head;
  },
  async getLogs({ fromBlock, toBlock }) {
    chain.getLogsCalls++;
    // Simulate an RPC dying partway through a multi-chunk backfill.
    if (chain.getLogsFailAfter !== null && chain.getLogsCalls > chain.getLogsFailAfter) networkDown();
    maybeFail('provider.getLogs');
    return chain.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  },
  async getBlock(bn) {
    return { timestamp: 1_760_000_000 + bn };
  },
};

// Registrar signer + write handle. `registerUpload` records what it was called
// with so the tests can assert the *archivist* is passed as `uploader`, not the
// backend — getting that backwards would make stake.stake() impossible forever.
const fakeLibraryWriter = {
  registerUpload: Object.assign(
    async (arweaveHash, uploader, metadata) => {
      if (chain.sendRevert) revert(chain.sendRevert);
      chain.sentTransactions.push({ arweaveHash, uploader, metadata });
      const hash = `0x${'e'.repeat(64)}`;
      return {
        hash,
        wait: async () => ({ hash, blockNumber: chain.head, gasUsed: 120000n }),
      };
    },
    {
      staticCall: async (arweaveHash, uploader, metadata) => {
        if (chain.staticCallRevert) revert(chain.staticCallRevert);
        return undefined;
      },
    }
  ),
};

stub('../config/blockchain', {
  getProvider: () => fakeProvider,
  getContracts: () => fakeContracts,
  getSigner: () =>
    chain.signer
      ? { address: chain.signer, provider: { getBalance: async () => chain.signerBalance } }
      : null,
  signerError: () => chain.signerError,
  getLibraryWriter: () => (chain.signer ? fakeLibraryWriter : null),
  BACKEND_WALLET_ADDRESS: '',
  contractAddresses: () => ({
    library: libraryAbi.address,
    stake: stakeAbi.address,
    rent: rentAbi.address,
    token: tokenAbi.address,
    payment: paymentAbi.address,
  }),
  // The real implementations — these are pure and are exactly what is under test.
  topicForHash: (h) => ethers.id(h),
  topicFromEventArg: (arg) => {
    if (arg == null) return null;
    if (typeof arg === 'string') return ethers.isHexString(arg, 32) ? arg : ethers.id(arg);
    if (typeof arg === 'object' && typeof arg.hash === 'string') return arg.hash;
    return null;
  },
  CHAIN_ID: 84532,
  POLL_INTERVAL_MS: 12000,
  DEPLOYMENT_BLOCK: 42_758_328,
  START_BLOCK: 42_758_328,
  rpcUrls: () => ['https://test.invalid'],
});

// ─── Fake Postgres ───────────────────────────────────────────────────────────

const db = { uploads: [], events: new Map(), syncState: new Map(), calls: [] };

function applySelect(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, wanted] of Object.entries(select)) if (wanted) out[key] = row[key];
  return out;
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === 'object' && 'in' in cond) return cond.in.includes(row[key]);
    return row[key] === cond;
  });
}

stub('../config/db', {
  upload: {
    findUnique: async (args) => {
      db.calls.push({ op: 'upload.findUnique', args });
      const row = db.uploads.find((r) => r.arweaveHash === args.where.arweaveHash);
      return row ? applySelect(row, args.select) : null;
    },
    findMany: async (args = {}) => {
      db.calls.push({ op: 'upload.findMany', args });
      return db.uploads.filter((r) => matchesWhere(r, args.where)).map((r) => applySelect(r, args.select));
    },
    updateMany: async (args) => {
      db.calls.push({ op: 'upload.updateMany', args });
      const rows = db.uploads.filter((r) => matchesWhere(r, args.where));
      rows.forEach((r) => Object.assign(r, args.data));
      return { count: rows.length };
    },
    count: async (args = {}) => db.uploads.filter((r) => matchesWhere(r, args.where)).length,
  },
  event: {
    upsert: async (args) => {
      db.calls.push({ op: 'event.upsert', args });
      const { transactionHash, logIndex } = args.where.transactionHash_logIndex;
      const key = `${transactionHash}:${logIndex}`;
      if (db.events.has(key)) {
        Object.assign(db.events.get(key), args.update);
      } else {
        db.events.set(key, { ...args.create });
      }
      return db.events.get(key);
    },
    count: async () => db.events.size,
  },
  syncState: {
    findUnique: async (args) => db.syncState.get(args.where.id) ?? null,
    upsert: async (args) => {
      const existing = db.syncState.get(args.where.id);
      const next = existing ? { ...existing, ...args.update } : { ...args.create };
      db.syncState.set(args.where.id, next);
      return next;
    },
  },
  $connect: async () => {},
  $disconnect: async () => {},
});

// ─────────────────────────────────────────────────────────────────────────────
// Modules under test (required after stubs are installed)
// ─────────────────────────────────────────────────────────────────────────────

const listener = require('../services/eventListener.service');
const chainService = require('../services/blockchain.service');
const { getRentalStatus, getDecryptParams, getBookRentalInfo } = require('../controller/rental.controller');
const { getStakeStatusForHash } = require('../controller/stake.controller');
const { getChainStatus } = require('../controller/chain.controller');
const { isValidWalletAddress } = require('../middleware/auth.middleware');
const { registerOnChain, preflight, buildMetadata } = require('../services/registration.service');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function hash(seed) {
  return seed.padEnd(43, 'A').slice(0, 43);
}

const HASH_A = hash('meditations');
const HASH_B = hash('origin');
const HASH_EXTERNAL = hash('registeredelsewhere');
const ARCHIVIST = '0x1111111111111111111111111111111111111111';
const READER = '0x2222222222222222222222222222222222222222';
const LIBRARIAN = '0x3333333333333333333333333333333333333333';

let logCounter = 0;

/**
 * Build a real log for `eventName` using the committed ABI. ethers performs the
 * indexed-parameter encoding, so a `string` argument is hashed exactly the way
 * Solidity would hash it.
 */
function makeLog(contractName, eventName, values, { blockNumber = 42_800_000, txHash } = {}) {
  const iface = IFACES[contractName];
  const fragment = iface.getEvent(eventName);
  const { data, topics } = iface.encodeEventLog(fragment, values);
  const index = logCounter++;
  return {
    address: fakeContracts[contractName].target,
    topics,
    data,
    blockNumber,
    index,
    transactionHash: txHash ?? `0x${index.toString(16).padStart(64, '0')}`,
  };
}

function makeUploadRow(overrides = {}) {
  return {
    arweaveHash: HASH_A,
    arweaveHashTopic: ethers.id(HASH_A),
    title: 'Meditations',
    author: 'Marcus Aurelius',
    category: 'philosophy',
    uploader: ARCHIVIST,
    status: 'pending_stake',
    litEncryptedKeyId: 'SEALED_KEY_CIPHERTEXT',
    litDataToEncryptHash: 'LIT_INTEGRITY_HASH',
    encryptionIv: 'aXYtYmFzZTY0',
    encryptionAuthTag: 'dGFnLWJhc2U2NA',
    onChainTxHash: null,
    ...overrides,
  };
}

function reset() {
  chain.uploads.clear();
  chain.uploaderHashes.clear();
  chain.stakes.clear();
  chain.challenges.clear();
  chain.rentals.clear();
  chain.blacklisted.clear();
  chain.bookPrices.clear();
  chain.delisted.clear();
  chain.failures.clear();
  chain.rentPaused = false;
  chain.logs = [];
  chain.head = 42_800_000;
  chain.getLogsCalls = 0;
  chain.getLogsFailAfter = null;
  chain.authorizedCallers.clear();
  chain.libraryOwner = '0x5F47ecD28155790f1271df965373fD9aCEA643b9';
  chain.signer = null;
  chain.signerError = null;
  chain.signerBalance = 0n;
  chain.sentTransactions = [];
  chain.staticCallRevert = null;
  chain.sendRevert = null;
  db.uploads = [];
  db.events.clear();
  db.syncState.clear();
  db.calls = [];
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function call(handler, params) {
  const res = makeRes();
  let nextErr = null;
  await handler({ params, query: {} }, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-10. decodeLog
// ─────────────────────────────────────────────────────────────────────────────

async function testDecoding() {
  section('decodeLog — real ABI encoding');
  reset();

  const log = makeLog('library', 'UploadRegistered', [HASH_A, ARCHIVIST, 'Meditations|Marcus Aurelius']);
  const decoded = listener.decodeLog(log);

  assert(decoded !== null, 'a watched library log decodes');
  assert(decoded.eventName === 'UploadRegistered', 'event name is read from the ABI');
  assert(decoded.contract === 'library', 'log is routed to the emitting contract');

  // The point of the whole design: the hash is not in the log.
  assert(
    !JSON.stringify(log).includes(HASH_A),
    'plaintext arweaveHash does NOT appear anywhere in the encoded log'
  );
  assert(
    decoded.arweaveHashTopic === ethers.id(HASH_A),
    'arweaveHashTopic is keccak256 of the hash, recovered from the topic'
  );
  assert(
    decoded.args.arweaveHash && decoded.args.arweaveHash.indexed === true,
    'the indexed string arg is serialized as a digest placeholder, not a string'
  );
  assert(
    decoded.args.metadata === 'Meditations|Marcus Aurelius',
    'non-indexed string args survive decoding intact'
  );
  assert(decoded.args.uploader.toLowerCase() === ARCHIVIST, 'indexed address args stay readable');

  // An address-first event must not be mistaken for a book-scoped one.
  const libLog = makeLog('stake', 'LibrarianStaked', [LIBRARIAN, 50n * 10n ** 18n]);
  const libDecoded = listener.decodeLog(libLog);
  assert(
    libDecoded.arweaveHashTopic === null,
    'LibrarianStaked has no arweaveHash — its indexed address is not read as a book topic'
  );
  assert(
    libDecoded.args.amount === '50000000000000000000',
    'uint256 args serialize to strings (BigInt would break JSON.stringify)'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 11-17. resolveHashes
// ─────────────────────────────────────────────────────────────────────────────

async function testResolution() {
  section('resolveHashes — topic back to plaintext hash');
  reset();

  db.uploads = [makeUploadRow()];

  const known = listener.decodeLog(makeLog('library', 'UploadRegistered', [HASH_A, ARCHIVIST, 'meta']));
  let resolved = await listener.resolveHashes([known]);
  assert(resolved.get(ethers.id(HASH_A)) === HASH_A, 'a topic resolves via Upload.arweaveHashTopic');

  // A book this backend never uploaded: not in Postgres, but the uploader is
  // readable off the log, so the library can be asked what they registered.
  chain.uploaderHashes.set(ARCHIVIST.toLowerCase(), [HASH_A, HASH_EXTERNAL]);
  const external = listener.decodeLog(
    makeLog('library', 'UploadRegistered', [HASH_EXTERNAL, ARCHIVIST, 'meta'])
  );
  resolved = await listener.resolveHashes([external]);
  assert(
    resolved.get(ethers.id(HASH_EXTERNAL)) === HASH_EXTERNAL,
    'an unknown topic resolves via library.getUploaderHashes(uploader)'
  );

  // A book with no local row and no uploader on the event stays unresolved,
  // rather than being guessed at.
  chain.uploaderHashes.clear();
  const orphan = listener.decodeLog(makeLog('rent', 'BookRented', [HASH_B, READER, 1_800_000_000n, 86400n]));
  resolved = await listener.resolveHashes([orphan]);
  assert(resolved.size === 0, 'an unresolvable topic is left unresolved, not fabricated');
  assert(orphan.arweaveHashTopic === ethers.id(HASH_B), 'the raw topic is still captured for later back-fill');

  // Batch lookup should be one query, not one per event.
  db.uploads = [makeUploadRow(), makeUploadRow({ arweaveHash: HASH_B, arweaveHashTopic: ethers.id(HASH_B) })];
  db.calls = [];
  const batch = [
    listener.decodeLog(makeLog('library', 'UploadStatusChanged', [HASH_A, 0, 2])),
    listener.decodeLog(makeLog('library', 'UploadStatusChanged', [HASH_B, 0, 1])),
  ];
  resolved = await listener.resolveHashes(batch);
  const findManyCalls = db.calls.filter((c) => c.op === 'upload.findMany');
  assert(resolved.size === 2, 'a batch of topics resolves together');
  assert(findManyCalls.length === 1, 'resolution is one indexed query for the whole batch');
  assert(
    Array.isArray(findManyCalls[0].args.where.arweaveHashTopic.in),
    'the batch query filters on arweaveHashTopic with an IN clause'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 18-26. persist + status transitions
// ─────────────────────────────────────────────────────────────────────────────

async function testPersist() {
  section('persist — status transitions and idempotency');
  reset();

  db.uploads = [makeUploadRow()];
  const registered = listener.decodeLog(
    makeLog('library', 'UploadRegistered', [HASH_A, ARCHIVIST, 'meta'], { txHash: `0x${'a'.repeat(64)}` })
  );
  await listener.persist([registered], new Map([[registered.blockNumber, new Date()]]));

  assert(db.uploads[0].status === 'pending', 'UploadRegistered advances pending_stake → pending');
  assert(
    db.uploads[0].onChainTxHash === `0x${'a'.repeat(64)}`,
    'UploadRegistered records the registration transaction hash'
  );
  assert(db.events.size === 1, 'the event is stored');

  const stored = [...db.events.values()][0];
  assert(stored.arweaveHash === HASH_A, 'the stored event carries the resolved plaintext hash');
  assert(stored.arweaveHashTopic === ethers.id(HASH_A), 'the stored event also keeps the raw topic');
  assert(stored.contract === 'library', 'the stored event records which contract emitted it');

  // Replay the same log — a restart re-scans an overlapping range on purpose.
  await listener.persist([registered], new Map([[registered.blockNumber, new Date()]]));
  assert(db.events.size === 1, 'replaying a log upserts rather than duplicating');

  // Status enum → string.
  const approved = listener.decodeLog(makeLog('library', 'UploadStatusChanged', [HASH_A, 0, 2]));
  await listener.persist([approved], new Map());
  assert(db.uploads[0].status === 'approved', 'UploadStatusChanged maps enum 2 → "approved"');

  const challenged = listener.decodeLog(makeLog('library', 'UploadStatusChanged', [HASH_A, 2, 1]));
  await listener.persist([challenged], new Map());
  assert(db.uploads[0].status === 'challenged', 'UploadStatusChanged maps enum 1 → "challenged"');

  // A replayed registration must not drag an advanced row backwards.
  await listener.persist([registered], new Map());
  assert(
    db.uploads[0].status === 'challenged',
    'replaying UploadRegistered does NOT downgrade an already-advanced row'
  );

  // Events are applied oldest-first even when handed to persist out of order.
  reset();
  db.uploads = [makeUploadRow({ status: 'pending' })];
  const toRejected = listener.decodeLog(
    makeLog('library', 'UploadStatusChanged', [HASH_A, 1, 3], { blockNumber: 42_800_010 })
  );
  const toChallenged = listener.decodeLog(
    makeLog('library', 'UploadStatusChanged', [HASH_A, 0, 1], { blockNumber: 42_800_005 })
  );
  await listener.persist([toRejected, toChallenged], new Map());
  assert(
    db.uploads[0].status === 'rejected',
    'out-of-order input is sorted by block so the newest status wins'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 27-32. syncRange + cursor
// ─────────────────────────────────────────────────────────────────────────────

async function testSync() {
  section('syncRange — cursor handling');
  reset();

  db.uploads = [makeUploadRow()];
  chain.logs = [makeLog('library', 'UploadRegistered', [HASH_A, ARCHIVIST, 'meta'], { blockNumber: 42_790_000 })];

  const count = await listener.syncRange(42_780_000, 42_800_000);
  assert(count === 1, 'syncRange returns the number of watched events found');
  assert((await listener.readCursor()) === 42_800_000, 'the cursor advances to the end of the range');
  assert(db.uploads[0].status === 'pending', 'a synced range applies its status effects');

  // Unwatched noise must not be stored.
  reset();
  db.uploads = [makeUploadRow()];
  chain.logs = [
    {
      address: libraryAbi.address,
      topics: [ethers.id('SomethingElse(address)'), ethers.zeroPadValue(ARCHIVIST, 32)],
      data: '0x',
      blockNumber: 42_790_000,
      index: 0,
      transactionHash: `0x${'b'.repeat(64)}`,
    },
  ];
  const noise = await listener.syncRange(42_780_000, 42_800_000);
  assert(noise === 0, 'an unwatched event topic is ignored');
  assert(db.events.size === 0, 'nothing is stored for unwatched topics');
  assert((await listener.readCursor()) === 42_800_000, 'the cursor still advances past a quiet range');

  // A cold start begins at the deployment block, not genesis.
  reset();
  chain.head = 42_800_000;
  const result = await listener.syncToHead();
  assert(result.from === 42_758_328, 'a cold start begins at the earliest contract deployment block');
  assert(
    result.to === 42_800_000 - listener.CONFIRMATIONS,
    'syncToHead stays CONFIRMATIONS blocks behind the head'
  );

  // Progress must survive an RPC dying mid-backfill. With 1000-block chunks,
  // failing after 3 calls means blocks 0-2999 of the range are done and
  // committed; restarting from scratch would be the bug.
  reset();
  chain.getLogsFailAfter = 3;
  let crashed = null;
  try {
    await listener.syncRange(42_780_000, 42_790_000);
  } catch (err) {
    crashed = err;
  }
  assert(crashed !== null, 'a persistent RPC failure propagates out of syncRange');
  assert(
    (await listener.readCursor()) === 42_782_999,
    'the cursor holds the last successfully processed chunk, so a backfill resumes instead of restarting'
  );

  // And a later chunk's events are still captured once the range completes.
  reset();
  db.uploads = [makeUploadRow()];
  chain.logs = [
    makeLog('library', 'UploadRegistered', [HASH_A, ARCHIVIST, 'meta'], { blockNumber: 42_789_500 }),
  ];
  const late = await listener.syncRange(42_780_000, 42_790_000);
  assert(late === 1, 'an event in a late chunk is still found and stored');
  assert((await listener.readCursor()) === 42_790_000, 'the cursor lands exactly on the requested end block');
}

// ─────────────────────────────────────────────────────────────────────────────
// 33-41. blockchain.service error translation
// ─────────────────────────────────────────────────────────────────────────────

async function testChainService() {
  section('blockchain.service — revert vs. network failure');
  reset();

  const missing = await chainService.getUploadOnChain(HASH_A);
  assert(missing.registered === false, '"Upload not found" becomes registered:false, not an error');
  assert((await chainService.getUploadStatusOnChain(HASH_A)) === null, 'unknown status reads as null');

  chain.uploads.set(HASH_A, { uploader: ARCHIVIST, timestamp: 1_760_000_000, status: 2, metadata: 'meta' });
  const found = await chainService.getUploadOnChain(HASH_A);
  assert(found.registered === true && found.status === 'approved', 'a registered upload decodes its status');
  assert(found.timestamp === new Date(1_760_000_000 * 1000).toISOString(), 'timestamps become ISO strings');

  // A transport failure must never look like "not registered".
  chain.failures.set('library.getUpload', 'network');
  let threw = null;
  try {
    await chainService.getUploadOnChain(HASH_A);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof chainService.ChainError, 'an RPC failure raises ChainError');
  assert(threw.status === 503, 'an RPC failure maps to 503, not a false "not found"');
  chain.failures.clear();

  // Stake: a zero struct means never staked.
  const unstaked = await chainService.getStakeStatus(HASH_A);
  assert(unstaked.staked === false, 'a zeroed stake struct reads as staked:false');

  chain.stakes.set(HASH_A, {
    staker: ARCHIVIST,
    amount: (100n * 10n ** 18n).toString(),
    timestamp: 1_760_000_000,
    active: true,
  });
  const staked = await chainService.getStakeStatus(HASH_A);
  assert(staked.stakeAmount === '100000000000000000000', 'stake amounts stay exact as strings');
  assert(staked.stakeAmountAlex === '100.0', 'stake amounts are also formatted in whole ALEX');

  // Rent paused: the view reverts, and that must not read as a plain "no".
  chain.rentPaused = true;
  const paused = await chainService.isRentalActive(HASH_A, READER);
  assert(
    paused.active === false && paused.available === false,
    'a paused Rent contract fails closed but reports itself undeterminable'
  );
  assert(paused.reason === 'rent_contract_paused', 'the paused state is named in the response');
}

// ─────────────────────────────────────────────────────────────────────────────
// 42-53. Controllers
// ─────────────────────────────────────────────────────────────────────────────

async function testControllers() {
  section('rental / stake / chain controllers');
  reset();

  // --- validation --------------------------------------------------------
  let r = await call(getRentalStatus, { arweaveHash: 'too-short', address: READER });
  assert(r.res.statusCode === 400 && r.res.body.error === 'invalid_hash', 'a malformed hash is a 400');

  r = await call(getRentalStatus, { arweaveHash: 'a'.repeat(44), address: READER });
  assert(r.res.statusCode === 400, 'a 44-char base58-style id is rejected (encoding trap held)');

  r = await call(getRentalStatus, { arweaveHash: HASH_A, address: '0xnope' });
  assert(r.res.statusCode === 400 && r.res.body.error === 'invalid_address', 'a malformed address is a 400');

  // --- rental status ------------------------------------------------------
  r = await call(getRentalStatus, { arweaveHash: HASH_A, address: READER });
  assert(r.res.statusCode === 200 && r.res.body.active === false, 'no rental reads as active:false');

  chain.rentals.set(`${HASH_A}:${READER.toLowerCase()}`, Math.floor(Date.now() / 1000) + 3600);
  r = await call(getRentalStatus, { arweaveHash: HASH_A, address: READER });
  assert(r.res.statusCode === 200 && r.res.body.active === true, 'an unexpired rental reads as active');
  assert(typeof r.res.body.expiry === 'string', 'the rental expiry is returned as an ISO timestamp');

  chain.rentPaused = true;
  r = await call(getRentalStatus, { arweaveHash: HASH_A, address: READER });
  assert(r.res.statusCode === 503, 'a paused Rent contract makes rental status a 503');
  chain.rentPaused = false;

  // --- decrypt params -----------------------------------------------------
  db.uploads = [makeUploadRow({ status: 'approved' })];

  r = await call(getDecryptParams, { arweaveHash: HASH_B, address: READER });
  assert(r.res.statusCode === 404, 'decrypt params for an unknown book is a 404');

  r = await call(getDecryptParams, { arweaveHash: HASH_A, address: LIBRARIAN });
  assert(
    r.res.statusCode === 403 && r.res.body.error === 'no_active_rental',
    'decrypt params without a rental is a 403'
  );
  assert(
    r.res.body.litEncryptedKeyId === undefined,
    'a denied request leaks no key material at all'
  );

  r = await call(getDecryptParams, { arweaveHash: HASH_A, address: READER });
  assert(r.res.statusCode === 200 && r.res.body.grantedVia === 'rental', 'an active rental unlocks the payload');
  assert(
    r.res.body.litEncryptedKeyId === 'SEALED_KEY_CIPHERTEXT' &&
      r.res.body.encryptionIv === 'aXYtYmFzZTY0' &&
      r.res.body.encryptionAuthTag === 'dGFnLWJhc2U2NA',
    'the payload carries the sealed key plus both AES-GCM parameters'
  );

  // The archivist can never rent their own book — rentBook() forbids it — so
  // the uploader must be let through explicitly or they lose their own upload.
  r = await call(getDecryptParams, { arweaveHash: HASH_A, address: ARCHIVIST });
  assert(
    r.res.statusCode === 200 && r.res.body.grantedVia === 'uploader',
    'the uploader is granted their own book without a rental'
  );

  // --- stake status -------------------------------------------------------
  reset();
  r = await call(getStakeStatusForHash, { arweaveHash: HASH_A });
  assert(r.res.statusCode === 404, 'stake status for a book nobody has seen is a 404');

  db.uploads = [makeUploadRow({ status: 'pending_stake' })];
  r = await call(getStakeStatusForHash, { arweaveHash: HASH_A });
  assert(
    r.res.statusCode === 200 && r.res.body.status === 'pending_stake' && r.res.body.registered === false,
    'an indexed-but-unregistered book reports pending_stake'
  );

  chain.uploads.set(HASH_A, { uploader: ARCHIVIST, timestamp: 1_760_000_000, status: 0, metadata: '' });
  chain.stakes.set(HASH_A, {
    staker: ARCHIVIST,
    amount: (100n * 10n ** 18n).toString(),
    timestamp: 1_760_000_000,
    active: true,
  });
  chain.challenges.set(HASH_A, {
    challenger: LIBRARIAN,
    timestamp: 1_760_100_000,
    resolved: false,
    reason: 'Suspected duplicate',
  });
  r = await call(getStakeStatusForHash, { arweaveHash: HASH_A });
  assert(r.res.body.status === 'pending' && r.res.body.staked === true, 'on-chain status overrides the index');
  assert(r.res.body.challenge.challenger === LIBRARIAN, 'an open challenge is reported with its challenger');
  assert(
    r.res.body.index.inSync === false,
    'a stale index row is flagged rather than silently preferred'
  );

  // --- chain status -------------------------------------------------------
  await listener.writeCursor(42_799_000);
  r = await call(getChainStatus, {});
  assert(r.res.body.lastProcessedBlock === 42_799_000, 'chain status reports the listener cursor');
  assert(r.res.body.blocksBehind === 42_800_000 - listener.CONFIRMATIONS - 42_799_000, 'it reports how far behind it is');

  // --- address checksum ---------------------------------------------------
  assert(
    isValidWalletAddress('0x5F47ecD28155790f1271df965373fD9aCEA643b9'),
    'a correctly checksummed address is accepted'
  );
  assert(
    isValidWalletAddress('0x5f47ecd28155790f1271df965373fd9acea643b9'),
    'an all-lowercase address is accepted (no checksum to verify)'
  );
  assert(
    !isValidWalletAddress('0x5F47ecD28155790f1271df965373fD9aCEA643B9'),
    'a mistyped mixed-case address is rejected by its EIP-55 checksum'
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Registrar — the backend's only write path
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND = '0xccdC69a3020BbaEb5483B2CE20d3fA0c1204b096';

async function testRegistrar() {
  section('registration.service — the backend write path');
  reset();

  // Every precondition failure gets its own name, because each needs a
  // different person to fix it.
  let check = await preflight();
  assert(
    check.ready === false && check.reason === 'not_configured',
    'with no key configured the backend stays read-only and says so'
  );

  chain.signer = BACKEND;
  check = await preflight();
  assert(
    check.ready === false && check.reason === 'not_authorized',
    'an unauthorized registrar is reported as not_authorized, not a generic failure'
  );
  assert(
    check.message.includes('setAuthorizedCaller') && check.message.includes(BACKEND),
    'the not_authorized message names the exact call the owner has to make'
  );

  chain.authorizedCallers.add(BACKEND.toLowerCase());
  check = await preflight();
  assert(
    check.ready === false && check.reason === 'insufficient_gas',
    'an authorized but unfunded registrar is reported as insufficient_gas'
  );

  chain.signerBalance = ethers.parseEther('0.05');
  check = await preflight();
  assert(check.ready === true, 'authorized + funded is ready');

  // The owner satisfies onlyAuthorized without appearing in the mapping.
  chain.authorizedCallers.clear();
  chain.libraryOwner = BACKEND;
  check = await preflight();
  assert(check.ready === true, 'the contract owner passes onlyAuthorized without being in the mapping');

  // --- registerOnChain ----------------------------------------------------
  reset();
  chain.signer = BACKEND;
  chain.authorizedCallers.add(BACKEND.toLowerCase());
  chain.signerBalance = ethers.parseEther('0.05');

  let result = await registerOnChain(HASH_A, ARCHIVIST, {
    title: 'Meditations',
    author: 'Marcus Aurelius',
    category: 'philosophy',
  });
  assert(result.registered === true && Boolean(result.txHash), 'a ready registrar registers and returns a tx hash');
  assert(chain.sentTransactions.length === 1, 'exactly one transaction is sent');

  const sent = chain.sentTransactions[0];
  assert(
    sent.uploader.toLowerCase() === ARCHIVIST.toLowerCase(),
    'the ARCHIVIST is recorded as uploader — not the backend, or stake.stake() could never succeed'
  );
  assert(JSON.parse(sent.metadata).t === 'Meditations', 'metadata is written as a compact JSON blob');

  // Idempotency: a retry after a timed-out-but-landed tx must not revert.
  chain.uploads.set(HASH_A, { uploader: ARCHIVIST, timestamp: 1, status: 0, metadata: '' });
  chain.sentTransactions = [];
  result = await registerOnChain(HASH_A, ARCHIVIST, { title: 'x', author: 'y', category: 'philosophy' });
  assert(
    result.registered === true && result.reason === 'already_registered',
    'registering an existing hash reports already_registered instead of reverting'
  );
  assert(chain.sentTransactions.length === 0, 'no transaction is sent for an already-registered hash');

  // A simulated revert must stop before spending gas or burning a nonce.
  reset();
  chain.signer = BACKEND;
  chain.authorizedCallers.add(BACKEND.toLowerCase());
  chain.signerBalance = ethers.parseEther('0.05');
  chain.staticCallRevert = 'Uploader is blacklisted';
  result = await registerOnChain(HASH_A, ARCHIVIST, { title: 'x', author: 'y', category: 'philosophy' });
  assert(result.registered === false && result.reason === 'would_revert', 'a failing simulation is caught as would_revert');
  assert(result.message.includes('blacklisted'), 'the revert reason is surfaced verbatim');
  assert(chain.sentTransactions.length === 0, 'nothing is sent when the simulation reverts — no gas, no nonce burned');

  // A send failure must be returned, never thrown — an upload is already paid for.
  reset();
  chain.signer = BACKEND;
  chain.authorizedCallers.add(BACKEND.toLowerCase());
  chain.signerBalance = ethers.parseEther('0.05');
  chain.sendRevert = 'replacement fee too low';
  let threw = null;
  try {
    result = await registerOnChain(HASH_A, ARCHIVIST, { title: 'x', author: 'y', category: 'philosophy' });
  } catch (err) {
    threw = err;
  }
  assert(threw === null, 'a failed send never throws — it must not turn a paid-for upload into a 500');
  assert(result.registered === false && result.reason === 'transaction_failed', 'a failed send is reported as transaction_failed');

  // Metadata clipping keeps an unbounded title from becoming an unbounded gas bill.
  const clipped = JSON.parse(buildMetadata({ title: 'T'.repeat(500), author: 'A', category: 'philosophy' }));
  assert(clipped.t.length === 200, 'over-long metadata fields are clipped before hitting the chain');
}

async function main() {
  await testDecoding();
  await testResolution();
  await testPersist();
  await testSync();
  await testChainService();
  await testControllers();
  await testRegistrar();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
