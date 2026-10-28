require('dotenv').config();
const assert = require('node:assert/strict');
const path = require('node:path');
const { Wallet } = require('ethers');

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
}

const CHALLENGE_HASH = 'A'.repeat(43);
const CHALLENGER = Wallet.createRandom();
const ARCHIVIST = Wallet.createRandom();
const REVIEWERS = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
const book = { arweaveHash: CHALLENGE_HASH, status: 'challenged', uploader: ARCHIVIST.address, title: 'Review me', author: 'Author', category: 'science', description: 'A challenged book.', uploadTimestamp: new Date(), fileSize: 10, pageCount: 1 };
const votes = [];
const prisma = {
  upload: {
    findMany: async () => [book],
    findUnique: async () => book,
  },
  challengeReview: {
    findMany: async ({ select } = {}) => select && Object.keys(select).length === 1 && select.vote
      ? votes.map(({ vote }) => ({ vote }))
      : [...votes].sort((a, b) => a.reviewedAt - b.reviewedAt),
    findUnique: async ({ where }) => votes.find((review) => review.arweaveHash === where.arweaveHash_librarian.arweaveHash && review.librarian === where.arweaveHash_librarian.librarian) || null,
    count: async () => votes.length,
    create: async ({ data }) => {
      votes.push({ ...data, reviewedAt: new Date() });
    },
  },
  $queryRaw: async () => [],
  $transaction: async (callback) => callback(prisma),
};
stub('../config/db', prisma);
stub('../services/blockchain.service', {
  getStakeStatus: async () => ({
    staked: true,
    active: true,
    staker: ARCHIVIST.address,
    challenge: { challenger: CHALLENGER.address, reason: 'Potentially abusive content', challengedAt: new Date().toISOString(), resolved: false },
    challengePeriodEnds: new Date(Date.now() + 86400000).toISOString(),
  }),
  isActiveLibrarian: async (address) => ({ active: [...REVIEWERS, CHALLENGER].some((wallet) => wallet.address.toLowerCase() === address.toLowerCase()) }),
});
stub('../controller/upload.controller', {
  PUBLIC_UPLOAD_SELECT: {},
  toPublicUpload: (row) => ({ arweaveHash: row.arweaveHash, title: row.title, author: row.author, category: row.category, description: row.description, uploader: row.uploader, uploadTimestamp: row.uploadTimestamp, fileSize: row.fileSize, pageCount: row.pageCount }),
});
stub('../controller/rental.controller', { handleChainError: (err, res, next) => next(err) });
stub('../services/dedup.service', { NEAR_DUPLICATE_THRESHOLD: 3 });

const { getChallengeReviews, submitChallengeReview } = require('../controller/librarian.controller');
const {
  buildChallengeReviewMessage,
  verifyChallengeReview,
  summarizeReviews,
  isStoredChallengeReviewValid,
} = require('../services/challengeReview.service');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(fn, req) {
  const res = response();
  let error;
  await fn(req, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

async function signedRequest(wallet, vote, rationale) {
  const timestamp = Date.now();
  const message = buildChallengeReviewMessage({ arweaveHash: CHALLENGE_HASH, vote, rationale, timestamp });
  return {
    params: { arweaveHash: CHALLENGE_HASH },
    body: { librarian: wallet.address, vote, rationale, timestamp, signature: await wallet.signMessage(message) },
  };
}

async function run() {
  const stale = verifyChallengeReview({ arweaveHash: CHALLENGE_HASH, librarian: REVIEWERS[0].address, vote: 'uphold', rationale: 'Well supported reasoning', timestamp: Date.now() - 600000, signature: '0x' });
  assert.equal(stale.error, 'review_signature_expired', 'stale signed reviews are refused');
  assert.equal(summarizeReviews([{ vote: 'uphold' }, { vote: 'dismiss' }]).consensus, null, 'two votes do not reveal an early result');

  const first = await invoke(submitChallengeReview, await signedRequest(REVIEWERS[0], 'uphold', 'The cited pages support this challenge.'));
  assert.equal(first.statusCode, 201, 'first valid librarian review is recorded');
  assert.equal(first.body.review.submitted, 1, 'progress counts distinct reviews');
  assert.equal(first.body.review.votes, null, 'vote directions stay blind before all three reviews');

  const duplicate = await invoke(submitChallengeReview, await signedRequest(REVIEWERS[0], 'dismiss', 'A different rationale for this vote.'));
  assert.equal(duplicate.statusCode, 409, 'a librarian cannot change or duplicate an immutable vote');

  const inactive = Wallet.createRandom();
  const inactiveRequest = await signedRequest(inactive, 'dismiss', 'The challenge does not match the book.');
  const inactiveResult = await invoke(submitChallengeReview, inactiveRequest);
  assert.equal(inactiveResult.statusCode, 403, 'inactive wallets cannot vote');

  const challengerVote = await invoke(submitChallengeReview, await signedRequest(CHALLENGER, 'dismiss', 'I am the challenger.'));
  assert.equal(challengerVote.statusCode, 403, 'the challenger cannot review their own challenge');

  for (const [wallet, vote] of [[REVIEWERS[1], 'dismiss'], [REVIEWERS[2], 'uphold']]) {
    const result = await invoke(submitChallengeReview, await signedRequest(wallet, vote, 'I checked the cited material independently.'));
    assert.equal(result.statusCode, 201, 'each additional distinct reviewer can submit one vote');
  }

  const listing = await invoke(getChallengeReviews, { query: { librarian: REVIEWERS[0].address } });
  const challenge = listing.body.queue[0];
  assert.equal(challenge.review.submitted, 3, 'challenge queue records three completed reviews');
  assert.equal(challenge.review.consensus, 'uphold', 'two-of-three determines the consensus');
  assert.deepEqual(challenge.review.votes, { uphold: 2, dismiss: 1 }, 'final tally is revealed after all three votes');
  assert.equal(challenge.review.ballots.length, 3, 'the completed signed review rationales are available for audit');
  assert.equal(challenge.review.ownVote.vote, 'uphold', 'the connected reviewer sees their own immutable vote');

  const tampered = { ...votes[0], vote: 'dismiss' };
  assert.equal(isStoredChallengeReviewValid(tampered), false, 'a database-tampered vote fails signature verification');

  const fourth = await invoke(submitChallengeReview, await signedRequest(REVIEWERS[3], 'dismiss', 'This should not be accepted as vote four.'));
  assert.equal(fourth.statusCode, 409, 'an eligible fourth librarian cannot add a vote after consensus');

  console.log('Challenge review tests passed (signature expiry, blind voting, distinct active reviewers, immutable votes, 2-of-3 consensus).');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
