# Alexandria Backend — Build Checklist

Living checklist for the Node.js backend gateway. Phases run cheapest → most infra-dependent, so each is independently testable without waiting on external services. See `CLAUDE.md` for full architecture.

## Locked Decisions
- **Database:** Prisma + Postgres (Neon) — NOT MongoDB/Mongoose.
- **Encryption:** Two-layer envelope encryption: backend encrypts validated PDFs using **local AES-256-GCM**, then encrypts the 32-byte symmetric key via **Lit Protocol Chipotle v3 REST API** (PKP encryption in TEE via Lit Actions). Access control gating is enforced at decryption time via Lit Actions. Backend is never in the decryption path.
- **Encryption stays backend-side for the PoC** — the validation pipeline needs plaintext. Browser-side encryption is a later phase (needs decentralized validation first).
- ~~**Open question (Phase 5):** access condition references `arweaveHash`, but we encrypt before Irys mints it.~~ **Resolved in Phase 5** — the key is sealed as an envelope bound to the hash, and the hash is derived from the locally-signed Irys data item before any upload. See Phase 5.

---

## ✅ Done
- [x] Express server + `/` and `/api/health` (`index.js`)
- [x] CORS enabled
- [x] Prisma + Postgres wired: `config/db.js` (client singleton), `prisma/schema.prisma` (`Upload`, `Event` models), migrations
- [x] CLAUDE.md reconciled to Prisma + Lit SDK reality
- [x] Empty stubs present: `controller/arweave.js`, `controller/litProtocol.js`
- [x] Phase 3 complete: Lit Protocol Chipotle v3 REST API migration + two-layer AES+PKP envelope encryption (`tests/encryption.manual.js` PASSED ✓)
- [x] Phase 4 complete: Layer 2 security scanning (structural PDF exploit detection + ClamAV) + Layer 3 deduplication (SHA-256 + 64-bit SimHash) — `securityAndDedup.test.js` 25/25 PASSED ✓

---

## Phase 0 — Housekeeping
- [x] Move or `.gitignore` `challange.js` (unrelated practice code) — moved to `sandbox/` (gitignored)
- [x] Add `dotenv` + load it at the top of `index.js`
- [x] Add `helmet` for security headers
- [x] Create `.env.example` with all vars (PORT, DATABASE_URL, blockchain RPC + contract addresses, IRYS_NODE_URL, IRYS_WALLET_KEY, LIT_NETWORK, VALIDATION_SERVICE_URL, MAX_FILE_SIZE_MB)
- [x] Wire `config/db.js` into startup (connect + graceful shutdown)
- [x] Add a `.gitignore` if missing (node_modules, .env)
- [x] Untrack previously-committed `node_modules/`, `.env`, `.neon` (`git rm --cached`)
  - ⚠️ `.env` (real Neon DB password) is in git history — **rotate that Neon credential**

## Phase 1 — Upload endpoint skeleton *(no external services)*
- [x] `middleware/upload.middleware.js` — multer in-memory storage + size cap (`MAX_FILE_SIZE_MB`)
- [x] `routes/upload.routes.js` — define `POST /api/upload`, `GET /api/upload/:arweaveHash`
- [x] `controller/upload.controller.js` — orchestration entry point (stub validation result initially)
- [x] Mount router in `index.js` under `/api`
- [x] `middleware/error.middleware.js` — global error handler (+ `notFound` 404; translates multer `LIMIT_FILE_SIZE` → 413)
- [x] **Test:** POST reaches controller (202); no-file → 400; oversized → 413; GET stub → 501; unknown route → 404

## Phase 2 — Layer 1 + Layer 5 validation *(no external services)*
- [x] `services/validation.service.js` scaffold + standard reject shape `{ valid, stage, reason, message }` (+ internal `httpStatus`)
- [x] Layer 1: file size, extension `.pdf`, MIME type
- [x] Layer 1: magic bytes via `file-type` (v21, ESM — loaded via dynamic `import()`)
- [x] Layer 1: parseability + page count > 0 via `pdf-parse` (v2 `PDFParse` class; also catches encrypted PDFs early)
- [x] Layer 5: metadata required-field checks (title, author, category from allowlist, description length)
- [x] Layer 5: sanitize all text fields via `sanitize-html` (strip HTML + control chars, collapse whitespace)
- [x] `middleware/auth.middleware.js` — wallet address format check (runs after multer; normalizes to lowercase)
- [x] **Test:** 13/13 service cases pass — valid PDF passes; renamed exe/png, corrupted PDF, empty file, wrong ext/mime, missing/bad metadata all rejected with correct stage/reason; wallet + full flow verified via server

## Phase 3 — Encryption *(pure crypto / Lit SDK)*
- [x] ~~Install `@lit-protocol/lit-node-client`, `@lit-protocol/constants` — pinned to 7.4.0 (Datil line)~~ **REMOVED** — Datil network shut down Feb 2026. Migrated to **Lit Chipotle v3 REST API** (no SDK, direct HTTP calls to `api.chipotle.litprotocol.com`).
- [x] `config/lit.js` — Stateless REST API client for Lit Chipotle v3. Uses `fetch()` + `X-Api-Key` header. No connection lifecycle needed.
- [x] `controller/litProtocol.js` — Two-layer envelope encryption: AES-256-GCM locally for the PDF + Lit PKP encryption for the symmetric key via `POST /core/v1/lit_action`. Returns `{ encryptedPdf, iv, authTag, encryptedSymmetricKey, dataToEncryptHash }`.
- [x] **Test:** Run `node tests/encryption.manual.js` — verified AES-256-GCM roundtrip locally + Lit PKP encryption via Chipotle v3 REST API (RESULT: OK ✓).

## Phase 4 — Layer 2 Security Scanning + Layer 3 Deduplication *(In-Process & DB)*
- [x] Layer 2: Structural security scan — detect embedded scripts (`/JS`, `/JavaScript`), auto-actions (`/OpenAction`, `/AA`), and process execution (`/Launch`) → reject `stage: "security_scan"`
- [x] Layer 2: Structural security scan — detect hidden attachments (`/EmbeddedFiles`, `/EF`), form submission (`/SubmitForm`), and password-protected (`/Encrypt`) PDFs → reject `stage: "security_scan"`
- [x] Layer 2: ClamAV virus scan integration (daemon connection with graceful `ECONNREFUSED` fallback in dev)
- [x] Layer 3: SHA-256 exact-duplicate check against `Upload.sha256Hash` → reject 409 Conflict
- [x] Layer 3: 64-bit SimHash near-duplicate fingerprinting (Hamming distance ≤ 3 = near-dup flag)
- [x] Layer 3: Banded LSH prefilter — `simHash` split into 4 indexed 16-bit columns (`simHashBand0..3`); near-dup lookup matches "any band equal" instead of scanning every row. Lossless for distance ≤ 3 by the pigeonhole principle; `SIMHASH_THRESHOLD > 3` falls back to a full scan with a startup warning.
- [x] **Test:** `securityAndDedup.test.js` — 39/39 passed ✓ (structural scan, ClamAV fallback, SHA-256, SimHash distance, band split, 5000-trial pigeonhole recall, malformed-hash rejection)
- [x] **Verified at scale:** 20k-row seeded table → planner uses `BitmapOr` over all four band indexes; 3 candidates instead of 20,000 (99.98% reduction), 0.07ms vs 259ms for the old full scan.
- [x] **Docs:** `SIMHASH.md` — full explainer (algorithm walkthrough, pigeonhole guarantee, end-to-end flow, tuning, known limitations)

## Phase 5 — External integrations *(need infra/keys)*
- [x] `config/irys.js` — Irys client via `@irys/upload` + `@irys/upload-ethereum` (`@irys/sdk` is deprecated/EOL). Memoized async builder, devnet by default, `getBalance()`/`getPrice()` helpers.
- [x] `controller/arweave.js` — `prepareUpload` (sign locally → `arweaveHash`), `commitUpload` (push + receipt-id assertion), `fetchEncrypted`, `buildTags`
  - ⚠️ First point where file size costs real treasury money (permanent, prepaid, no delete). AES-GCM ciphertext ≈ plaintext size, so the `MAX_FILE_SIZE_MB` cap is a direct spending cap — see *Revisit at the End*.
  - **On devnet for now** (`IRYS_NETWORK=devnet`) — free testnet tokens, ~60-day retention. Flip to `mainnet` only once the flow is proven.
  - ⚠️ **Irys id encoding trap:** `@irys/bundles` exposes `DataItem.id` as base58 (44 chars); gateways and receipts use base64url (43). Its own getter/setter disagree (`get id` → base58, `set id` → base64url). `transactionId()` derives base64url from `tx.rawId`; never use `tx.id`.
- [x] Resolve `arweaveHash`-before-encrypt ordering (see Open Question) — **resolved**, see below
- [x] Persist full `Upload` row to Postgres (`status: "pending_stake"`) — spreads `result.simHashBands` into the Prisma `create` payload alongside `simHash`
- [x] Discard raw PDF from memory (`req.file.buffer.fill(0)` right after AES); return `{ arweaveHash, litEncryptedKeyId }`
- [x] **Test:** `uploadFlow.test.js` — 36/36 passed ✓ (happy path, band columns, AES roundtrip via the sealed envelope, hash binding, base64url encoding, Lit/Irys/Postgres failure paths, orphan logging, 409 dedup with zero spend, near-dup flag)
- [x] **Regressions:** `encryption.manual.js` PASS ✓ against the live Lit API · `securityAndDedup.test.js` 39/39 ✓
- [ ] **Live devnet smoke test — BLOCKED:** needs `IRYS_WALLET_KEY`. Create a devnet wallet, fund it from an Irys faucet, then run a real upload and confirm at `gateway.irys.xyz/<id>`.
- [ ] Layer 4: AI content analysis via `VALIDATION_SERVICE_URL` — **deferred to the end.** `Alex-AI-Validator` is docs-only (no Python written), and may end up run by a third party. Insertion point is one call in `validateUpload`, placed *after* Layer 5 so the free local checks fail first.

### Open Question — RESOLVED
The Chipotle migration removed access conditions from encrypt time, so encryption no longer needs the txid. But that exposed a real gap: **nothing bound the sealed key to the book it unlocks.** With `arweaveHash` passed as a caller-supplied `js_param`, a reader could rent one cheap book and submit that hash alongside a *different* book's ciphertext — the TEE couldn't tell.

Fixed by sealing an envelope `{ v, k, arweaveHash }` instead of a bare key, so the decryption Lit Action reads the hash from inside the ciphertext. The hash is available before spending because **an Irys data item's id is `sha256(signature)`** — sign locally (free, offline), read the id, seal, *then* push. No placeholder or reserved txid needed.

Pipeline order is deliberate: `validate → AES → sign → seal → push → persist`. Everything that can fail cheaply fails before the paid, irreversible step. Reversed, a Lit failure would strand permanently paid-for bytes nobody could ever decrypt.

> ### ⚠️ Carry-over: the binding is only half-built
> Sealing the hash into the envelope is the **encrypt** half. The **decrypt** half does not exist yet, and the guarantee is worthless without it:
>
> **The decryption Lit Action MUST read `arweaveHash` from the decrypted envelope and gate on that value.** If it instead trusts an `arweaveHash` passed in as a `js_param`, the hole is fully reopened — rent one cheap book, submit that hash with a different book's ciphertext, and the TEE hands over the wrong key. Everything done in Phase 5 becomes decorative.
>
> ```js
> // In the decryption Lit Action (Phase 5+ / frontend):
> const { k, arweaveHash } = JSON.parse(decryptedEnvelope);  // ← from the ciphertext
> const ok = await Rent.isRentalActive(arweaveHash, userAddress);  // ← NOT a js_param
> if (!ok) return;  // fail closed
> ```
>
> Whoever writes that Action needs this constraint. It is not enforceable from the backend — the backend is deliberately not in the decryption path.
>
> 📄 **Full write-up: [`KEY-BINDING.md`](KEY-BINDING.md)** — the exploit, a runnable demo (`node tests/keyBinding.demo.js`), mitigations, rejected alternatives, and a reviewer checklist. Hand this to the Action author.

## Phase 6 — Read paths + event listener
- [ ] `GET /api/upload/:arweaveHash` — metadata lookup
- [ ] `routes/search.routes.js` + `controller/search.controller.js` — `GET /api/search?q=&category=&page=`
- [ ] `routes/rental.routes.js` — `GET /api/rental/status/:hash/:address` (on-chain read)
- [ ] `routes/stake.routes.js` — `GET /api/stake/status/:hash` (on-chain read)
- [ ] `config/blockchain.js` — ethers read-only provider + contract instances (no signer)
- [ ] `services/blockchain.service.js` — read-only status queries
- [ ] `services/eventListener.service.js` — listen to on-chain events, sync to `Event` table + update `Upload.status`
- [ ] **Test:** event sync updates Postgres; status endpoints return live on-chain state

## Cross-cutting
- [ ] Jest set up; replace placeholder `test` script
- [ ] Rejection logging (reason, uploader, timestamp) for abuse detection
- [ ] Lint config (optional)
- [ ] Contract ABIs + deployed addresses imported from `AlexandriaSmartContract`
- [ ] Irys wallet balance monitoring / low-balance alert

---

## 🔍 Revisit at the End — Upload Sizing & Throughput
Nothing here blocks Phases 5–6, but all of it should be settled before real archivists upload real books. Measurements below were taken 2026-08-06; keep them for reference so the decision isn't re-litigated from scratch.

**Why `memoryStorage` (context for every item below):** multer holds the raw PDF in RAM because CLAUDE.md forbids unencrypted PDFs on disk — RAM cleanup is enforced by the OS, disk cleanup is best-effort code that a crash can skip, and `unlink()` isn't erasure. This is a **security** choice, not a performance one (disk I/O would be <1% of request time). The cost is that max file size is bounded by **RAM × concurrency**, not by storage.

- [ ] **Raise `MAX_FILE_SIZE_MB` (currently 50, and *unset* in `.env` — running on the `|| 50` default).** Candidate value: **150**.
  - 3000-page *text* PDF ≈ 9–45 MB → fits 50 MB, but with almost no headroom
  - 3000-page *scan* ≈ 150–300 MB (Internet Archive-quality, ~50–100 KB/page) → **does not fit**; color/archival scans reach 0.75–9 GB
  - Since Alexandria targets at-risk and public-domain works (overwhelmingly scans), 50 MB rejects a meaningful share of legitimate uploads
  - Note the cap is **MiB** (`* 1024 * 1024`), so 50 → 52,428,800 bytes
- [ ] **Fix the SimHash event-loop block — needed regardless of where the size cap lands.** Scales with *page count*, not file size, so it already bites at the current 50 MB cap.
  - Measured: 300 pages → 655 ms · 1000 pages → 2.3 s · **3000 pages → 6.5 s of fully blocking synchronous BigInt work** (every other request stalls)
  - Fix A (cheap, high value): cap the text fed to `computeSimHash` at ~200k tokens — bounds cost regardless of book length; a fingerprint from the first ~400 pages is plenty discriminative for dedup
  - Fix B: rewrite the 64-bit BigInt loop as two 32-bit halves (~10× faster). A + B together → <100 ms
- [ ] **Add an upload concurrency limit.** Peak RAM is ~2.5–3× file size per in-flight upload (multer buffer + the `Buffer.concat` copy during AES-GCM). At 150 MB that's ~450 MB each; at 500 MB, three concurrent uploads OOM a default Node heap. A queue converts an unbounded crash risk into bounded latency.
- [ ] **Benchmark `pdf-parse` on a real 3000-page PDF — not yet measured.** Estimated 10–60 s of mostly-blocking extraction, which would dominate everything above and may be the true ceiling on book size.
- [ ] Duplicate constant: `MAX_FILE_SIZE_MB`/`_BYTES` is defined twice (`middleware/upload.middleware.js:4` and `services/validation.service.js:18`). Same env var so they agree in practice, but neither imports the other. `validateLayer1`'s size check is unreachable via HTTP (multer aborts first) — it's a backstop for direct calls/tests.
- [ ] Cosmetic: `middleware/error.middleware.js:19` interpolates raw `process.env.MAX_FILE_SIZE_MB` instead of the parsed constant, so a non-numeric value would report a wrong limit in the 413 message while the real cap falls back to 50.
- [ ] Export `TITLE_MAX` / `AUTHOR_MAX` / `DESCRIPTION_MIN` / `DESCRIPTION_MAX` from `validation.service.js` so the frontend can size its inputs and show character counters instead of hardcoding 300/200/10/2000. (Also unenforced at the DB layer — Prisma `String` → Postgres `TEXT` is unbounded.)

> **The real escape hatch for large scans is Deferred Phase 1** (archivist-funded storage — frontend uploads directly to Irys). That removes the bytes from this server entirely, so neither RAM nor the no-plaintext-on-disk rule constrains file size. Don't rebuild the in-memory upload path twice chasing 500 MB archival scans.

---

## Deferred (post-PoC — Decentralization Roadmap)
- [ ] Phase 1: archivist-funded storage (frontend uploads to Irys, remove `IRYS_WALLET_KEY`)
- [ ] Phase 2: decentralized indexing via The Graph (MongoDB/Postgres → subgraph)
- [ ] Phase 3: distributed validation (multi-node consensus)
- [ ] Phase 4: fully client-side upload + browser encryption (backend optional)
