// Layer 3: Deduplication service — SHA-256 exact duplicate + SimHash near-duplicate.
//
// SHA-256 checks the raw file buffer for an exact match in Postgres.
// SimHash compares extracted text fingerprints for near-duplicate flagging.
//
// Both checks run against the Upload table via Prisma. If the database is
// unreachable, the check throws (upload pipeline will catch and return 500).

const crypto = require('crypto');
const prisma = require('../config/db');
const {
  computeSimHash,
  hammingDistance,
  similarityScore,
  splitBands,
  EMPTY_SIMHASH,
  BAND_COUNT,
  MAX_GUARANTEED_DISTANCE,
} = require('./simhash.service');

// Near-duplicate threshold: Hamming distance ≤ this value flags the upload.
// 3 bits out of 64 ≈ 95.3% similarity.
const NEAR_DUPLICATE_THRESHOLD = parseInt(process.env.SIMHASH_THRESHOLD, 10) || 3;

// Prisma field names for the banded-LSH columns. Must stay in sync with the
// simHashBand* fields in prisma/schema.prisma.
const BAND_FIELDS = Array.from({ length: BAND_COUNT }, (_, i) => `simHashBand${i}`);

// The band prefilter is lossless only while the threshold stays inside the
// pigeonhole guarantee (≤ BAND_COUNT - 1). If an operator raises
// SIMHASH_THRESHOLD past that, band lookup would silently miss real
// near-duplicates, so we fall back to scanning every row instead.
const USE_BAND_PREFILTER = NEAR_DUPLICATE_THRESHOLD <= MAX_GUARANTEED_DISTANCE;

if (!USE_BAND_PREFILTER) {
  console.warn(
    `[dedup] SIMHASH_THRESHOLD=${NEAR_DUPLICATE_THRESHOLD} exceeds the banded-LSH ` +
      `guarantee of ${MAX_GUARANTEED_DISTANCE}. Falling back to a full table scan for ` +
      `near-duplicate checks — correct, but O(n) per upload.`
  );
}

// --- SHA-256 ---

/**
 * Compute SHA-256 hex hash of a buffer.
 * @param {Buffer} buffer
 * @returns {string} 64-character lowercase hex string
 */
function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// --- Exact duplicate check ---

/**
 * Check if an exact duplicate exists in the database.
 *
 * @param {string} sha256Hash — hex hash of the uploaded file
 * @returns {Promise<{ valid: boolean, stage?: string, reason?: string, message?: string, httpStatus?: number, existingArweaveHash?: string }>}
 */
async function checkExactDuplicate(sha256Hash) {
  const existing = await prisma.upload.findUnique({
    where: { sha256Hash },
    select: { arweaveHash: true, title: true },
  });

  if (existing) {
    return {
      valid: false,
      stage: 'deduplication',
      reason: 'exact_duplicate',
      message: `An identical file has already been uploaded (${existing.title || existing.arweaveHash}).`,
      httpStatus: 409,
      existingArweaveHash: existing.arweaveHash,
    };
  }

  return { valid: true };
}

// --- Banded LSH helpers ---

/**
 * Build the band columns for a fingerprint, ready to spread into a Prisma
 * `create`/`update` payload alongside `simHash`.
 *
 * Every write of `simHash` must also write these, or the row becomes invisible
 * to the band prefilter.
 *
 * @param {string} simHash — 16-char hex SimHash
 * @returns {Record<string, number>} e.g. { simHashBand0: 4660, simHashBand1: ... }
 */
function simHashBandFields(simHash) {
  const bands = splitBands(simHash);
  return Object.fromEntries(BAND_FIELDS.map((field, i) => [field, bands[i]]));
}

/**
 * Build the Prisma OR clause matching any single band of a fingerprint.
 * @param {string} simHash — 16-char hex SimHash
 * @returns {Array<Record<string, number>>}
 */
function bandMatchClauses(simHash) {
  const bands = splitBands(simHash);
  return BAND_FIELDS.map((field, i) => ({ [field]: bands[i] }));
}

// --- Near-duplicate check ---

/**
 * Check for near-duplicate uploads using SimHash Hamming distance.
 *
 * Two-stage lookup:
 *   1. Prefilter — pull only rows sharing at least one identical 16-bit band,
 *      using the indexed simHashBand* columns. The pigeonhole principle makes
 *      this lossless for distances ≤ MAX_GUARANTEED_DISTANCE: bits that differ
 *      in ≤ 3 positions cannot perturb all 4 bands, so at least one band still
 *      matches exactly. Recall is 100%, not probabilistic.
 *   2. Verify — compute the true Hamming distance on that candidate set. The
 *      prefilter is deliberately loose (a shared band alone means little), so
 *      this step is what actually decides a match.
 *
 * @param {string} simHash — 16-char hex SimHash of the new upload
 * @returns {Promise<{ isNearDuplicate: boolean, matches: Array<{ arweaveHash: string, title: string, distance: number, similarity: number }>, candidatesScanned: number, prefiltered: boolean }>}
 */
async function checkNearDuplicate(simHash) {
  // Skip if simHash is all zeros (empty text — nothing to compare)
  if (simHash === EMPTY_SIMHASH) {
    return { isNearDuplicate: false, matches: [], candidatesScanned: 0, prefiltered: false };
  }

  // Stored all-zero fingerprints came from PDFs with no extractable text; they
  // can never be a genuine near-duplicate, so keep them out of the candidates.
  const excludeEmpty = { NOT: { simHash: EMPTY_SIMHASH } };

  const where = USE_BAND_PREFILTER
    ? { AND: [excludeEmpty, { OR: bandMatchClauses(simHash) }] }
    : excludeEmpty;

  const candidates = await prisma.upload.findMany({
    where,
    select: { arweaveHash: true, title: true, simHash: true },
  });

  const matches = [];

  for (const upload of candidates) {
    if (!upload.simHash || upload.simHash === EMPTY_SIMHASH) continue;

    const distance = hammingDistance(simHash, upload.simHash);

    if (distance <= NEAR_DUPLICATE_THRESHOLD) {
      matches.push({
        arweaveHash: upload.arweaveHash,
        title: upload.title,
        distance,
        similarity: similarityScore(simHash, upload.simHash),
      });
    }
  }

  return {
    isNearDuplicate: matches.length > 0,
    matches,
    candidatesScanned: candidates.length,
    prefiltered: USE_BAND_PREFILTER,
  };
}

// --- Combined Layer 3 validation ---

/**
 * Run the full Layer 3 deduplication pipeline.
 *
 * @param {Buffer} fileBuffer — raw PDF bytes
 * @param {string} extractedText — text extracted during Layer 1 pdf-parse
 * @returns {Promise<{ valid: boolean, sha256Hash: string, simHash: string, simHashBands: Record<string, number>, isNearDuplicate: boolean, nearDuplicateMatches: Array }>}
 */
async function validateLayer3(fileBuffer, extractedText) {
  // 1. Compute hashes
  const sha256Hash = computeSha256(fileBuffer);
  const simHash = computeSimHash(extractedText || '');
  // Band columns travel with the fingerprint so the persistence step (Phase 5)
  // can write them without recomputing.
  const simHashBands = simHashBandFields(simHash);

  // 2. Exact duplicate check (hard reject)
  const exactResult = await checkExactDuplicate(sha256Hash);
  if (!exactResult.valid) {
    return { ...exactResult, sha256Hash, simHash, simHashBands };
  }

  // 3. Near-duplicate check (soft flag, does not reject)
  const nearResult = await checkNearDuplicate(simHash);

  return {
    valid: true,
    sha256Hash,
    simHash,
    simHashBands,
    isNearDuplicate: nearResult.isNearDuplicate,
    nearDuplicateMatches: nearResult.matches,
  };
}

module.exports = {
  computeSha256,
  checkExactDuplicate,
  checkNearDuplicate,
  simHashBandFields,
  bandMatchClauses,
  validateLayer3,
  NEAR_DUPLICATE_THRESHOLD,
  USE_BAND_PREFILTER,
  BAND_FIELDS,
};
