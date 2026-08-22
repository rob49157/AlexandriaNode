// Phase 6a test: Postgres read paths — GET /api/upload/:arweaveHash and GET /api/search.
//
// Run: node tests/readPaths.test.js
//
// Postgres is replaced with a small in-memory query engine that implements the
// subset of Prisma this code uses (findUnique/count/findMany with where, select,
// orderBy, skip, take, and array-form $transaction). Irys and Lit are stubbed
// only to keep their SDKs off the require path — neither read endpoint calls them.
//
// Tests:
//   1-6.   getUpload: shape, 404, malformed-hash rejection, pending_stake visibility
//   7-11.  getUpload: key material and dedup internals never leave the database
//  12-19.  search: q matching, category/status filters, ordering, defaults
//  20-26.  search: pagination arithmetic and parameter validation
//  27-30.  search: projection, transaction use, unknown params

require('dotenv').config();

const path = require('path');

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

// ─────────────────────────────────────────────────────────────────────────────
// Stub installation — must happen before the controllers are required
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

// Neither read path touches storage or Lit; these exist so requiring the upload
// controller doesn't drag the Irys SDK into the process.
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

// ─────────────────────────────────────────────────────────────────────────────
// Fake Postgres
// ─────────────────────────────────────────────────────────────────────────────

const db = { rows: [], calls: [] };

// Prisma filter subset: scalar equality, { contains, mode }, and OR arrays.
function matchesCondition(value, condition) {
  if (condition !== null && typeof condition === 'object' && 'contains' in condition) {
    const haystack = String(value ?? '');
    const needle = String(condition.contains);
    return condition.mode === 'insensitive'
      ? haystack.toLowerCase().includes(needle.toLowerCase())
      : haystack.includes(needle);
  }
  return value === condition;
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((clause) => matchesWhere(row, clause));
    return matchesCondition(row[key], condition);
  });
}

// Mirrors Prisma's `select`: only the keys explicitly set to true come back.
// This is what makes the "key material never leaves the DB" assertions real
// rather than a restatement of the serializer.
function applySelect(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out;
}

function findMany(args = {}) {
  db.calls.push({ op: 'findMany', args });
  let rows = db.rows.filter((r) => matchesWhere(r, args.where));

  if (args.orderBy && args.orderBy.uploadTimestamp) {
    const dir = args.orderBy.uploadTimestamp === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b) => dir * (a.uploadTimestamp - b.uploadTimestamp));
  }

  const skip = args.skip || 0;
  rows = rows.slice(skip, args.take === undefined ? undefined : skip + args.take);
  return rows.map((r) => applySelect(r, args.select));
}

stub('../config/db', {
  upload: {
    findUnique: async (args) => {
      db.calls.push({ op: 'findUnique', args });
      const row = db.rows.find((r) => r.arweaveHash === args.where.arweaveHash);
      return row ? applySelect(row, args.select) : null;
    },
    count: async (args = {}) => {
      db.calls.push({ op: 'count', args });
      return db.rows.filter((r) => matchesWhere(r, args.where)).length;
    },
    findMany: async (args) => findMany(args),
  },
  // Array form: Prisma resolves the operations it is handed. The fake ones have
  // already started, so awaiting them all is equivalent here.
  $transaction: async (operations) => {
    db.calls.push({ op: '$transaction', args: { size: operations.length } });
    return Promise.all(operations);
  },
  $connect: async () => {},
  $disconnect: async () => {},
});

// ─────────────────────────────────────────────────────────────────────────────
// Controllers under test (required after the stubs are in place)
// ─────────────────────────────────────────────────────────────────────────────

const { getUpload, PUBLIC_UPLOAD_SELECT } = require('../controller/upload.controller');
const { search, MAX_LIMIT, MAX_QUERY_LENGTH } = require('../controller/search.controller');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// 43-char base64url, the real transaction ID shape.
function hash(seed) {
  return seed.padEnd(43, 'A').slice(0, 43);
}

const HASH_APPROVED = hash('meditations');
const HASH_PENDING_STAKE = hash('pendingstake');
const HASH_MISSING = hash('nosuchbook');

function makeRow(overrides) {
  return {
    arweaveHash: hash('generic'),
    title: 'Untitled',
    author: 'Anonymous',
    category: 'philosophy',
    description: 'A book held by Alexandria.',
    uploader: '0x1111111111111111111111111111111111111111',
    uploadTimestamp: new Date('2026-01-01T00:00:00Z'),
    status: 'approved',
    fileSize: 1024,
    pageCount: 10,
    // Everything below this line must never appear in a response.
    sha256Hash: 'a'.repeat(64),
    simHash: 'ffffffffffffffff',
    simHashBand0: 1,
    simHashBand1: 2,
    simHashBand2: 3,
    simHashBand3: 4,
    litEncryptedKeyId: 'SEALED_KEY_CIPHERTEXT',
    litDataToEncryptHash: 'LIT_INTEGRITY_HASH',
    encryptionIv: 'aXYtYmFzZTY0',
    encryptionAuthTag: 'dGFnLWJhc2U2NA',
    isNearDuplicate: false,
    nearDuplicateOf: null,
    onChainTxHash: null,
    ...overrides,
  };
}

function seed() {
  db.rows = [
    makeRow({
      arweaveHash: HASH_APPROVED,
      title: 'Meditations',
      author: 'Marcus Aurelius',
      category: 'philosophy',
      status: 'approved',
      uploadTimestamp: new Date('2026-03-01T00:00:00Z'),
      pageCount: 254,
    }),
    makeRow({
      arweaveHash: hash('origin'),
      title: 'On the Origin of Species',
      author: 'Charles Darwin',
      category: 'science',
      status: 'approved',
      uploadTimestamp: new Date('2026-04-01T00:00:00Z'),
    }),
    makeRow({
      arweaveHash: hash('principia'),
      title: 'Principia Mathematica',
      author: 'Isaac Newton',
      category: 'mathematics',
      status: 'approved',
      uploadTimestamp: new Date('2026-05-01T00:00:00Z'),
    }),
    makeRow({
      arweaveHash: hash('leviathan'),
      title: 'Leviathan',
      author: 'Thomas Hobbes',
      category: 'philosophy',
      status: 'approved',
      uploadTimestamp: new Date('2026-02-01T00:00:00Z'),
    }),
    makeRow({
      arweaveHash: HASH_PENDING_STAKE,
      title: 'An Unfinished Upload',
      author: 'Marcus Aurelius',
      category: 'philosophy',
      status: 'pending_stake',
      uploadTimestamp: new Date('2026-06-01T00:00:00Z'),
    }),
    makeRow({
      arweaveHash: hash('challenged'),
      title: 'A Disputed Book',
      author: 'Unknown Hand',
      category: 'history',
      status: 'challenged',
      uploadTimestamp: new Date('2026-06-02T00:00:00Z'),
    }),
  ];
  db.calls = [];
}

// Minimal Express res double.
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

async function callGetUpload(arweaveHash) {
  const res = makeRes();
  let nextErr = null;
  await getUpload({ params: { arweaveHash } }, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
}

async function callSearch(query) {
  const res = makeRes();
  let nextErr = null;
  await search({ query }, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
}

// Fields that must never reach a client from an unauthenticated read path.
const FORBIDDEN_FIELDS = [
  'sha256Hash',
  'simHash',
  'simHashBand0',
  'simHashBand1',
  'simHashBand2',
  'simHashBand3',
  'litEncryptedKeyId',
  'litDataToEncryptHash',
  'encryptionIv',
  'encryptionAuthTag',
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Phase 6a: Postgres read paths ===\n');

  // --- GET /api/upload/:arweaveHash ---------------------------------------
  console.log('GET /api/upload/:arweaveHash');
  seed();

  {
    const { res, nextErr } = await callGetUpload(HASH_APPROVED);
    assert(nextErr === null && res.statusCode === 200, 'known hash returns 200');
    assert(res.body.arweaveHash === HASH_APPROVED, 'returns the requested row');
    assert(
      res.body.title === 'Meditations' &&
        res.body.author === 'Marcus Aurelius' &&
        res.body.category === 'philosophy' &&
        res.body.status === 'approved' &&
        res.body.pageCount === 254,
      'carries title, author, category, status, pageCount'
    );

    const leaked = FORBIDDEN_FIELDS.filter((f) => f in res.body);
    assert(leaked.length === 0, `no key material or dedup internals in the body (leaked: ${leaked.join(', ') || 'none'})`);
  }

  {
    const { res } = await callGetUpload(HASH_MISSING);
    assert(res.statusCode === 404 && res.body.error === 'not_found', 'unknown hash returns 404 not_found');
  }

  {
    // A pending_stake row must stay reachable by direct hash: an archivist who
    // closed the browser mid-flow has nothing but the hash to resume with.
    const { res } = await callGetUpload(HASH_PENDING_STAKE);
    assert(
      res.statusCode === 200 && res.body.status === 'pending_stake',
      'pending_stake row is retrievable by hash'
    );
  }

  {
    db.calls = [];
    const { res } = await callGetUpload('not-a-hash');
    assert(res.statusCode === 400 && res.body.error === 'invalid_hash', 'malformed hash returns 400 invalid_hash');
    assert(db.calls.length === 0, 'malformed hash never reaches the database');
  }

  {
    // 44 chars is the base58 form of tx.id — the encoding trap in arweave.js.
    // Accepting it would mean querying with an identifier no gateway resolves.
    const { res } = await callGetUpload('B'.repeat(44));
    assert(res.statusCode === 400, '44-char base58-style id is rejected');
  }

  {
    const { res } = await callGetUpload('C'.repeat(42));
    assert(res.statusCode === 400, '42-char hash is rejected');
  }

  {
    const { res } = await callGetUpload('!'.repeat(43));
    assert(res.statusCode === 400, 'correct length but non-base64url characters rejected');
  }

  {
    const leaked = FORBIDDEN_FIELDS.filter((f) => f in PUBLIC_UPLOAD_SELECT);
    assert(leaked.length === 0, 'PUBLIC_UPLOAD_SELECT does not request forbidden columns');
  }

  {
    db.calls = [];
    await callGetUpload(HASH_APPROVED);
    const call = db.calls.find((c) => c.op === 'findUnique');
    assert(call && call.args.select === PUBLIC_UPLOAD_SELECT, 'findUnique passes the explicit select');
  }

  // --- GET /api/search -----------------------------------------------------
  console.log('\nGET /api/search');
  seed();

  {
    const { res, nextErr } = await callSearch({});
    assert(nextErr === null && res.statusCode === 200, 'bare search returns 200');
    assert(
      res.body.results.every((r) => r.status === 'approved'),
      'defaults to approved-only'
    );
    assert(res.body.total === 4, 'approved total is 4 (pending_stake and challenged excluded)');
  }

  {
    const { res } = await callSearch({ q: 'meditations' });
    assert(
      res.body.total === 1 && res.body.results[0].title === 'Meditations',
      'q matches title case-insensitively'
    );
  }

  {
    const { res } = await callSearch({ q: 'darwin' });
    assert(
      res.body.total === 1 && res.body.results[0].author === 'Charles Darwin',
      'q matches author case-insensitively'
    );
  }

  {
    const { res } = await callSearch({ q: 'ipsum lorem' });
    assert(res.body.total === 0 && res.body.results.length === 0, 'no match returns an empty page');
  }

  {
    const { res } = await callSearch({ category: 'philosophy' });
    assert(
      res.body.total === 2 && res.body.results.every((r) => r.category === 'philosophy'),
      'category filter narrows to that category'
    );
  }

  {
    const { res } = await callSearch({ q: 'aurelius', category: 'philosophy' });
    assert(res.body.total === 1, 'q and category combine (AND)');
  }

  {
    // Marcus Aurelius wrote one approved book and one still pending_stake;
    // the default filter must not surface the unfinished one.
    const { res } = await callSearch({ q: 'Marcus Aurelius' });
    assert(res.body.total === 1, 'default status filter hides pending_stake from a matching query');

    const { res: res2 } = await callSearch({ q: 'Marcus Aurelius', status: 'pending_stake' });
    assert(
      res2.body.total === 1 && res2.body.results[0].status === 'pending_stake',
      'status=pending_stake surfaces it explicitly'
    );
  }

  {
    const { res } = await callSearch({});
    const times = res.body.results.map((r) => new Date(r.uploadTimestamp).getTime());
    const sorted = times.slice().sort((a, b) => b - a);
    assert(JSON.stringify(times) === JSON.stringify(sorted), 'results are newest-first');
  }

  {
    const { res } = await callSearch({});
    const leaked = res.body.results.flatMap((r) => FORBIDDEN_FIELDS.filter((f) => f in r));
    assert(leaked.length === 0, 'search results carry no key material');
  }

  // --- Pagination ----------------------------------------------------------
  console.log('\nPagination');

  {
    const { res } = await callSearch({ limit: '2' });
    assert(res.body.results.length === 2, 'limit caps the page size');
    assert(
      res.body.total === 4 && res.body.totalPages === 2 && res.body.hasMore === true,
      'total/totalPages/hasMore computed over the full match set'
    );
  }

  {
    const page1 = await callSearch({ limit: '2', page: '1' });
    const page2 = await callSearch({ limit: '2', page: '2' });
    const ids1 = page1.res.body.results.map((r) => r.arweaveHash);
    const ids2 = page2.res.body.results.map((r) => r.arweaveHash);
    assert(ids2.length === 2 && ids1.every((id) => !ids2.includes(id)), 'page 2 returns the next, non-overlapping slice');
    assert(page2.res.body.hasMore === false, 'hasMore is false on the last page');
  }

  {
    const { res } = await callSearch({ page: '99' });
    assert(res.statusCode === 200 && res.body.results.length === 0, 'page past the end is an empty page, not an error');
  }

  {
    for (const page of ['0', '-1', 'abc', '1.5', '2abc']) {
      const { res } = await callSearch({ page });
      assert(res.statusCode === 400 && res.body.error === 'invalid_page', `page=${page} rejected`);
    }
  }

  {
    const { res } = await callSearch({ limit: String(MAX_LIMIT + 1) });
    assert(res.statusCode === 400 && res.body.error === 'invalid_limit', 'limit above the maximum rejected');
  }

  {
    const { res } = await callSearch({ limit: '0' });
    assert(res.statusCode === 400, 'limit=0 rejected');
  }

  // --- Filter validation ---------------------------------------------------
  console.log('\nFilter validation');

  {
    const { res } = await callSearch({ category: 'not-a-category' });
    assert(res.statusCode === 400 && res.body.error === 'invalid_category', 'unknown category rejected');
  }

  {
    const { res } = await callSearch({ status: 'approved_maybe' });
    assert(res.statusCode === 400 && res.body.error === 'invalid_status', 'unknown status rejected');
  }

  {
    const { res } = await callSearch({ q: 'x'.repeat(MAX_QUERY_LENGTH + 1) });
    assert(res.statusCode === 400 && res.body.error === 'query_too_long', 'overlong q rejected');
  }

  {
    const { res } = await callSearch({ q: '   ' });
    assert(res.statusCode === 200 && res.body.total === 4, 'whitespace-only q is treated as no query');
    assert(res.body.query.q === null, 'echoed query reports q as null');
  }

  {
    db.calls = [];
    await callSearch({});
    const tx = db.calls.find((c) => c.op === '$transaction');
    assert(tx && tx.args.size === 2, 'count and page run inside one $transaction');

    const many = db.calls.find((c) => c.op === 'findMany');
    assert(many && many.args.select === PUBLIC_UPLOAD_SELECT, 'findMany passes the explicit select');

    const countCall = db.calls.find((c) => c.op === 'count');
    assert(
      JSON.stringify(countCall.args.where) === JSON.stringify(many.args.where),
      'count and findMany use an identical where clause'
    );
  }

  // --- Summary -------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
