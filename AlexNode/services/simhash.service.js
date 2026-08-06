// 64-bit SimHash text fingerprinting for near-duplicate PDF detection.
//
// SimHash produces a fixed-size fingerprint from text such that documents with
// similar content have fingerprints that differ in only a few bits. This makes
// it efficient for near-duplicate detection at scale — just compute the Hamming
// distance between two hashes.
//
// Algorithm:
//   1. Tokenize text into unigrams (normalized lowercase words).
//   2. Hash each token with a 64-bit hash (we use two 32-bit MD5 halves).
//   3. For each hash, walk the 64 bits: bit=1 → weight +1, bit=0 → weight -1.
//   4. Sum all weights per bit position across all tokens.
//   5. Final fingerprint: bit i = (sum[i] > 0) ? 1 : 0.
//
// Output: 16-character hex string (64 bits).
//
// Banded LSH:
//   Comparing a new fingerprint against every stored fingerprint is O(n). To
//   avoid that, the 64 bits are split into BAND_COUNT contiguous bands, each
//   stored as its own indexed integer column. By the pigeonhole principle, two
//   fingerprints that differ in at most (BAND_COUNT - 1) bits must share at
//   least one *identical* band — those bits cannot touch every band at once.
//   So an indexed "any band matches" lookup is guaranteed to return every true
//   near-duplicate, and the exact Hamming distance is then computed only on
//   that small candidate set.
//
//   The guarantee holds only while the distance threshold is <= BAND_COUNT - 1
//   (3 with 4 bands). Above that, band lookup can miss real matches, so callers
//   must fall back to a full scan. See MAX_GUARANTEED_DISTANCE.

const crypto = require('crypto');

// --- Fingerprint shape ---

const HASH_BITS = 64;
const HASH_HEX_CHARS = HASH_BITS / 4; // 16
const HASH_PATTERN = new RegExp(`^[0-9a-fA-F]{${HASH_HEX_CHARS}}$`);

// Fingerprint of empty/unextractable text — no tokens, so nothing to compare.
const EMPTY_SIMHASH = '0'.repeat(HASH_HEX_CHARS);

// --- Banding parameters ---

const BAND_COUNT = 4;
const BAND_BITS = HASH_BITS / BAND_COUNT; // 16
const BAND_HEX_CHARS = BAND_BITS / 4; // 4 hex chars per band
// Max Hamming distance for which "share a band" is a lossless prefilter.
const MAX_GUARANTEED_DISTANCE = BAND_COUNT - 1;

// --- Tokenization ---
// Normalize: lowercase, strip non-alphanumeric, split on whitespace, drop short words.

/**
 * Tokenize text into normalized unigrams.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2); // Drop single-character tokens
}

// --- 64-bit hash via MD5 ---
// MD5 produces 128 bits. We take the first 8 bytes (64 bits) as a BigInt.

/**
 * Hash a string to a 64-bit unsigned BigInt using MD5.
 * @param {string} str
 * @returns {bigint}
 */
function hash64(str) {
  const md5 = crypto.createHash('md5').update(str).digest();
  // Read first 8 bytes as big-endian unsigned 64-bit integer
  return md5.readBigUInt64BE(0);
}

// --- Fingerprint parsing ---

/**
 * Validate a 16-char hex fingerprint and parse it to a BigInt.
 *
 * Fingerprints come back out of Postgres, so a corrupt or truncated row must
 * fail loudly here rather than silently producing a bogus distance.
 *
 * @param {string} hash — 16-char hex string
 * @param {string} [label] — name used in the error message
 * @returns {bigint}
 * @throws {TypeError} if the input is not a 16-character hex string
 */
function parseHash64(hash, label = 'simHash') {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw new TypeError(
      `Invalid ${label}: expected a ${HASH_HEX_CHARS}-character hex string, got ${JSON.stringify(hash)}`
    );
  }
  return BigInt('0x' + hash);
}

/**
 * Split a fingerprint into its BAND_COUNT integer bands, most-significant first.
 *
 * These are the values persisted to the indexed band columns and matched
 * against at query time.
 *
 * @param {string} hash — 16-char hex string
 * @returns {number[]} BAND_COUNT integers, each in [0, 2^BAND_BITS - 1]
 * @throws {TypeError} if the input is not a 16-character hex string
 */
function splitBands(hash) {
  parseHash64(hash, 'simHash'); // Validate shape before slicing
  const bands = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    const start = i * BAND_HEX_CHARS;
    bands.push(parseInt(hash.slice(start, start + BAND_HEX_CHARS), 16));
  }
  return bands;
}

// --- SimHash computation ---

/**
 * Compute a 64-bit SimHash fingerprint from text.
 *
 * @param {string} text — extracted PDF text content
 * @returns {string} 16-character hex string (64 bits), or '0000000000000000' for empty text
 */
function computeSimHash(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return EMPTY_SIMHASH;

  // Weight vector: 64 positions, initialized to 0
  const weights = new Array(64).fill(0);

  for (const token of tokens) {
    const h = hash64(token);
    for (let i = 0; i < 64; i++) {
      // Check bit i (from MSB)
      const bit = (h >> BigInt(63 - i)) & 1n;
      weights[i] += bit === 1n ? 1 : -1;
    }
  }

  // Build final fingerprint
  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (weights[i] > 0) {
      fingerprint |= 1n << BigInt(63 - i);
    }
  }

  return fingerprint.toString(16).padStart(HASH_HEX_CHARS, '0');
}

// --- Hamming distance ---

/**
 * Compute the Hamming distance between two 64-bit hex SimHashes.
 * This is the number of bit positions where the two hashes differ.
 *
 * @param {string} hash1 — 16-char hex string
 * @param {string} hash2 — 16-char hex string
 * @returns {number} distance (0–64)
 * @throws {TypeError} if either input is not a 16-character hex string
 */
function hammingDistance(hash1, hash2) {
  const a = parseHash64(hash1, 'simHash');
  const b = parseHash64(hash2, 'simHash');
  let xor = a ^ b;

  // Count set bits (popcount)
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

// --- Similarity score ---

/**
 * Compute a similarity percentage from Hamming distance.
 * @param {string} hash1
 * @param {string} hash2
 * @returns {number} 0.0–100.0
 */
function similarityScore(hash1, hash2) {
  const distance = hammingDistance(hash1, hash2);
  return ((64 - distance) / 64) * 100;
}

module.exports = {
  tokenize,
  hash64,
  parseHash64,
  computeSimHash,
  splitBands,
  hammingDistance,
  similarityScore,
  // Shape + banding constants
  HASH_BITS,
  HASH_HEX_CHARS,
  EMPTY_SIMHASH,
  BAND_COUNT,
  BAND_BITS,
  MAX_GUARANTEED_DISTANCE,
};
