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
const SEARCH_STATUSES = ['approved', 'pending', 'pending_stake', 'challenged', 'rejected'];

// Only approved books are public by default. Anything else has not survived the
// stake-and-challenge window yet, so it is opt-in via ?status=.
const DEFAULT_STATUS = 'approved';

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

// GET /api/search?q=&category=&status=&page=&limit=
//
// `q` matches title OR author, case-insensitively, anywhere in the field.
// Omitting it browses the whole (filtered) catalogue newest-first.
async function search(req, res, next) {
  try {
    const { q, category, status } = req.query;

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

    const page = parsePositiveInt(req.query.page, 1);
    if (page === null) {
      return badRequest(res, 'invalid_page', 'page must be a positive integer.');
    }

    const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT);
    if (limit === null || limit > MAX_LIMIT) {
      return badRequest(res, 'invalid_limit', `limit must be a positive integer up to ${MAX_LIMIT}.`);
    }

    // --- Build the where clause -------------------------------------------
    const where = { status: status || DEFAULT_STATUS };

    if (category !== undefined) {
      where.category = category;
    }

    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { author: { contains: query, mode: 'insensitive' } },
      ];
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
      query: { q: query || null, category: category || null, status: where.status },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { search, SEARCH_STATUSES, DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LENGTH };
