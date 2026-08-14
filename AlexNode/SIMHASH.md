# SimHash & Banded LSH — How Near-Duplicate Detection Works

How Alexandria detects that two uploads are *the same book* even when they are not the same *file*.

**Files involved**
| File | Role |
|---|---|
| `services/simhash.service.js` | Pure math — fingerprinting, bands, distance. No database, no I/O. |
| `services/dedup.service.js` | Layer 3 orchestration — the only file here that talks to Postgres. |
| `prisma/schema.prisma` | Storage — `simHash` + the four indexed `simHashBand0..3` columns. |

Every number in this document is real output from the code, not illustration.

---

## 1. The problem SHA-256 can't solve

Layer 3 starts with a SHA-256 of the raw file bytes. It's a **hard reject** — an identical file returns `409 Conflict`.

But cryptographic hashes are built to *avalanche*: change one bit of input, and roughly half the output bits flip. Watch what happens when two OCR typos are introduced into a paragraph of *Moby Dick* (`watery`→`wattery`, `spleen`→`spieen`):

```
SHA-256 of version A:  d2a11c5979171ca7bf8c4e4fbe8efa05...
SHA-256 of version B:  e662391a18162f44d766229205a9546a...
                       ↑ completely unrelated
```

That avalanche is exactly what you want from a security hash and exactly what you *don't* want for duplicate detection. And SHA-256 breaks on far less than a typo:

- Re-saving the PDF in a different reader rewrites the xref table
- A different producer (Acrobat vs. Ghostscript) compresses differently
- Adding a bookmark, a watermark, or stripping metadata
- Any re-scan of the same physical book

All of these are **the same book** with a **completely unrelated SHA-256**.

**Why that matters here specifically:**

1. **Arweave is permanent and prepaid.** A duplicate isn't a row you delete later — it's a storage fee the treasury pays forever.
2. **Staking rewards create a farming incentive.** If re-encoding a PDF defeats dedup, uploading the same book 50 times becomes profitable.

So we need a fingerprint that measures **content similarity**, not byte equality. That's SimHash.

---

## 2. What SimHash does differently

> **A cryptographic hash answers "are these identical?"**
> **SimHash answers "how similar are these?"**

The trick: instead of every input bit influencing every output bit, each output bit is decided by a **majority vote** among the document's words. Change a few words and most votes still land the same way — so the fingerprint *barely moves*.

Same two versions as above:

```
SimHash of A:  afc42d4f4c1045fb
SimHash of B:  afc42d6f4c0045f9
               ↑ 3 bits different out of 64 → 95.3% similar
```

---

## 3. The algorithm, step by step

Worked with the tiny input `"the cat sat on the mat"` so every number is checkable by hand.

### Step 1 — Tokenize

`tokenize()` lowercases, strips punctuation, splits on whitespace, and drops 1-character tokens:

```js
"the cat sat on the mat"  →  ["the", "cat", "sat", "on", "the", "mat"]
```

Note `"the"` appears **twice**. It is not deduplicated — repeated words vote twice, so frequency naturally carries weight.

### Step 2 — Hash every token to 64 bits

`hash64()` takes an MD5 digest and reads the first 8 bytes as a 64-bit integer:

```
the    0x8fc42c6ddf9966db    bits[0..7] = 10001111
cat    0xd077f244def8a70e    bits[0..7] = 11010000
sat    0x53e8254b3222a33f    bits[0..7] = 01010011
on     0xed2b5c0139cec8ad    bits[0..7] = 11101101
the    0x8fc42c6ddf9966db    bits[0..7] = 10001111   ← same word, same hash
mat    0x4a258d930b7d3409    bits[0..7] = 01001010
```

> **MD5 here is not a security choice.** Nothing is being protected — we just need bits that spread evenly. Collision resistance is irrelevant.

### Step 3 — Vote at each of the 64 bit positions

This is the heart of it. For every bit position, **each token casts one vote**: that token's bit is `1` → **+1**, bit is `0` → **−1**. Sum the votes.

Read the grid below as a table with two axes:

- **Each row is one bit position.** There are 64 in total; only the first 8 are shown.
- **Each column is one token.** All 6 tokens vote in every row — that's why every row has 6 numbers.

The full grid is 6 tokens × 64 positions = 384 votes. Here are the first 8 rows:

```
             the  cat  sat  on   the  mat  │  sum  │  bit
            ─────────────────────────────  │  ───  │  ───
  pos 0:     +1   +1   -1   +1   +1   -1   │   +2  │   1
  pos 1:     -1   +1   +1   +1   -1   +1   │   +2  │   1
  pos 2:     -1   -1   -1   +1   -1   -1   │   -4  │   0
  pos 3:     -1   +1   +1   -1   -1   -1   │   -2  │   0
  pos 4:     +1   -1   -1   +1   +1   +1   │   +2  │   1
  pos 5:     +1   -1   -1   +1   +1   -1   │    0  │   0   ← tie breaks to 0 (`weights[i] > 0`)
  pos 6:     +1   -1   +1   -1   +1   +1   │   +2  │   1
  pos 7:     +1   -1   +1   +1   +1   -1   │   +2  │   1
                                              ↑       ↑
                                        vote total   sign decides the bit
```

Trace one row to see where its numbers come from. **Row `pos 0`** reads the *first* bit of all six token hashes from Step 2:

```
the → 10001111   first bit = 1  →  +1
cat → 11010000   first bit = 1  →  +1
sat → 01010011   first bit = 0  →  -1
on  → 11101101   first bit = 1  →  +1
the → 10001111   first bit = 1  →  +1     (same word, same hash, votes again)
mat → 01001010   first bit = 0  →  -1
                                    ────
                              sum =  +2   → positive → bit 0 of the fingerprint is 1
```

`pos 1` does the same with the *second* bit of each hash, `pos 2` with the third, and so on through all 64.

### Step 4 — Read off the fingerprint

Positive sum → `1`, otherwise → `0`:

```
bits 0-7:  1 1 0 0 1 0 1 1  =  0xcb
full:      cb642c411b98260b
```

**This is why SimHash is stable.** In a real book, each bit position is decided by hundreds of thousands of votes. Changing a few words shifts a few sums by ±1 — nowhere near enough to flip most of them. Only positions where the vote was already nearly tied can change.

---

## 4. Comparing two fingerprints

`hammingDistance()` XORs the two values and counts the 1 bits — the number of positions where they disagree.

| Distance | Meaning |
|---|---|
| 0 | Identical text |
| 1–3 | **Near-duplicate** → flagged |
| 4–10 | Related but distinct |
| ~32 | Unrelated (two random 64-bit values average 32) |

> ⚠️ **`similarityScore()` reads misleadingly.** It's a linear map of distance to a percentage, so unrelated documents score **~50%**, not 0%. 50% means "no relationship," not "half the same." Don't surface that number raw in a librarian UI.

---

## 5. The scaling problem, and banded LSH

Comparing a new fingerprint against every stored one is `O(n)` — every upload gets slower as the library grows. Worse, it means pulling every row out of Postgres and into Node's memory.

**The fix: split the 64 bits into 4 bands of 16 bits and index each one separately.**

```
afc42d4f4c1045fb
├──┼──┼──┼──┤
afc4 2d4f 4c10 45fb      ← 4 hex chars each
  ↓    ↓    ↓    ↓
44996 11599 19472 17915   ← stored in simHashBand0..3, each with its own index
```

### ⚠️ A band is a slice of the *number*, not a slice of the *book*

This trips people up, so it's worth stating plainly. Bands have nothing to do with chapters, pages, or paragraphs. By the time banding happens, the text is already gone:

```
Moby Dick — ~210,000 words
        ↓  tokenize
~210,000 tokens
        ↓  hash each token, vote at all 64 positions
        ↓  ← the ENTIRE book collapses into ONE 64-bit number here
afc42d4f4c1045fb        ← 16 hex characters; this is the whole book
        ↓  splitBands()  ← operates on this string, never on text
afc4  2d4f  4c10  45fb
```

`splitBands()` takes the 16-character fingerprint as its argument. It never sees a word of the book.

**Band 0 is not the first quarter of the book.** Every one of the 64 bits was decided by a vote among *all* the tokens in the *entire* document, so band 0 carries influence from the last page just as much as the first. All four bands describe the whole book — they're just different slices of the same summary number. Paragraph and chapter structure were destroyed back in Step 3, which is exactly why SimHash is order-blind (see *Known limitations*).

**So why split it at all?** Purely a database indexing trick. Postgres can answer `WHERE simHashBand0 = 44996` instantly with a B-tree index. It has no index that can answer *"find rows within Hamming distance 3."* Banding converts one fuzzy question into four exact ones:

> ~~"Which rows are within 3 bits of `afc42d4f4c1045fb`?"~~ — no index can do this
>
> "Which rows have `band0 = 44996` OR `band1 = 11599` OR `band2 = 19472` OR `band3 = 17915`?" — four index lookups

The pigeonhole guarantee below is what makes that substitution safe.

> **Related but different:** fingerprinting *per chapter or per chunk* and comparing sets of fingerprints is how you'd detect **partial** overlap — "chapters 4–7 here are lifted from that book." That's a legitimate technique, but a separate feature needing its own schema (many fingerprints per upload, not one). What's built here only answers whether two documents are similar *as wholes*.

### Why this is safe — the pigeonhole principle

Here are the actual bits of our two *Moby Dick* versions, grouped by band:

```
A: 1010111111000100 | 0010110101001111 | 0100110000010000 | 0100010111111011
B: 1010111111000100 | 0010110101101111 | 0100110000000000 | 0100010111111001
                    |           ^      |            ^     |               ^
      band0         |    band1         |    band2         |    band3
   IDENTICAL             1 bit moved       1 bit moved        1 bit moved
```

Three bits changed. They scattered into bands 1, 2, and 3 — **one each**. Band 0 came through completely untouched.

That isn't luck. **You cannot disturb 4 bands using only 3 bits.** Worst case they land in three different bands, and one band always survives intact. So:

> **Any two fingerprints within Hamming distance 3 are mathematically guaranteed to share at least one identical band.**

This makes the band lookup a **lossless** prefilter — 100% recall, not a probabilistic approximation. Nothing is traded away for the speed.

### The hard edge

With 4 bands the guarantee covers distance ≤ **3** (`MAX_GUARANTEED_DISTANCE = BAND_COUNT - 1`). At distance 4, one bit *can* land in each band and defeat the prefilter entirely.

That's why `dedup.service.js` checks:

```js
const USE_BAND_PREFILTER = NEAR_DUPLICATE_THRESHOLD <= MAX_GUARANTEED_DISTANCE;
```

If someone sets `SIMHASH_THRESHOLD=5`, the code **falls back to a full table scan** and logs a warning at startup — slower, but still correct. It never silently misses matches.

### Measured impact (20,000-row table)

| | Full scan (old) | Banded LSH (now) |
|---|---|---|
| Rows loaded into Node | 20,000 | **3** |
| Distance computations | 20,000 | **3** |
| Time | 259 ms | **0.07 ms** |

Postgres plan confirms all four indexes are used:

```
Bitmap Heap Scan on "Upload"
  └─ BitmapOr
       ├─ Bitmap Index Scan on "Upload_simHashBand0_idx"
       ├─ Bitmap Index Scan on "Upload_simHashBand1_idx"
       ├─ Bitmap Index Scan on "Upload_simHashBand2_idx"
       └─ Bitmap Index Scan on "Upload_simHashBand3_idx"
```

---

## 6. End-to-end flow

### Alice uploads *Moby Dick* to an empty library

```
POST /api/upload
   ↓
Layer 1 (validation.service.js) ── extracts PDF text ──┐
   ↓                                                    │
Layer 2 security scan — passes                          │
   ↓                                                    │
Layer 3: validateLayer3(file.buffer, layer1.text) ◄─────┘
```

Note the **two different inputs** — this distinction is the whole point of the layer:

| Input | Used for |
|---|---|
| `file.buffer` (raw bytes) | SHA-256 → exact duplicates |
| `layer1.text` (extracted words) | SimHash → near duplicates |

Inside `validateLayer3`:

```
1. computeSha256(buffer)        → debbcdd04f9d3b23...
2. computeSimHash(text)         → afc42d4f4c1045fb
3. simHashBandFields(simHash)   → { simHashBand0: 44996, simHashBand1: 11599,
                                    simHashBand2: 19472, simHashBand3: 17915 }
4. checkExactDuplicate(sha256)  → library empty, pass
5. checkNearDuplicate(simHash)  → 0 candidates
```

Alice's row then gets stored with the fingerprint **and its four band columns**.

> ⚠️ **Not yet wired.** Persistence lands in Phase 5, so today `simHashBands` is computed and returned up the chain but nothing writes it to Postgres. The rest of this walkthrough assumes Phase 5 has shipped.
>
> When it does: any code that writes `simHash` **must** also write the band columns, or the row is invisible to the prefilter — silently un-dedupable rather than erroring. `validateLayer3` returns `simHashBands` pre-keyed for Prisma:
> ```js
> await prisma.upload.create({ data: { ...rest, simHash, ...result.simHashBands } });
> ```

### Bob uploads a re-scanned copy

Bob has the same book from a different scan, with two OCR typos.

**Stage 0 — SHA-256 does nothing.** Different bytes, unrelated hash, exact check passes him straight through. This is the gap SimHash exists to close.

**Stage 1 — Band prefilter.** `checkNearDuplicate` builds:

```sql
WHERE simHash <> '0000000000000000'
  AND (simHashBand0 = 44996 OR simHashBand1 = 11631
    OR simHashBand2 = 19456 OR simHashBand3 = 17913)
```

Alice's row matches on `band0`. Retrieved — along with anything else sharing any band.

**Stage 2 — Exact verification.** A shared band alone means little; the prefilter is deliberately loose. So the true distance is computed on each candidate:

```js
const distance = hammingDistance(simHash, upload.simHash);   // → 3
if (distance <= NEAR_DUPLICATE_THRESHOLD) { /* 3 <= 3 ✓ */ }
```

**Result:**

```json
{
  "isNearDuplicate": true,
  "nearDuplicateMatches": [
    { "title": "Moby Dick", "distance": 3, "similarity": 95.3125 }
  ]
}
```

**Bob is NOT rejected.** Near-duplicate is a **soft flag** for librarian review — different editions, translations, and annotated versions are legitimately similar. Only SHA-256 hard-rejects.

### Why stage 2 isn't optional

Take a third variant — same typos, plus a scanner footer `"Scanned by the Internet Archive."`:

```
simHash:  afc42d6f4c0805f9
band0  =  44996   ← still matches Alice
distance = 5      ← but 5 > 3
```

It **is** returned by the prefilter, then **correctly dropped** by exact verification. Trusting the band match alone would produce a false positive here.

---

## 7. Configuration

| Setting | Where | Default | Notes |
|---|---|---|---|
| `SIMHASH_THRESHOLD` | env | `3` | Max distance to flag. Above 3 disables the prefilter (full scan + warning). |
| `BAND_COUNT` | `simhash.service.js` | `4` | Changing it requires matching columns in `schema.prisma`. |
| `BAND_BITS` | derived | `16` | `HASH_BITS / BAND_COUNT` |
| `MAX_GUARANTEED_DISTANCE` | derived | `3` | `BAND_COUNT - 1` |

Raising the threshold makes detection more aggressive but costs the index optimization. Raising `BAND_COUNT` to 8 would guarantee up to distance 7 — at the price of 8 index columns and a much looser prefilter pulling far more candidates.

---

## 8. Known limitations

Honest list. None of these are bugs in the LSH layer — they're properties of the fingerprint itself.

1. **Stopwords dominate.** `tokenize` drops only 1-character tokens and applies no IDF weighting. In a full-length book, `the`/`of`/`and` contribute thousands of votes each. Two unrelated English books share stopword distribution, which compresses the distance between genuinely different documents. A stopword list or TF-IDF weighting would sharpen this considerably.

2. **Unigrams are order-blind.** Bag-of-words means a shuffled book produces the same fingerprint. Usually fine for dedup, but shingles (bigrams/trigrams) would discriminate better between books in the same genre.

3. **Scanned PDFs get no protection.** Image-only scans extract no text → `computeSimHash('')` returns all zeros → `checkNearDuplicate` short-circuits. Since public-domain books are overwhelmingly scans, this gap is significant and closes only when Layer 4's OCR feeds text back in.

4. **Threshold 3 is tight.** Adding a single sentence to a book moved the distance from 3 to 5 — out of flag range. Real-world tuning may want a higher threshold, which trades away the index optimization.

5. **It blocks the event loop on large books.** Measured: 300 pages → 655 ms, 1000 pages → 2.3 s, **3000 pages → 6.5 s** of synchronous BigInt work. See *Revisit at the End* in `CHECKLIST.md`.

---

## 9. Function reference

**`services/simhash.service.js`** — pure functions, no I/O

| Function | Purpose |
|---|---|
| `tokenize(text)` | Text → normalized word array |
| `hash64(str)` | String → 64-bit BigInt (MD5 first 8 bytes) |
| `computeSimHash(text)` | Text → 16-char hex fingerprint |
| `splitBands(hash)` | Fingerprint → `[b0, b1, b2, b3]` integers |
| `hammingDistance(a, b)` | Fingerprints → bits differing (0–64) |
| `similarityScore(a, b)` | Fingerprints → percentage (baseline ~50%) |
| `parseHash64(hash)` | Validates + parses; **throws** on malformed input |

**`services/dedup.service.js`** — Layer 3, database-facing

| Function | Purpose |
|---|---|
| `computeSha256(buffer)` | Raw bytes → hex hash |
| `checkExactDuplicate(sha256)` | Unique lookup → 409 on hit |
| `checkNearDuplicate(simHash)` | Two-stage banded lookup + verification |
| `simHashBandFields(simHash)` | → `{ simHashBand0..3 }` for Prisma writes |
| `bandMatchClauses(simHash)` | → Prisma `OR` array for the prefilter |
| `validateLayer3(buffer, text)` | Runs the whole layer |

---

## In one sentence

> **SHA-256 asks "are these the same file?" — SimHash asks "are these the same book?" — and banded LSH is what makes the second question answerable without reading every book in the library.**
