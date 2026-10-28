// Librarian review queue — the books a librarian can actually challenge.
//
// This is the same Postgres-plus-chain join as stake.controller.js, fanned out
// across a page of rows instead of one hash. The fan-out is the whole point:
// the index alone cannot answer this question.
//
// AlexandriaStake.challengeUpload() enforces six preconditions, and
// Upload.status only covers one of them (the book is registered and Pending):
//
//   librarians[msg.sender].active                     caller-side, checked by the UI
//   stakes[hash].active                               ── not in Postgres
//   stakes[hash].staker != msg.sender                 ── not in Postgres
//   block.timestamp < stakes[hash].timestamp + CHALLENGE_PERIOD   ── not in Postgres
//   library.getUploadStatus(hash) == Pending          mirrored as Upload.status
//   challenges[hash].challenger == address(0)         ── not in Postgres
//
// The event listener routes status changes through library events only (see
// services/eventListener.service.js), so `Staked` never touches Upload.status.
// A queue built on status='pending' alone lists books whose challenge reverts,
// which is worse than no queue at all: the librarian pays gas to learn that.
//
// The library-status precondition is NOT re-read on-chain. A stale 'pending' row
// for a book that was already challenged still gets dropped, because the stake
// read sees challenges[hash] populated — one read covers both facts.

const prisma = require('../config/db');
const { isValidWalletAddress } = require('../middleware/auth.middleware');
const { getStakeStatus, isActiveLibrarian } = require('../services/blockchain.service');
const { toPublicUpload, PUBLIC_UPLOAD_SELECT } = require('./upload.controller');
const { handleChainError } = require('./rental.controller');
const { parsePositiveInt, MAX_LIMIT } = require('./search.controller');
const { NEAR_DUPLICATE_THRESHOLD } = require('../services/dedup.service');
const {
  REVIEW_COUNT,
  verifyChallengeReview,
  summarizeReviews,
  isStoredChallengeReviewValid,
} = require('../services/challengeReview.service');

// Only registered-and-pending books are ever candidates. "pending_stake" has no
// stake to challenge, and approved/rejected/challenged are all past the window.
const QUEUE_STATUS = 'pending';

const DEFAULT_LIMIT = 50;

// The upload row as the queue reads it: the public book fields plus the audit
// columns. Deliberately NOT simHash — the distance is precomputed at upload
// time precisely so fingerprints never have to travel to a browser.
const QUEUE_SELECT = {
  ...PUBLIC_UPLOAD_SELECT,
  nearDuplicateDistance: true,
  clamavStatus: true,
  textWordCount: true,
  textlessPageCount: true,
};

// What the dashboard needs about the book a near-duplicate matched: enough to
// name it, link to it, and say whether the same archivist uploaded both.
const MATCH_SELECT = {
  arweaveHash: true,
  title: true,
  author: true,
  status: true,
  uploader: true,
};

// More than half the pages carrying no text reads as a part-scanned book.
const MOSTLY_TEXTLESS_RATIO = 0.5;

// Candidates per on-chain round trip. Each candidate costs three eth_calls
// inside getStakeStatus, so a 50-book page is 150 reads — fine in sequence,
// rude to a public RPC all at once.
const CHUNK_SIZE = 10;

function badRequest(res, reason, message) {
  return res.status(400).json({ error: reason, message });
}

/**
 * Promise.allSettled over `items`, CHUNK_SIZE at a time.
 *
 * Settled rather than all: one unreachable read must cost one book, not the
 * whole queue. The caller counts the rejections instead of hiding them.
 */
async function settleInChunks(items, fn, size = CHUNK_SIZE) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    results.push(...(await Promise.allSettled(chunk.map(fn))));
  }
  return results;
}

/**
 * What the automated checks found, and — just as important — what they could
 * not check at all.
 *
 * This replaces the `X/100 (AI)` score the dashboard used to show, which no
 * backend ever produced. The checks that do exist answer unrelated questions
 * and do not average into one number: the security scan is pass/fail (and a
 * failure is rejected at upload, so every book here passed), near-duplicate
 * detection is a bit distance, and the text inventory is a precondition for
 * both — a book with no text passes the content checks without being read.
 *
 * Categorising is done here rather than in the frontend so the rules are in one
 * place and under test. The wording shown to the librarian belongs to the UI.
 *
 * @param {object} row — upload row selected with QUEUE_SELECT
 * @param {object} [match] — the near-duplicate's own row, when it still exists
 */
function buildAudit(row, match) {
  const flags = [];

  const security = {
    // Layer 2 rejects structural exploits outright, so a stored book passed.
    structuralScan: 'passed',
    // Null predates the column: "unknown", which is not the same as "not_run".
    clamav: row.clamavStatus == null ? 'unknown' : row.clamavStatus === 'clean' ? 'clean' : 'not_run',
  };

  let duplicate = null;
  if (row.isNearDuplicate && row.nearDuplicateOf) {
    flags.push('NEAR_DUPLICATE');
    duplicate = {
      arweaveHash: row.nearDuplicateOf,
      // Null when the match is a row this queue cannot see or no longer exists.
      title: match ? match.title : null,
      author: match ? match.author : null,
      status: match ? match.status : null,
      // A re-upload by the same archivist is a different conversation from one
      // archivist re-publishing another's book.
      sameUploader: Boolean(
        match && row.uploader && match.uploader && match.uploader.toLowerCase() === row.uploader.toLowerCase()
      ),
      hammingDistance: row.nearDuplicateDistance ?? null,
      threshold: NEAR_DUPLICATE_THRESHOLD,
    };
  }

  let text = null;
  if (row.textWordCount != null) {
    const pageCount = row.pageCount || 0;
    const textlessPages = row.textlessPageCount ?? null;

    text = {
      wordCount: row.textWordCount,
      wordsPerPage: pageCount ? Math.round(row.textWordCount / pageCount) : null,
      textlessPages,
      pageCount: pageCount || null,
    };

    // No text at all: near-duplicate detection was skipped for this book, so
    // the absence of a duplicate flag above means nothing.
    if (row.textWordCount === 0) {
      flags.push('NO_TEXT_LAYER');
    } else if (pageCount && textlessPages != null && textlessPages > pageCount * MOSTLY_TEXTLESS_RATIO) {
      flags.push('MOSTLY_TEXTLESS');
    }
  }

  return { flags, security, duplicate, text };
}

/**
 * Can a librarian challenge this book right now?
 *
 * `librarian` is optional — when absent the own-upload rule cannot be applied,
 * so the queue is returned unfiltered on that one axis and the contract's own
 * require() remains the backstop.
 */
function isChallengeable(stake, librarian) {
  if (!stake || !stake.staked || !stake.active) return false;
  // challenges[hash].challenger != address(0) — already challenged, resolved or not.
  if (stake.challenge) return false;
  if (stake.challengePeriodOver) return false;
  if (librarian && stake.staker && stake.staker.toLowerCase() === librarian) return false;
  return true;
}

// GET /api/librarian/review-queue?librarian=0x…&limit=50
//
// No auth. The librarian address only filters out the caller's own uploads and
// is not trusted for anything — challengeUpload() is signed by the librarian's
// own wallet and re-checks every precondition on-chain.
async function getReviewQueue(req, res, next) {
  try {
    const { librarian } = req.query;

    if (librarian !== undefined && !isValidWalletAddress(librarian)) {
      return badRequest(
        res,
        'invalid_wallet_address',
        'librarian must be a 0x-prefixed 40-hex-character Ethereum address.'
      );
    }

    // Lower-cased to match how uploader rows are written, and compared against
    // the on-chain staker the same way.
    const librarianAddr = librarian ? librarian.toLowerCase() : null;

    const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT);
    if (limit === null || limit > MAX_LIMIT) {
      return badRequest(res, 'invalid_limit', `limit must be a positive integer up to ${MAX_LIMIT}.`);
    }

    const rows = await prisma.upload.findMany({
      where: { status: QUEUE_STATUS },
      select: QUEUE_SELECT,
      orderBy: { uploadTimestamp: 'desc' },
      take: limit,
    });

    const settled = await settleInChunks(rows, (row) => getStakeStatus(row.arweaveHash));

    const challengeable = [];
    let unavailable = 0;

    rows.forEach((row, i) => {
      const result = settled[i];

      if (result.status === 'rejected') {
        // The RPC could not answer for this book. Excluded rather than shown:
        // an unverified row is exactly the reverting-challenge case this route
        // exists to prevent. Counted so the UI can say so out loud.
        unavailable++;
        return;
      }

      const stake = result.value;
      if (!isChallengeable(stake, librarianAddr)) return;

      challengeable.push({ row, stake });
    });

    // The books the near-duplicate flags point at, fetched in one query for the
    // whole page. Only the survivors need naming, so this runs after the chain
    // filter rather than over every candidate.
    const matchHashes = [
      ...new Set(challengeable.map(({ row }) => row.nearDuplicateOf).filter(Boolean)),
    ];
    const matches = matchHashes.length
      ? await prisma.upload.findMany({
          where: { arweaveHash: { in: matchHashes } },
          select: MATCH_SELECT,
        })
      : [];
    const matchByHash = new Map(matches.map((m) => [m.arweaveHash, m]));

    const queue = challengeable.map(({ row, stake }) => ({
      ...toPublicUpload(row),
      staker: stake.staker ?? null,
      stakeAmountAlex: stake.stakeAmountAlex ?? null,
      stakeTime: stake.stakeTime ?? null,
      challengePeriodEnds: stake.challengePeriodEnds ?? null,
      // Why this book is worth a look, and what was never checked on it.
      audit: buildAudit(row, matchByHash.get(row.nearDuplicateOf)),
    }));

    // Soonest deadline first — the only ordering that reflects what the
    // librarian is about to lose the ability to act on.
    queue.sort((a, b) => new Date(a.challengePeriodEnds) - new Date(b.challengePeriodEnds));

    return res.json({
      queue,
      total: queue.length,
      // Every registered-and-pending book considered, before the chain filter.
      // `candidates > 0 && total === 0` is "nothing challengeable right now",
      // which is a different empty state from "nothing pending at all".
      candidates: rows.length,
      unavailable,
      librarian: librarianAddr,
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// GET /api/librarian/challenges?librarian=0x…
// Pending on-chain challenges with independent-review progress. Vote directions
// stay hidden until all three reviews are in, preventing early votes from
// influencing the remaining librarians.
async function getChallengeReviews(req, res, next) {
  try {
    const { librarian } = req.query;
    if (librarian !== undefined && !isValidWalletAddress(librarian)) {
      return badRequest(res, 'invalid_wallet_address', 'librarian must be a valid Ethereum address.');
    }
    const librarianAddr = librarian ? librarian.toLowerCase() : null;

    const rows = await prisma.upload.findMany({
      where: { status: 'challenged' },
      select: {
        ...QUEUE_SELECT,
        uploader: true,
      },
      orderBy: { uploadTimestamp: 'desc' },
      take: MAX_LIMIT,
    });
    const chainResults = await settleInChunks(rows, (row) => getStakeStatus(row.arweaveHash));
    const candidates = [];
    let unavailable = 0;
    rows.forEach((row, i) => {
      const result = chainResults[i];
      if (result.status === 'rejected') {
        unavailable++;
        return;
      }
      const challenge = result.value.challenge;
      if (!challenge || challenge.resolved) return;
      candidates.push({ row, challenge, staker: result.value.staker ?? null });
    });

    const hashes = candidates.map(({ row }) => row.arweaveHash);
    const reviews = hashes.length
      ? await prisma.challengeReview.findMany({
          where: { arweaveHash: { in: hashes } },
          orderBy: { reviewedAt: 'asc' },
          select: { arweaveHash: true, librarian: true, vote: true, rationale: true, reviewedAt: true },
        })
      : [];
    const byHash = new Map();
    for (const review of reviews) {
      const list = byHash.get(review.arweaveHash) || [];
      list.push(review);
      byHash.set(review.arweaveHash, list);
    }

    const queue = candidates.map(({ row, challenge, staker }) => {
      // Re-verify signed ballot contents at read time. The database is an index,
      // not a trusted authority that may rewrite a wallet's decision.
      const allReviews = (byHash.get(row.arweaveHash) || []).filter(isStoredChallengeReviewValid);
      const ownReview = librarianAddr
        ? allReviews.find((review) => review.librarian.toLowerCase() === librarianAddr) || null
        : null;
      const summary = summarizeReviews(allReviews);
      const revealed = summary.submitted === REVIEW_COUNT;
      return {
        ...toPublicUpload(row),
        challenger: challenge.challenger,
        staker,
        challengeReason: challenge.reason,
        challengedAt: challenge.challengedAt,
        challengePeriodEnds: challenge.challengePeriodEnds,
        review: {
          ...summary,
          ownVote: ownReview ? { vote: ownReview.vote, rationale: ownReview.rationale, reviewedAt: ownReview.reviewedAt } : null,
          ballots: revealed
            ? allReviews.map(({ librarian: reviewer, vote, rationale, reviewedAt }) => ({ reviewer, vote, rationale, reviewedAt }))
            : null,
          ownerResolution: 'awaiting_owner',
        },
      };
    });

    return res.json({ queue, total: queue.length, unavailable, requiredReviews: REVIEW_COUNT });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// POST /api/librarian/challenges/:arweaveHash/reviews
// Body: { librarian, vote, rationale, timestamp, signature }
async function submitChallengeReview(req, res, next) {
  const { arweaveHash } = req.params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(arweaveHash)) {
    return badRequest(res, 'invalid_hash', 'arweaveHash must be a 43-character base64url transaction ID.');
  }

  try {
    const { librarian, vote, rationale, timestamp, signature } = req.body || {};
    if (!isValidWalletAddress(librarian)) {
      return badRequest(res, 'invalid_wallet_address', 'librarian must be a valid Ethereum address.');
    }
    const verified = verifyChallengeReview({ arweaveHash, librarian, vote, rationale, timestamp, signature });
    if (!verified.ok) {
      return res.status(verified.status).json({ error: verified.error, message: verified.message });
    }

    const row = await prisma.upload.findUnique({
      where: { arweaveHash },
      select: { arweaveHash: true, status: true, uploader: true },
    });
    if (!row || row.status !== 'challenged') {
      return res.status(404).json({ error: 'challenge_not_found', message: 'No pending challenge exists for this book.' });
    }

    const [librarianStatus, stake] = await Promise.all([
      isActiveLibrarian(verified.librarian),
      getStakeStatus(arweaveHash),
    ]);
    if (!librarianStatus.active) {
      return res.status(403).json({ error: 'not_active_librarian', message: 'Only active librarians may review challenges.' });
    }
    if (!stake.challenge || stake.challenge.resolved) {
      return res.status(409).json({ error: 'challenge_resolved', message: 'This challenge is already resolved on-chain.' });
    }
    if ([stake.challenge.challenger, stake.staker, row.uploader].some((address) => address && address.toLowerCase() === verified.librarian)) {
      return res.status(403).json({ error: 'conflicted_reviewer', message: 'The challenger and the book’s uploader/staker cannot review this challenge.' });
    }

    let submitResult;
    try {
      submitResult = await prisma.$transaction(async (tx) => {
        // Lock the upload row, not just the review rows (which do not exist yet),
        // so concurrent fourth-vote requests serialize before checking the cap.
        await tx.$queryRaw`SELECT "arweaveHash" FROM "Upload" WHERE "arweaveHash" = ${arweaveHash} FOR UPDATE`;
        const existing = await tx.challengeReview.findUnique({
          where: { arweaveHash_librarian: { arweaveHash, librarian: verified.librarian } },
          select: { id: true },
        });
        if (existing) return 'already_submitted';

        const total = await tx.challengeReview.count({ where: { arweaveHash } });
        if (total >= REVIEW_COUNT) return 'reviews_complete';

        await tx.challengeReview.create({
          data: {
            arweaveHash,
            librarian: verified.librarian,
            vote: verified.vote,
            rationale: verified.rationale,
            signedMessage: verified.message,
            signature: verified.signature,
          },
        });
        return 'created';
      });
    } catch (err) {
      if (err && err.code === 'P2002') submitResult = 'already_submitted';
      else throw err;
    }
    if (submitResult === 'already_submitted') {
      return res.status(409).json({ error: 'review_already_submitted', message: 'Each librarian may submit one immutable review per challenge.' });
    }
    if (submitResult === 'reviews_complete') {
      return res.status(409).json({ error: 'reviews_complete', message: 'Three librarian reviews have already been submitted.' });
    }

    const reviews = await prisma.challengeReview.findMany({
      where: { arweaveHash },
      select: { vote: true },
    });
    return res.status(201).json({ review: summarizeReviews(reviews), message: 'Your signed review was recorded.' });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

module.exports = {
  getReviewQueue,
  getChallengeReviews,
  submitChallengeReview,
  isChallengeable,
  buildAudit,
  QUEUE_STATUS,
  DEFAULT_LIMIT,
  CHUNK_SIZE,
  MOSTLY_TEXTLESS_RATIO,
};
