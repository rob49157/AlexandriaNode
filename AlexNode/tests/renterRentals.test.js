// GET /api/rental/renter/:address — a wallet's rentals, active and past, for the
// Reader dashboard. Read from the BookRented events the listener stores.
//
// Run: npm run test:rentals
//
// The real rental controller and auth module run; Postgres, the chain reads and
// the upload controller are stubbed. The stubs model what Postgres stores (Event
// rows as services/eventListener.service.js writes them), never what the
// controller ought to decide.

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

const READER = Wallet.createRandom();
const OTHER = Wallet.createRandom();
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const hash = (label) => label.padEnd(43, '0');

// Event rows as the listener stores them: renter checksummed, as ethers decodes
// it; uint256 values as decimal strings; the hash null when it never resolved.
const events = [];
let block = 1000;
const rented = (label, renter, { expiresIn, days = 7, resolved = true }) => {
  block += 10;
  events.push({
    eventName: 'BookRented',
    contract: 'rent',
    arweaveHash: resolved ? hash(label) : null,
    args: {
      arweaveHash: { indexed: true, hash: '0x' + 'ab'.repeat(32) },
      renter: renter.address,
      expiry: String(now + expiresIn),
      duration: String(days * DAY),
    },
    blockNumber: block,
    logIndex: 0,
    transactionHash: `0x${label}${block}`,
    timestamp: new Date((now + expiresIn - days * DAY) * 1000),
  });
};

rented('origin', READER, { expiresIn: -20 * DAY, days: 30 }); // oldest, long expired
rented('gibbon', READER, { expiresIn: -10 * DAY }); // first rental of gibbon
rented('gibbon', READER, { expiresIn: 5 * DAY }); // rented again: active now
rented('lost', READER, { expiresIn: 2 * DAY, resolved: false }); // listener never resolved it
rented('time', READER, { expiresIn: 1 * DAY, days: 1 }); // newest, active
rented('gibbon', OTHER, { expiresIn: 6 * DAY }); // someone else's

const books = {
  [hash('origin')]: { arweaveHash: hash('origin'), title: 'On the Origin of Species' },
  [hash('gibbon')]: { arweaveHash: hash('gibbon'), title: 'Decline and Fall' },
  [hash('time')]: { arweaveHash: hash('time'), title: 'A Brief History of Time' },
};

let eventQuery = null;
let uploadQuery = null;
stub('../config/db', {
  event: {
    findMany: async (args) => {
      eventQuery = args;
      const w = args.where;
      return events
        .filter((e) => e.contract === w.contract && e.eventName === w.eventName && e.args[w.args.path[0]] === w.args.equals)
        .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
        .slice(0, args.take);
    },
  },
  upload: {
    findMany: async (args) => {
      uploadQuery = args;
      return args.where.arweaveHash.in.map((h) => books[h]).filter(Boolean);
    },
  },
});
stub('../services/blockchain.service', {
  isRentalActive: async () => { throw new Error('not expected: the listing reads no chain'); },
  getBookRental: async () => { throw new Error('not expected'); },
  getUploadOnChain: async () => { throw new Error('not expected'); },
  getStakeStatus: async () => { throw new Error('not expected'); },
  isActiveLibrarian: async () => { throw new Error('not expected'); },
  ChainError: class ChainError extends Error {},
});
stub('../controller/arweave', { isValidArweaveHash: (h) => /^[A-Za-z0-9_-]{43}$/.test(h) });
stub('../controller/upload.controller', {
  PUBLIC_UPLOAD_SELECT: { arweaveHash: true, title: true },
  toPublicUpload: (r) => ({ arweaveHash: r.arweaveHash, title: r.title }),
});

const { getRenterRentals } = require('../controller/rental.controller');

async function call(address) {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let error = null;
  await getRenterRentals({ params: { address } }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

async function run() {
  console.log('\nWho is asking');
  const bad = await call('not-a-wallet');
  assert(bad.statusCode === 400 && bad.body.error === 'invalid_address', '1. a malformed wallet address is refused');

  const res = await call(READER.address.toLowerCase()); // lower-case, as some wallets send it
  const { rentals } = res.body;
  assert(eventQuery.where.args.equals === READER.address, '2. the events are matched on the checksummed renter, as the listener stores it');
  assert(eventQuery.where.eventName === 'BookRented' && eventQuery.where.contract === 'rent', '3. only BookRented events from Rent are read');
  const othersTx = events.find((e) => e.args.renter === OTHER.address).transactionHash;
  assert(rentals.length === 4 && !rentals.some((r) => r.transactionHash === othersTx), "4. only this wallet's rentals are listed");

  console.log('\nRented now, rented before');
  const active = rentals.filter((r) => r.active).map((r) => r.arweaveHash);
  const past = rentals.filter((r) => !r.active).map((r) => r.arweaveHash);
  assert(active.length === 2 && active.includes(hash('time')) && active.includes(hash('gibbon')), '5. a rental whose expiry is in the future is active');
  assert(past.length === 2 && past.includes(hash('origin')) && past.includes(hash('gibbon')), '6. an expired rental is history');
  assert(res.body.activeCount === 2 && res.body.total === 4, '7. the counts match the list');
  assert(rentals.filter((r) => r.arweaveHash === hash('gibbon')).length === 2, '8. a book rented twice appears once per rental');

  console.log('\nWhat each rental carries');
  assert(rentals[0].arweaveHash === hash('time') && rentals[rentals.length - 1].arweaveHash === hash('origin'), '9. newest first');
  const time = rentals[0];
  assert(time.book && time.book.title === 'A Brief History of Time', '10. each rental carries its book');
  assert(time.durationDays === 1 && rentals[3].durationDays === 30, '11. duration is given in days');
  assert(time.expiry === new Date((now + DAY) * 1000).toISOString(), '12. expiry is the one Rent.sol stored, as an ISO date');
  assert(uploadQuery.where.arweaveHash.in.length === 3, '13. each book is looked up once, in one query');

  console.log('\nWhat cannot be listed');
  assert(!rentals.some((r) => r.arweaveHash === null) && res.body.unresolved === 1, '14. an event the listener never resolved is counted, not listed');

  const nobody = await call(Wallet.createRandom().address);
  assert(nobody.statusCode === 200 && nobody.body.total === 0 && nobody.body.rentals.length === 0, '15. a wallet that never rented gets an empty list');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exitCode = 1;
});
