# Alexandria Backend — Build Checklist

Living checklist for the Node.js backend gateway. Phases run cheapest → most infra-dependent, so each is independently testable without waiting on external services. See `CLAUDE.md` for full architecture.

## Locked Decisions
- **Database:** Prisma + Postgres (Neon) — NOT MongoDB/Mongoose.
- **Encryption:** Two-layer envelope encryption: backend encrypts validated PDFs using **local AES-256-GCM**, then encrypts the 32-byte symmetric key via **Lit Protocol Chipotle v3 REST API** (PKP encryption in TEE via Lit Actions). Access control gating is enforced at decryption time via Lit Actions. Backend is never in the decryption path.
- **Encryption stays backend-side for the PoC** — the validation pipeline needs plaintext. Browser-side encryption is a later phase (needs decentralized validation first).
- **Open question (Phase 5):** access condition references `arweaveHash`, but we encrypt before Irys mints it. Reserve/derive txid first, or bind a placeholder and finalize on upload.

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

## Phase 5 — External integrations *(need infra/keys)*
- [ ] `config/irys.js` — Irys client (`IRYS_WALLET_KEY`, `IRYS_NODE_URL`)
- [ ] `controller/arweave.js` — upload encrypted payload → `arweaveHash`; fetch helper
- [ ] Resolve `arweaveHash`-before-encrypt ordering (see Open Question)
- [ ] Layer 4: AI content analysis via `axios` POST to `VALIDATION_SERVICE_URL` (OCR, quality) — needs Python service
- [ ] Persist full `Upload` row to Postgres (`status: "pending_stake"`) — **must** spread `result.simHashBands` into the Prisma `create` payload alongside `simHash`, or the row stays invisible to the banded-LSH near-dup prefilter
- [ ] Discard raw PDF from memory; return `{ arweaveHash, litEncryptedKeyId }`
- [ ] **Test:** full upload flow with mocked Irys/Lit/AI

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

## Deferred (post-PoC — Decentralization Roadmap)
- [ ] Phase 1: archivist-funded storage (frontend uploads to Irys, remove `IRYS_WALLET_KEY`)
- [ ] Phase 2: decentralized indexing via The Graph (MongoDB/Postgres → subgraph)
- [ ] Phase 3: distributed validation (multi-node consensus)
- [ ] Phase 4: fully client-side upload + browser encryption (backend optional)
