// GET /api/stake/archivist/:address — an archivist's uploads, and whether each
// can be published now (AlexandriaStake.unstake() after an unchallenged window).
//
// Run: npm run test:archivist
//
// The real stake, librarian and auth modules run; Postgres, the chain reads and
// the heavier controllers are stubbed. The stubs model what Postgres and the
// chain return, never what the controller ought to decide.

const path = require('node:path');
const { Wallet } = require('ethers');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, path: path.dirname(resolved), loaded: true, children: [], paths: [], exports };
}

const ARCHIVIST = Wallet.createRandom();
const OTHER = Wallet.createRandom();
const DAY = 86_400_000;
const hash = (label) => label.padEnd(43, '0');

// Rows as Postgres stores them: the uploader lower-case.
const rows = [];
const row = (label, status, uploader = ARCHIVIST.address) => {
  const r = { arweaveHash: hash(label), title: label, author: 'A', category: 'science', status, uploader: uploader.toLowerCase(), uploadTimestamp: new Date() };
  rows.push(r);
  return r.arweaveHash;
};

const H = {
  publishable: row('publishable', 'pending'),
  inWindow: row('inWindow', 'pending'),
  challenged: row('challenged', 'challenged'),
  approved: row('approved', 'approved'),
  othersStake: row('othersStake', 'pending'),
  unstaked: row('unstaked', 'pending'),
  notRegistered: row('notRegistered', 'pending_stake'),
  storing: row('storing', 'pending_confirmation'),
  failedStorage: row('failedStorage', 'storage_failed'),
  unreadable: row('unreadable', 'pending'),
};
row('someoneElses', 'pending', OTHER.address);

// What getStakeStatus reports per hash, as services/blockchain.service.js shapes it.
const staked = (over) => ({
  staked: true,
  active: true,
  staker: ARCHIVIST.address, // checksummed, as the chain returns it
  stakeAmountAlex: '100.0',
  stakeTime: new Date(Date.now() - (over ? 20 : 2) * DAY).toISOString(),
  challengePeriodEnds: new Date(Date.now() + (over ? -6 : 12) * DAY).toISOString(),
  challengePeriodOver: over,
  challenge: null,
});
const chain = {
  [H.publishable]: staked(true),
  [H.inWindow]: staked(false),
  [H.challenged]: { ...staked(true), challenge: { challenger: OTHER.address, reason: 'r', resolved: false, reviewOver: false } },
  [H.approved]: { ...staked(true), active: false },
  [H.othersStake]: { ...staked(true), staker: OTHER.address },
  [H.unstaked]: { staked: false, active: false, challenge: null },
};
const chainReads = [];

let queried = null;
stub('../config/db', {
  upload: {
    findMany: async (args) => {
      queried = args;
      return rows.filter((r) => r.uploader === args.where.uploader);
    },
  },
});
stub('../services/blockchain.service', {
  getStakeStatus: async (h) => {
    chainReads.push(h);
    if (h === H.unreadable) throw new Error('RPC unreachable');
    return chain[h];
  },
  isActiveLibrarian: async () => ({ active: false }),
});
stub('../controller/arweave', { isValidArweaveHash: (h) => /^[A-Za-z0-9_-]{43}$/.test(h) });
stub('../controller/upload.controller', {
  PUBLIC_UPLOAD_SELECT: {},
  toPublicUpload: (r) => ({ arweaveHash: r.arweaveHash, title: r.title, status: r.status, uploader: r.uploader }),
});
stub('../controller/rental.controller', {
  handleChainError: (err, res, next) => next(err),
  NOT_REGISTERED_STATUSES: new Set(['pending_confirmation', 'pending_stake', 'storage_failed']),
});
stub('../services/dedup.service', { NEAR_DUPLICATE_THRESHOLD: 3 });

const { getArchivistUploads } = require('../controller/stake.controller');

async function call(address) {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let error = null;
  await getArchivistUploads({ params: { address } }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

async function run() {
  console.log('\nAn archivist\'s uploads');
  const bad = await call('not-a-wallet');
  assert(bad.statusCode === 400 && bad.body.error === 'invalid_wallet_address', '1. a malformed wallet address is refused');

  const res = await call(ARCHIVIST.address); // checksummed, as a wallet sends it
  const byHash = new Map(res.body.uploads.map((u) => [u.arweaveHash, u]));
  assert(queried.where.uploader === ARCHIVIST.address.toLowerCase(), '2. Postgres is asked for the wallet lower-case, as uploads store it');
  assert(res.body.total === 10 && !byHash.has(hash('someoneElses')), "3. only this wallet's uploads are listed");

  console.log('\nWho can publish (unstake) now');
  assert(byHash.get(H.publishable).canPublish === true, '4. a staked book whose 14-day window closed with no challenge can be published');
  assert(byHash.get(H.inWindow).canPublish === false, '5. not while the window is still open');
  assert(byHash.get(H.challenged).canPublish === false, '6. not once it has been challenged, whatever the window says');
  assert(byHash.get(H.approved).canPublish === false, '7. not when the stake is already returned (approved)');
  assert(byHash.get(H.othersStake).canPublish === false, "8. not on a stake someone else holds");
  assert(byHash.get(H.unstaked).canPublish === false, '9. not on a book that was never staked');

  console.log('\nWhat the dashboard is told');
  const pub = byHash.get(H.publishable).stake;
  assert(
    pub && pub.active === true && pub.challengePeriodOver === true && pub.challengePeriodEnds && pub.stakeAmountAlex === '100.0',
    '10. each staked upload carries its stake, window end and amount'
  );
  assert(byHash.get(H.challenged).stake.challenge.reviewOver === false, "11. a challenged upload carries the challenge and its review deadline");

  console.log('\nFail closed, and spend no reads on books not on-chain');
  assert(
    [H.notRegistered, H.storing, H.failedStorage].every((h) => !chainReads.includes(h) && byHash.get(h).stake === null && byHash.get(h).canPublish === false),
    '12. pending_stake, pending_confirmation and storage_failed rows are not read on-chain, and cannot be published'
  );
  const unreadable = byHash.get(H.unreadable);
  assert(unreadable.stake === null && unreadable.canPublish === false, '13. a book whose chain read failed is listed, but never publishable');
  assert(res.body.unavailable === 1 && byHash.get(H.publishable).canPublish === true, '14. one failed read is counted and costs only that book');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exitCode = 1;
});
