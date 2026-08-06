// Phase 4 test: Layer 2 Security Scanning + Layer 3 Deduplication.
//
// Run: node tests/securityAndDedup.test.js
//
// Tests:
//   1. Security: clean PDF passes structural scan
//   2. Security: PDF with /JavaScript rejected
//   3. Security: PDF with /OpenAction rejected
//   4. Security: PDF with /Launch rejected
//   5. Security: PDF with /EmbeddedFiles rejected
//   6. Security: PDF with /Encrypt rejected
//   7. Dedup: SHA-256 consistency
//   8. SimHash: identical text → distance 0
//   9. SimHash: similar text → small distance (near-duplicate)
//  10. SimHash: different text → large distance
//  11. Banded LSH: band split, pigeonhole recall guarantee, malformed input
//  12. Full pipeline: clean PDF passes all layers

require('dotenv').config();

const crypto = require('crypto');
const { scanPdfStructure, checkEncrypted, validateLayer2 } = require('../services/securityScan.service');
const {
  computeSimHash,
  hammingDistance,
  similarityScore,
  splitBands,
  BAND_COUNT,
  BAND_BITS,
  MAX_GUARANTEED_DISTANCE,
} = require('../services/simhash.service');
const { computeSha256, simHashBandFields } = require('../services/dedup.service');

// --- Test harness ---
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

// --- Helper: build a minimal valid PDF buffer ---
function makePdf(extraContent = '') {
  // Minimal PDF 1.4 structure that passes magic-byte checks
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
    extraContent,
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '190',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'latin1');
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: Security Scanning Tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Layer 2: Security Scanning ===\n');

// 1. Clean PDF passes
const cleanPdf = makePdf();
const cleanResult = scanPdfStructure(cleanPdf);
assert(cleanResult.valid === true, 'Clean PDF passes structural scan');

// 2. /JavaScript detected
const jsPdf = makePdf('4 0 obj<</Type/Action/S/JavaScript/JS(alert(1))>>endobj');
const jsResult = scanPdfStructure(jsPdf);
assert(jsResult.valid === false, 'PDF with /JavaScript is rejected');
assert(jsResult.reason === 'embedded_javascript', '/JavaScript → reason: embedded_javascript');

// 3. /JS detected
const js2Pdf = makePdf('4 0 obj<</S/JavaScript/JS (app.alert(1))>>endobj');
const js2Result = scanPdfStructure(js2Pdf);
assert(js2Result.valid === false, 'PDF with /JS is rejected');

// 4. /OpenAction detected
const openActionPdf = makePdf('4 0 obj<</Type/Catalog/OpenAction 5 0 R>>endobj');
const openResult = scanPdfStructure(openActionPdf);
assert(openResult.valid === false, 'PDF with /OpenAction is rejected');
assert(openResult.reason === 'auto_action', '/OpenAction → reason: auto_action');

// 5. /Launch detected
const launchPdf = makePdf('4 0 obj<</Type/Action/S/Launch/F(cmd.exe)>>endobj');
const launchResult = scanPdfStructure(launchPdf);
assert(launchResult.valid === false, 'PDF with /Launch is rejected');
assert(launchResult.reason === 'launch_action', '/Launch → reason: launch_action');

// 6. /EmbeddedFiles detected
const embedPdf = makePdf('4 0 obj<</Type/Catalog/Names<</EmbeddedFiles 5 0 R>>>>endobj');
const embedResult = scanPdfStructure(embedPdf);
assert(embedResult.valid === false, 'PDF with /EmbeddedFiles is rejected');
assert(embedResult.reason === 'embedded_files', '/EmbeddedFiles → reason: embedded_files');

// 7. /Encrypt detected
const encryptPdf = makePdf('');
const encryptBuf = Buffer.concat([encryptPdf, Buffer.from('\ntrailer<</Encrypt 5 0 R>>', 'latin1')]);
const encryptResult = checkEncrypted(encryptBuf);
assert(encryptResult.valid === false, 'PDF with /Encrypt is rejected');
assert(encryptResult.reason === 'encrypted_pdf', '/Encrypt → reason: encrypted_pdf');

// 8. /SubmitForm detected
const submitPdf = makePdf('4 0 obj<</Type/Action/S/SubmitForm/F(http://evil.com)>>endobj');
const submitResult = scanPdfStructure(submitPdf);
assert(submitResult.valid === false, 'PDF with /SubmitForm is rejected');
assert(submitResult.reason === 'form_submission', '/SubmitForm → reason: form_submission');

// 9. ClamAV graceful fallback (no daemon running in test environment)
console.log('\n  Testing ClamAV fallback (daemon likely not running)...');
(async () => {
  const layer2Result = await validateLayer2(cleanPdf);
  assert(layer2Result.valid === true, 'Full Layer 2 passes for clean PDF');
  if (layer2Result.clamavSkipped) {
    console.log('  ℹ ClamAV skipped (daemon not available — expected in dev)');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Layer 3: Deduplication Tests
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== Layer 3: Deduplication ===\n');

  // 10. SHA-256 consistency
  const buf = Buffer.from('test data for hashing');
  const hash1 = computeSha256(buf);
  const hash2 = computeSha256(buf);
  assert(hash1 === hash2, 'SHA-256: same input produces same hash');
  assert(hash1.length === 64, 'SHA-256: output is 64 hex characters');

  const differentBuf = Buffer.from('different data');
  const hash3 = computeSha256(differentBuf);
  assert(hash1 !== hash3, 'SHA-256: different input produces different hash');

  // ─────────────────────────────────────────────────────────────────────────
  // SimHash Tests
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== SimHash Fingerprinting ===\n');

  // 11. Identical text → distance 0
  const text1 = 'The quick brown fox jumps over the lazy dog near the river bank';
  const sim1a = computeSimHash(text1);
  const sim1b = computeSimHash(text1);
  assert(sim1a === sim1b, 'SimHash: identical text → identical hash');
  assert(hammingDistance(sim1a, sim1b) === 0, 'SimHash: identical text → distance 0');

  // 12. Similar text → small distance
  const text2 = 'The quick brown fox leaps over the lazy dog near the river bank';
  const sim2 = computeSimHash(text2);
  const dist12 = hammingDistance(sim1a, sim2);
  const pct12 = similarityScore(sim1a, sim2);
  assert(dist12 <= 10, `SimHash: similar text → small distance (got ${dist12})`);
  console.log(`    distance=${dist12}, similarity=${pct12.toFixed(1)}%`);

  // 13. Very different text → large distance
  const text3 = 'Quantum mechanics describes nature at the smallest scales of energy levels of atoms and subatomic particles';
  const sim3 = computeSimHash(text3);
  const dist13 = hammingDistance(sim1a, sim3);
  const pct13 = similarityScore(sim1a, sim3);
  assert(dist13 > 10, `SimHash: different text → large distance (got ${dist13})`);
  console.log(`    distance=${dist13}, similarity=${pct13.toFixed(1)}%`);

  // 14. Empty text → all zeros
  const simEmpty = computeSimHash('');
  assert(simEmpty === '0000000000000000', 'SimHash: empty text → all zeros');

  // 15. Hash is 16 hex chars (64 bits)
  assert(sim1a.length === 16, 'SimHash: output is 16 hex characters (64 bits)');
  assert(/^[0-9a-f]{16}$/.test(sim1a), 'SimHash: output is valid hex');

  // ─────────────────────────────────────────────────────────────────────────
  // Banded LSH
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== Banded LSH Prefilter ===\n');

  // --- helpers ---
  const randomHash64 = () => crypto.randomBytes(8).toString('hex');

  // Flip the given bit positions (0 = least significant) in a hex fingerprint.
  function flipBits(hash, positions) {
    let value = BigInt('0x' + hash);
    for (const p of positions) value ^= 1n << BigInt(p);
    return value.toString(16).padStart(16, '0');
  }

  // Pick `count` distinct bit positions in [0, 64).
  function pickDistinctBits(count) {
    const chosen = new Set();
    while (chosen.size < count) chosen.add(Math.floor(Math.random() * 64));
    return [...chosen];
  }

  // Does any band hold an identical value in both fingerprints?
  function sharesBand(a, b) {
    const bandsA = splitBands(a);
    const bandsB = splitBands(b);
    return bandsA.some((v, i) => v === bandsB[i]);
  }

  // 16. Band split is correct and reversible
  const knownHash = '0123456789abcdef';
  const knownBands = splitBands(knownHash);
  assert(
    JSON.stringify(knownBands) === JSON.stringify([0x0123, 0x4567, 0x89ab, 0xcdef]),
    `splitBands: '${knownHash}' → [0x0123, 0x4567, 0x89ab, 0xcdef]`
  );
  assert(knownBands.length === BAND_COUNT, `splitBands: returns ${BAND_COUNT} bands`);
  const reassembled = knownBands.map((b) => b.toString(16).padStart(4, '0')).join('');
  assert(reassembled === knownHash, 'splitBands: bands reassemble to the original hash');
  assert(
    knownBands.every((b) => b >= 0 && b < 2 ** BAND_BITS),
    `splitBands: every band fits in ${BAND_BITS} bits`
  );

  // 17. Band fields map onto the Prisma column names
  const bandFields = simHashBandFields(knownHash);
  assert(
    JSON.stringify(bandFields) ===
      JSON.stringify({ simHashBand0: 0x0123, simHashBand1: 0x4567, simHashBand2: 0x89ab, simHashBand3: 0xcdef }),
    'simHashBandFields: produces simHashBand0..3 keyed for Prisma'
  );

  // 18. THE GUARANTEE: any two fingerprints within MAX_GUARANTEED_DISTANCE
  //     must share at least one identical band. This is what makes the indexed
  //     band lookup lossless — if it ever fails, near-duplicates get missed.
  const TRIALS = 5000;
  let recallFailures = 0;
  let worstCandidateBands = 0;
  for (let t = 0; t < TRIALS; t++) {
    const original = randomHash64();
    const flipCount = 1 + Math.floor(Math.random() * MAX_GUARANTEED_DISTANCE); // 1..3
    const mutated = flipBits(original, pickDistinctBits(flipCount));

    // Sanity: we really did move exactly `flipCount` bits
    if (hammingDistance(original, mutated) !== flipCount) recallFailures++;
    if (!sharesBand(original, mutated)) recallFailures++;

    const shared = splitBands(original).filter((v, i) => v === splitBands(mutated)[i]).length;
    worstCandidateBands = Math.max(worstCandidateBands, BAND_COUNT - shared);
  }
  assert(
    recallFailures === 0,
    `Pigeonhole: ${TRIALS} random mutations within distance ${MAX_GUARANTEED_DISTANCE} all share a band`
  );
  console.log(`    ${TRIALS} trials, 0 missed candidates, max perturbed bands=${worstCandidateBands}`);

  // 19. The boundary is real: one flipped bit per band defeats the prefilter.
  //     This is exactly why SIMHASH_THRESHOLD > 3 must fall back to a full scan.
  const spreadOut = flipBits(knownHash, [63, 47, 31, 15]); // one bit in each band
  assert(
    hammingDistance(knownHash, spreadOut) === BAND_COUNT,
    `Boundary: flipping one bit per band → distance ${BAND_COUNT}`
  );
  assert(
    !sharesBand(knownHash, spreadOut),
    `Boundary: distance ${BAND_COUNT} can share zero bands (guarantee stops at ${MAX_GUARANTEED_DISTANCE})`
  );

  // 20. Real fingerprints round-trip through banding
  const realBands = splitBands(sim1a);
  assert(
    realBands.map((b) => b.toString(16).padStart(4, '0')).join('') === sim1a,
    'Banding: a computed SimHash reassembles from its bands'
  );
  assert(sharesBand(sim1a, sim2), 'Banding: near-duplicate text pair shares a band (would be a candidate)');

  // 21. Malformed fingerprints fail loudly instead of silently comparing wrong
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  assert(throws(() => splitBands('nothex0000000000')), 'splitBands: rejects non-hex input');
  assert(throws(() => splitBands('abc')), 'splitBands: rejects wrong-length input');
  assert(throws(() => splitBands(null)), 'splitBands: rejects null');
  assert(throws(() => hammingDistance('zzzz', sim1a)), 'hammingDistance: rejects malformed input');

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${failed === 0 ? 'ALL PASSED ✓' : 'SOME FAILED ✗'}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failed === 0 ? 0 : 1);
})();
