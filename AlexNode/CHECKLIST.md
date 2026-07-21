# Alexandria Backend — Build Checklist

Living checklist for the Node.js backend gateway. Phases run cheapest → most infra-dependent, so each is independently testable without waiting on external services. See `CLAUDE.md` for full architecture.

## Locked Decisions
- **Database:** Prisma + Postgres (Neon) — NOT MongoDB/Mongoose.
- **Encryption:** Backend encrypts validated PDFs via the **Lit SDK `encryptFile`** (current API), not hand-rolled AES. Access control tied to `Rent.sol.isRentalActive`. Backend never in the decryption path.
- **Encryption stays backend-side for the PoC** — the validation pipeline needs plaintext. Browser-side encryption is a later phase (needs decentralized validation first).
- **Open question (Phase 5):** access condition references `arweaveHash`, but we encrypt before Irys mints it. Reserve/derive txid first, or bind a placeholder and finalize on upload.

---

## ✅ Done
- [x] Express server + `/` and `/api/health` (`index.js`)
- [x] CORS enabled
- [x] Prisma + Postgres wired: `config/db.js` (client singleton), `prisma/schema.prisma` (`Upload`, `Event` models), migrations
- [x] CLAUDE.md reconciled to Prisma + Lit SDK reality
- [x] Empty stubs present: `controller/arweave.js`, `controller/litProtocol.js`

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
- [ ] `middleware/upload.middleware.js` — multer in-memory storage + size cap (`MAX_FILE_SIZE_MB`)
- [ ] `routes/upload.routes.js` — define `POST /api/upload`, `GET /api/upload/:arweaveHash`
- [ ] `controller/upload.controller.js` — orchestration entry point (stub validation result initially)
- [ ] Mount router in `index.js` under `/api`
- [ ] `middleware/error.middleware.js` — global error handler
- [ ] **Test:** POST a file end-to-end, confirm it reaches the controller

## Phase 2 — Layer 1 + Layer 5 validation *(no external services)*
- [ ] `services/validation.service.js` scaffold + standard reject shape `{ valid, stage, reason, message }`
- [ ] Layer 1: file size, extension `.pdf`, MIME type
- [ ] Layer 1: magic bytes `%PDF-` via `file-type`
- [ ] Layer 1: parseability + page count > 0 via `pdf-parse`
- [ ] Layer 5: metadata required-field checks (title, author, category from allowlist, description length)
- [ ] Layer 5: sanitize all text fields via `sanitize-html`
- [ ] `middleware/auth.middleware.js` — wallet address format check (not signature)
- [ ] **Test:** valid PDF passes; renamed exe, empty PDF, missing metadata all rejected with correct stage/reason

## Phase 3 — Encryption *(pure crypto / Lit SDK)*
- [ ] Install `@lit-protocol/lit-node-client`, `@lit-protocol/constants`
- [ ] `config/lit.js` — Lit node client setup (network from `LIT_NETWORK`)
- [ ] `controller/litProtocol.js` (or `services/lit.service.js`) — `encryptFile` with `isRentalActive` access condition → returns `{ ciphertext, dataToEncryptHash }`
- [ ] **Test:** encrypt a sample buffer, confirm ciphertext + hash returned (decryption path tested later with frontend/Rent.sol)

## Phase 4 — Layer 3 deduplication *(uses DB only)*
- [ ] SHA-256 exact-duplicate check against `Upload.sha256Hash` → reject 409
- [ ] SimHash near-duplicate fingerprint via `simhash-js` → flag for review over threshold
- [ ] **Test:** re-uploading same file → 409; near-dup flagged

## Phase 5 — External integrations *(need infra/keys)*
- [ ] `config/irys.js` — Irys client (`IRYS_WALLET_KEY`, `IRYS_NODE_URL`)
- [ ] `controller/arweave.js` — upload encrypted payload → `arweaveHash`; fetch helper
- [ ] Resolve `arweaveHash`-before-encrypt ordering (see Open Question)
- [ ] Layer 2: ClamAV virus scan (`clamscan`) — needs the daemon
- [ ] Layer 2: embedded JS / attachment / auto-action (`/OpenAction`, `/AA`, `/Launch`) detection → strip or reject
- [ ] Layer 2: encrypted/password-protected PDF detection → reject
- [ ] Layer 4: AI content analysis via `axios` POST to `VALIDATION_SERVICE_URL` (OCR, quality) — needs Python service
- [ ] Persist full `Upload` row to Postgres (`status: "pending_stake"`)
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
