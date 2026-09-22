// Librarian review queue filtering.
//
// Run: node tests/librarianQueue.test.js
//
// Postgres and the chain are both stubbed via require.cache (same technique as
// tests/chainReads.test.js). What is under test is the filter itself: which
// rows survive the join, in what order, and what happens when a read fails.
//
// Every exclusion here maps to one require() in AlexandriaStake.challengeUpload.
// If a case stops being excluded, a librarian pays gas for a reverting tx.

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

function section(name) {
  console.log(`\n${name}`);
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Stubs — installed before the controller is required
// ─────────────────────────────────────────────────────────────────────────────

const db = { uploads: [], lastFindArgs: null };

stub('../config/db', {
  upload: {
    findMany: async (args) => {
      db.lastFindArgs = args;
      const rows = db.uploads.filter((u) => u.status === args.where.status);
      return rows.slice(0, args.take);
    },
  },
});

// arweaveHash → stake status, or an Error to reject with.
const chain = { stakes: new Map(), calls: [] };

stub('../services/blockchain.service', {
  getStakeStatus: async (arweaveHash) => {
    chain.calls.push(arweaveHash);
    const entry = chain.stakes.get(arweaveHash);
    if (entry instanceof Error) throw entry;
    return entry ?? { staked: false, active: false, challenge: null };
  },
});

const { getReviewQueue } = require('../controller/librarian.controller');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function hash(seed) {
  return seed.padEnd(43, 'A').slice(0, 43);
}

const ARCHIVIST = '0x1111111111111111111111111111111111111111';
const LIBRARIAN = '0x3333333333333333333333333333333333333333';

const DAY = 24 * 60 * 60 * 1000;

function makeRow(seed, overrides = {}) {
  return {
    arweaveHash: hash(seed),
    title: seed,
    author: 'Anon',
    category: 'science',
    description: 'A book.',
    uploader: ARCHIVIST,
    uploadTimestamp: new Date('2026-09-01T00:00:00.000Z'),
    status: 'pending',
    fileSize: 1024,
    pageCount: 10,
    isNearDuplicate: false,
    nearDuplicateOf: null,
    onChainTxHash: '0xtx',
    ...overrides,
  };
}

/** An active, unchallenged stake with `daysLeft` remaining in the window. */
function makeStake(daysLeft, overrides = {}) {
  return {
    staked: true,
    active: true,
    staker: ARCHIVIST,
    stakeAmount: '100000000000000000000',
    stakeAmountAlex: '100.0',
    stakeTime: new Date(Date.now() - (14 - daysLeft) * DAY).toISOString(),
    challengePeriodEnds: new Date(Date.now() + daysLeft * DAY).toISOString(),
    challengePeriodOver: daysLeft <= 0,
    challenge: null,
    ...overrides,
  };
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

async function call(query = {}) {
  const res = makeRes();
  let nextErr;
  await getReviewQueue({ query }, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
}

function reset() {
  db.uploads = [];
  db.lastFindArgs = null;
  chain.stakes.clear();
  chain.calls = [];
}

function hashes(body) {
  return body.queue.map((b) => b.arweaveHash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  section('Candidate selection');
  {
    reset();
    db.uploads = [
      makeRow('staked'),
      makeRow('unstaked', { status: 'pending_stake' }),
      makeRow('approved', { status: 'approved' }),
    ];
    chain.stakes.set(hash('staked'), makeStake(10));

    const { res } = await call();
    assert(db.lastFindArgs.where.status === 'pending', '1. only status=pending rows are candidates');
    assert(res.body.candidates === 1, '2. candidates counts pending rows before the chain filter');
    assert(hashes(res.body).includes(hash('staked')), '3. a staked in-window book is queued');
    assert(chain.calls.length === 1, '4. one stake read per candidate, none for other statuses');
  }

  section('Chain-side exclusions (one per challengeUpload require)');
  {
    reset();
    db.uploads = [
      makeRow('ok'),
      makeRow('nostake'),
      makeRow('inactive'),
      makeRow('expired'),
      makeRow('challenged'),
      makeRow('mine'),
    ];
    chain.stakes.set(hash('ok'), makeStake(5));
    chain.stakes.set(hash('nostake'), { staked: false, active: false, challenge: null });
    chain.stakes.set(hash('inactive'), makeStake(5, { active: false }));
    chain.stakes.set(hash('expired'), makeStake(-1));
    chain.stakes.set(
      hash('challenged'),
      makeStake(5, { challenge: { challenger: LIBRARIAN, reason: 'spam', resolved: false } })
    );
    chain.stakes.set(hash('mine'), makeStake(5, { staker: LIBRARIAN }));

    const { res } = await call({ librarian: LIBRARIAN });
    const queued = hashes(res.body);

    assert(queued.length === 1 && queued[0] === hash('ok'), '5. only the challengeable book survives');
    assert(!queued.includes(hash('nostake')), '6. never staked is excluded (stakes[h].active)');
    assert(!queued.includes(hash('inactive')), '7. unstaked/inactive stake is excluded');
    assert(!queued.includes(hash('expired')), '8. expired challenge window is excluded');
    assert(!queued.includes(hash('challenged')), '9. already challenged is excluded');
    assert(!queued.includes(hash('mine')), '10. own upload is excluded when librarian is supplied');
    assert(res.body.candidates === 6 && res.body.total === 1, '11. candidates and total reported separately');
  }

  section('Own-upload rule without a librarian address');
  {
    reset();
    db.uploads = [makeRow('mine')];
    chain.stakes.set(hash('mine'), makeStake(5, { staker: LIBRARIAN }));

    const { res } = await call();
    assert(res.body.total === 1, '12. no librarian supplied leaves the own-upload filter off');
    assert(res.body.librarian === null, '13. librarian echoes back as null when absent');
  }
  {
    reset();
    db.uploads = [makeRow('mine')];
    // Same address, checksummed casing — the comparison must not care.
    chain.stakes.set(hash('mine'), makeStake(5, { staker: '0x3333333333333333333333333333333333333333' }));

    const { res } = await call({ librarian: LIBRARIAN.toUpperCase().replace('0X', '0x') });
    assert(res.body.total === 0, '14. staker comparison is case-insensitive');
  }

  section('Unreachable reads');
  {
    reset();
    db.uploads = [makeRow('ok'), makeRow('broken')];
    chain.stakes.set(hash('ok'), makeStake(3));
    chain.stakes.set(hash('broken'), new Error('rpc timeout'));

    const { res } = await call();
    assert(res.body.total === 1, '15. one failed read does not empty the queue');
    assert(res.body.unavailable === 1, '16. the failed read is counted as unavailable');
    assert(!hashes(res.body).includes(hash('broken')), '17. an unverified book is not shown');
  }

  section('Ordering');
  {
    reset();
    db.uploads = [makeRow('later'), makeRow('soonest'), makeRow('middle')];
    chain.stakes.set(hash('later'), makeStake(9));
    chain.stakes.set(hash('soonest'), makeStake(1));
    chain.stakes.set(hash('middle'), makeStake(4));

    const { res } = await call();
    assert(
      JSON.stringify(hashes(res.body)) === JSON.stringify([hash('soonest'), hash('middle'), hash('later')]),
      '18. queue is ordered by closing challenge window, soonest first'
    );
  }

  section('Response shape');
  {
    reset();
    db.uploads = [makeRow('book', { isNearDuplicate: true, nearDuplicateOf: hash('other') })];
    chain.stakes.set(hash('book'), makeStake(6));

    const { res } = await call();
    const book = res.body.queue[0];
    assert(book.title === 'book' && book.uploader === ARCHIVIST, '19. metadata comes from the index row');
    assert(
      book.isNearDuplicate === true && book.nearDuplicateOf === hash('other'),
      '20. dedup flags are carried through'
    );
    assert(
      book.stakeAmountAlex === '100.0' && typeof book.challengePeriodEnds === 'string',
      '21. stake fields are merged in'
    );
    assert(
      book.litEncryptedKeyId === undefined && book.sha256Hash === undefined,
      '22. no key material or dedup internals leak'
    );
  }

  section('Input validation');
  {
    reset();
    const bad = await call({ librarian: 'not-an-address' });
    assert(
      bad.res.statusCode === 400 && bad.res.body.error === 'invalid_wallet_address',
      '23. malformed librarian address is a 400'
    );

    const badLimit = await call({ limit: '0' });
    assert(badLimit.res.statusCode === 400 && badLimit.res.body.error === 'invalid_limit', '24. limit=0 is a 400');

    const overLimit = await call({ limit: '101' });
    assert(
      overLimit.res.statusCode === 400 && overLimit.res.body.error === 'invalid_limit',
      '25. limit above MAX_LIMIT is a 400'
    );

    reset();
    db.uploads = [makeRow('a'), makeRow('b'), makeRow('c')];
    chain.stakes.set(hash('a'), makeStake(2));
    chain.stakes.set(hash('b'), makeStake(3));
    chain.stakes.set(hash('c'), makeStake(4));
    const limited = await call({ limit: '2' });
    assert(limited.res.body.candidates === 2, '26. limit caps the candidate page');
  }

  section('Empty index');
  {
    reset();
    db.uploads = [];
    const { res } = await call();
    assert(res.body.total === 0 && res.body.candidates === 0, '27. an empty index is an empty queue, not an error');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
