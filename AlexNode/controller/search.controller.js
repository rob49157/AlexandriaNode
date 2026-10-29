// Search over the Postgres index — the catalogue browse/search surface.
//
// This queries the off-chain index only. It never touches Arweave or the chain:
// every field it filters on was written at upload time, and status is kept
// current by the event listener (Phase 6b). A stale row here is a sync bug, not
// a source-of-truth conflict — Arweave and the contracts remain authoritative.

const prisma = require('../config/db');
const { ALLOWED_CATEGORIES } = require('../services/validation.service');
const { toPublicUpload, PUBLIC_UPLOAD_SELECT } = require('./upload.controller');

// Statuses a caller may ask for. "pending_stake" is included so the frontend can
// show an archivist their own unfinished uploads, but it is never the default.
// Catalogue states only. The storage-worker states `pending_confirmation` and
// `storage_failed` (ARWEAVE-DIRECT-PLAN.md §3) are deliberately absent: those rows
// have no confirmed bytes on Arweave, so listing them as books would point readers
// at hashes that 404. Storage progress belongs on GET /api/storage/status.
const SEARCH_STATUSES = ['approved', 'pending', 'pending_stake', 'challenged', 'rejected'];

// Only approved books are public by default. Anything else has not survived the
// stake-and-challenge window yet, so it is opt-in via ?status=.
const DEFAULT_STATUS = 'approved';

// ?inReview=true adds the books still inside their 14-day challenge window to
// the approved ones: browsable, not yet rentable (Rent.rentBook() requires
// Approved). Only a STAKED pending book counts: an unstaked one has no window
// running and may never get one.
const IN_REVIEW_OR_APPROVED = [
  { status: 'approved' },
  { status: 'pending', stakedAt: { not: null } },
];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Long enough for a full title, short enough that nobody is sending a novel
// through a LIKE pattern.
const MAX_QUERY_LENGTH = 200;

function badRequest(res, reason, message) {
  return res.status(400).json({ error: reason, message });
}

/**
 * Parse a 1-based positive integer query param, falling back to `fallback` when
 * absent. Returns null for anything present but malformed, so the caller can
 * tell "not supplied" from "supplied as garbage" and reject the latter.
 */
function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  // Number() rather than parseInt() on purpose: parseInt('3abc') is 3, which
  // would silently accept a typo'd page number.
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// GET /api/search?q=&category=&status=&inReview=&page=&limit=
//
// `q` matches title OR author, case-insensitively, anywhere in the field.
// Omitting it browses the whole (filtered) catalogue newest-first.
// Delisted books never appear: Rent.delistBook() is a permanent takedown.
async function search(req, res, next) {
  try {
    const { q, category, status, inReview } = req.query;

    // --- Validate the filters ---------------------------------------------
    const query = typeof q === 'string' ? q.trim() : '';
    if (query.length > MAX_QUERY_LENGTH) {
      return badRequest(res, 'query_too_long', `q must be ${MAX_QUERY_LENGTH} characters or fewer.`);
    }

    if (category !== undefined && !ALLOWED_CATEGORIES.includes(category)) {
      return badRequest(res, 'invalid_category', `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}.`);
    }

    if (status !== undefined && !SEARCH_STATUSES.includes(status)) {
      return badRequest(res, 'invalid_status', `status must be one of: ${SEARCH_STATUSES.join(', ')}.`);
    }

    if (inReview !== undefined && inReview !== 'true' && inReview !== 'false') {
      return badRequest(res, 'invalid_in_review', 'inReview must be true or false.');
    }
    const withInReview = inReview === 'true';
    if (withInReview && status !== undefined) {
      return badRequest(res, 'conflicting_filters', 'inReview already chooses the statuses; drop status.');
    }

    const page = parsePositiveInt(req.query.page, 1);
    if (page === null) {
      return badRequest(res, 'invalid_page', 'page must be a positive integer.');
    }

    const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT);
    if (limit === null || limit > MAX_LIMIT) {
      return badRequest(res, 'invalid_limit', `limit must be a positive integer up to ${MAX_LIMIT}.`);
    }

    // --- Build the where clause -------------------------------------------
    const where = { delisted: false };
    // Each entry is one OR group. Both inReview and q need one, and a where has
    // a single OR key, so the groups are ANDed together.
    const anyOf = [];

    if (withInReview) {
      anyOf.push(IN_REVIEW_OR_APPROVED);
    } else {
      where.status = status || DEFAULT_STATUS;
    }

    if (category !== undefined) {
      where.category = category;
    }

    if (query) {
      anyOf.push([
        { title: { contains: query, mode: 'insensitive' } },
        { author: { contains: query, mode: 'insensitive' } },
      ]);
    }

    if (anyOf.length) {
      where.AND = anyOf.map((clauses) => ({ OR: clauses }));
    }

    // --- Query -------------------------------------------------------------
    // count + page in one round trip. $transaction also pins both to the same
    // snapshot, so `total` can't disagree with the page under a concurrent write.
    const [total, rows] = await prisma.$transaction([
      prisma.upload.count({ where }),
      prisma.upload.findMany({
        where,
        select: PUBLIC_UPLOAD_SELECT,
        orderBy: { uploadTimestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return res.json({
      results: rows.map(toPublicUpload),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
      query: {
        q: query || null,
        category: category || null,
        status: withInReview ? null : where.status,
        inReview: withInReview,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { search, parsePositiveInt, SEARCH_STATUSES, DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LENGTH };
