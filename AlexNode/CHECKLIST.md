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
- [x] Phase 6a complete: Postgres read paths — `GET /api/upload/:hash` + `GET /api/search` (`readPaths.test.js` 45/45 PASSED ✓)
- [x] Phase 4 complete: Layer 2 security scanning (structural PDF exploit detection + ClamAV) + Layer 3 deduplication (SHA-256 + 64-bit SimHash) — `securityAndDedup.test.js` 25/25 PASSED ✓
- [x] Phase 6b complete: on-chain read paths + event listener against live Base Sepolia contracts (`chainReads.test.js` 74/74 PASSED ✓) — see the open `registerUpload` authorization decision below

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
  - ⚠️ **`IRYS_TOKEN` must match the chain `IRYS_RPC_URL` points at.** Irys treats `base-eth` and `ethereum` as separate tokens with separate ledgers, but they share a deposit address — so a mismatch fails in the worst possible way. Configured as `Ethereum` while pointing at Base Sepolia, `fund()` sent 0.005 ETH to Irys **on Base Sepolia**, Irys looked for that tx **on Ethereum Sepolia**, and rejected it with `400 Tx doesn't exist`. Transfer mined, irreversible, credit never issued.
  - Recovered **only** because the deposit address is shared, so resubmitting the same tx hash under `base-eth` found it. Do not rely on that. Now defaults to `base-eth` with a validated allowlist.
  - ⚠️ `IRYS_WALLET_KEY` is validated before use: an **address** pasted where the key goes (42 chars vs 66) is rejected by name, and `IRYS_WALLET_ADDRESS` — when set — is asserted against the derived address, so the wrong Rabby account fails at startup instead of as a confusing balance error on the first upload.
- [x] `controller/arweave.js` — `prepareUpload` (sign locally → `arweaveHash`), `commitUpload` (push + receipt-id assertion), `fetchEncrypted`, `buildTags`
  - ⚠️ First point where file size costs real treasury money (permanent, prepaid, no delete). AES-GCM ciphertext ≈ plaintext size, so the `MAX_FILE_SIZE_MB` cap is a direct spending cap — see *Revisit at the End*.
  - **On devnet for now** (`IRYS_NETWORK=devnet`) — free testnet tokens, ~60-day retention, and **devnet never reaches Arweave**. Flip to `mainnet` only once the flow is proven.
  - ⚠️ **Before flipping to mainnet**, re-check the storage provider. Irys has launched its own L1 datachain and **deprecated the Arweave bundlers we use** — still operating, but "no longer actively supported." Decision (2026-08-25) is to stay on Arweave: permanence is Alexandria's product, Arweave is a multi-miner protocol rather than one company's chain, and if Irys vanishes we lose an on-ramp rather than the books. Mainnet is the point of no return, so confirm the bundlers still run and price **ArDrive Turbo** as the fallback. Data items are ANS-104 and ids are `sha256(signature)`, so swapping bundlers is a `config/irys.js` change that touches no stored data. Full reasoning + sources: **[`ARWEAVE-IRYS.md`](ARWEAVE-IRYS.md)**.
  - ⚠️ **Irys id encoding trap:** `@irys/bundles` exposes `DataItem.id` as base58 (44 chars); gateways and receipts use base64url (43). Its own getter/setter disagree (`get id` → base58, `set id` → base64url). `transactionId()` derives base64url from `tx.rawId`; never use `tx.id`.
- [x] Resolve `arweaveHash`-before-encrypt ordering (see Open Question) — **resolved**, see below
- [x] Persist full `Upload` row to Postgres (`status: "pending_stake"`) — spreads `result.simHashBands` into the Prisma `create` payload alongside `simHash`
- [x] Discard raw PDF from memory (`req.file.buffer.fill(0)` right after AES); return `{ arweaveHash, litEncryptedKeyId }`
- [x] **Test:** `uploadFlow.test.js` — 36/36 passed ✓ (happy path, band columns, AES roundtrip via the sealed envelope, hash binding, base64url encoding, Lit/Irys/Postgres failure paths, orphan logging, 409 dedup with zero spend, near-dup flag)
- [x] **Regressions:** `encryption.manual.js` PASS ✓ against the live Lit API · `securityAndDedup.test.js` 39/39 ✓
- [x] **Live devnet smoke test — PASSED ✓ (2026-08-25)** — `node scripts/smoke-test.js --full`, **38/38**, nothing stubbed: real Irys devnet, real Lit, real Base Sepolia, real Neon.
  - Storage wallet `0x1F5362502766DCA949BBc121Aa0823E7931c051d`, 0.005 ETH credit (~294 MB)
  - End-to-end book: [`FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0`](https://gateway.irys.xyz/FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0) · registration tx `0x0c1f87a9…9b7b1d74`
  - Proved: ciphertext on the gateway is **byte-identical** to what was uploaded and **decrypts back to the original PDF byte for byte**; archivist recorded on-chain as `uploader`; public lookup leaks no key material; stranger refused decrypt params (403) while the uploader carve-out works; and the event listener **resolved the keccak topic back to the plaintext hash** — the first live proof of the whole indexed-string design.

### Two live-only bugs the smoke test caught
Both were invisible to every mocked suite, which is the entire argument for running this:

1. **`commitUpload` rejected every correct upload.** It compared `receipt.id` (base58, 44 chars) against the derived hash (base64url, 43) *as strings*. Same 32 bytes, different alphabet — so the guard fired on every upload ever made. Mocked tests passed because a fake Irys returns whatever id the test tells it to. Fixed with `decodeTransactionId()` / `sameTransactionId()`, which compare decoded bytes. `isValidArweaveHash` still rejects base58, so the canonical read-path form is unchanged.
2. **Irys token/chain mismatch stranded 0.005 ETH** — see the `base-eth` note under Phase 5 config below.

> Irys does not charge for data items under 100 KiB, so small fixtures upload free and the credit balance legitimately does not move. Don't assert on spend for a tiny PDF.
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

## Phase 6a — Postgres read paths *(no external services)*
- [x] `GET /api/upload/:arweaveHash` — metadata lookup. Validates the hash shape (43-char base64url) before querying, so junk in the URL is a cheap 400. Returns rows in **any** status — an archivist who closed the browser mid-flow has only the hash to resume staking with.
- [x] `isValidArweaveHash` added to `controller/arweave.js` — rejects the 44-char base58 form, keeping the id-encoding trap enforced on the read side too
- [x] `routes/search.routes.js` + `controller/search.controller.js` — `GET /api/search?q=&category=&status=&page=&limit=`
  - `q` matches title **OR** author, case-insensitive `contains`; omitting it browses the catalogue
  - `category` validated against `ALLOWED_CATEGORIES` (imported, not re-declared); `status` against `SEARCH_STATUSES`
  - Pagination: `page` 1-based, `limit` default 20 / max 100; `count` + page run in one `$transaction` so `total` can't disagree with the page under a concurrent write
  - Response: `{ results, page, limit, total, totalPages, hasMore, query }`
- [x] Public projection: both endpoints go through `PUBLIC_UPLOAD_SELECT` + `toPublicUpload`. Key material (`litEncryptedKeyId`, `litDataToEncryptHash`, `encryptionIv`, `encryptionAuthTag`) and dedup internals (`sha256Hash`, `simHash`, `simHashBand*`) are excluded **at the Prisma `select`**, so a later serializer edit can't start leaking a column the query never fetched.
- [x] **Test:** `readPaths.test.js` — 45/45 passed ✓ (shape, 404, four malformed-hash forms, pending_stake visibility, q/category/status filters, ordering, pagination arithmetic, param validation, projection + `$transaction` assertions)
- [x] **Verified live:** server boots against Neon, all six endpoint cases return the right status and body

### Decisions worth revisiting before launch
- **Search defaults to `status=approved`,** but any status is reachable via `?status=`. Right for the PoC (nothing reaches `approved` until the event listener exists, so dev needs `?status=pending_stake`), and it powers an archivist's "my uploads" view. If unvetted books must never be enumerable by the public, restrict the override — it is one allowlist in `search.controller.js`.
- **Decryption payload has no route yet.** `litEncryptedKeyId` + `litDataToEncryptHash` + `encryptionIv` + `encryptionAuthTag` are deliberately withheld from these public endpoints. They belong on a rental-gated route in 6b, served together as one complete payload.
- **`contains` can't use the `@@index([title, author])` index** — a leading-wildcard `LIKE` forces a sequential scan. Fine at PoC row counts; needs a `pg_trgm` GIN index or Postgres full-text search before the catalogue grows.

## Phase 6b — On-chain reads + event listener *(UNBLOCKED — contracts are live on Base Sepolia)*

All five contracts are deployed to **chain 84532 (Base Sepolia)** and verified live:

| Contract | Address | Deployed at block |
|---|---|---|
| AlexandriaLibrary | `0x0b26AB8C632586E846DE87D29D665fd727bBe844` | 42758328 |
| AlexandriaToken | `0x99C8Ab3c870AAcD75185Ee2B0c96C0Cfe85Fd605` | 42758328 |
| AlexandriaPayment | `0xa5118F666C9A3F6FF1a8342Cd2FfC84134c8b1f8` | 42758333 |
| AlexandriaRent | `0xe50AD653Ee690c818900091a4d69F22e484bD2cD` | 42758334 |
| AlexandriaStake | `0xe3027D298450695d9c4eD9A071D34e2921fc567C` | 42758660 |

- [x] `npm i ethers` (v6.17) — read-only, no signer anywhere in the backend
- [x] `scripts/sync-abis.js` + committed `abis/*.json` — ABI, address, and deployment block pulled from the AlexandriaSmartContract Ignition deployment. Committed on purpose: the backend must build without a sibling checkout, and a silently-changing ABI is worse than one that shows up in a diff.
- [x] `config/blockchain.js` — provider + read-only contract instances. Multi-URL `FallbackProvider` (quorum 1) because the official `sepolia.base.org` endpoint returns *"no backend is currently healthy"* often enough to make status endpoints flap; `base-sepolia-rpc.publicnode.com` is tried first. Env addresses override `abis/`, and a mismatch is logged loudly rather than silently preferred.
- [x] `services/blockchain.service.js` — read-only queries with revert translation (see the three on-chain gotchas below)
- [x] `routes/rental.routes.js` — `GET /api/rental/status/:hash/:address`, `GET /api/rental/book/:hash`
- [x] `routes/stake.routes.js` — `GET /api/stake/status/:hash` (on-chain stake + challenge, joined against the index with an `inSync` flag)
- [x] `routes/chain.routes.js` — `GET /api/chain/status` (listener cursor, distance from head, last error; 503 when stalled). Without it, "the listener died" and "nobody staked today" look identical.
- [x] `services/eventListener.service.js` — backfill + poll, idempotent, cursor-persisted
- [x] Rental-gated decrypt-params route — `GET /api/rental/decrypt-params/:hash/:address`
- [x] `middleware/auth.middleware.js` — cleared its own "Phase 6" TODO: now EIP-55 checksum validation via `ethers.isAddress()`, so a mistyped address is a 400 instead of a wrong-owner row
- [x] **Migration** `20260822120000_phase6b_chain_event_sync` — applied to Neon (both tables were empty, so the new unique constraints were free)
- [x] **Test:** `chainReads.test.js` — 74/74 passed ✓
- [x] **Regressions:** `readPaths` 45/45 ✓ · `securityAndDedup` 39/39 ✓ · `uploadFlow` 39/39 ✓
- [x] **Verified live:** 3.06M-block cold backfill (42,758,328 → head) completed in ~20s, cursor committing per chunk; all endpoints returned correct status and body against real Neon + real Base Sepolia

### ⚠️ The one that would have silently broken everything: `string indexed arweaveHash`

Every book-scoped event declares `string indexed arweaveHash`. A log topic is a fixed 32 bytes, so Solidity stores **keccak256(utf8(hash)) and throws the plaintext away**. The hash is genuinely not in the log — ethers hands back an `Indexed` placeholder, not a string — and keccak256 is one-way, so it cannot be decoded back.

A listener written the obvious way (`event.args.arweaveHash`) gets an object instead of a hash, matches nothing, and silently indexes zero books while looking perfectly healthy.

Resolution therefore runs **forwards**: hash the arweaveHashes we already know and match the digest.
1. `Upload.arweaveHashTopic` — a new indexed column written at upload time. One query per batch; covers every book this backend uploaded.
2. `library.getUploaderHashes(uploader)` — `uploader` is an indexed *address*, so it stays readable off the log. Covers books registered without going through this backend.

Unresolvable logs are still stored with `arweaveHash: null` and the raw topic kept, so they can be back-filled rather than lost.

> ⚠️ `Upload.arweaveHashTopic` **must travel with every insert** — same failure mode as the SimHash band columns. Omit it and the row is permanently invisible to on-chain status sync, silently.

### Three on-chain behaviours the service layer has to absorb
- **Missing rows revert, they don't return empty.** `library.getUpload()` and `getUploadStatus()` both `require(timestamp != 0, "Upload not found")`, so "never registered" arrives as a thrown `CALL_EXCEPTION`. That is a 404, and it must never be confused with the RPC being down — a network failure returns 503, because a transient outage reported as "not registered" is a permanent-sounding lie.
- **`isRentalActive()` is `view whenNotPaused`.** Pausing the Rent contract makes a *read-only permission check revert* rather than return false. Reported as `active: false, available: false` + HTTP 503: the caller fails closed but can tell "denied" from "cannot currently tell", so it never caches a pause as a settled no.
- **`stake.getStakeStatus()` does the opposite** — returns a zeroed struct instead of reverting, so "never staked" is a zero timestamp, not an error.

### Listener design notes
- **Idempotent by construction.** `Event` is upserted on `(transactionHash, logIndex)`, so replaying a range is a no-op. Ranges always run oldest-first and always extend to the current safe head, so the last status write for a book is the newest one on chain.
- **Cursor commits per chunk.** A cold start spans ~3M blocks; committing only at the end meant a crash at 99% restarted from zero and held every log in memory. `SyncState` is a separate table rather than `max(Event.blockNumber)` because quiet blocks still count as processed.
- **Chunk size only ever shrinks.** Providers disagree on the getLogs cap (publicnode 50k, drpc ~10k), so 10k is the default and a rejection halves it for the rest of the run instead of re-failing every chunk.
- **Only library events move `status`.** `stake.sol` and `rent.sol` route their own status changes through `library.updateUploadStatus()`, which emits `UploadStatusChanged` — so the library is the single authority and stake events are recorded as history rather than interpreted twice.
- **3 confirmations** behind the head as a reorg buffer. `UploadRegistered` only advances a row still in `pending_stake`, so a replayed log can never drag an approved book backwards.

### ⚠️ Decrypt-params is NOT the security boundary
`GET /api/rental/decrypt-params/:hash/:address` serves the sealed key envelope + IV + auth tag. It checks `isRentalActive` first, but **`address` is an unauthenticated path parameter** — anyone can name a wallet that holds a valid rental and be served the payload.

That is acceptable *only* because everything served is inert: the key is sealed inside a Lit PKP envelope, released solely by the Lit Action in the TEE, and the IV + auth tag are already public in the Arweave tags. The rental check here is defense in depth. **It would not be acceptable if this route ever returned a usable key.**

Fix when it's worth building: require a signed SIWE-style message over a server-issued nonce and recover the address from the signature instead of reading it from the URL — the same upgrade `auth.middleware.js` needs.

> ⚠️ **Archivists cannot rent their own books.** `Rent.rentBook()` rejects `getUploader(hash) == msg.sender` outright. The uploader is therefore let through this route explicitly (`grantedVia: "uploader"`). **The decryption Lit Action needs the same carve-out**, or an archivist will be permanently unable to open the book they uploaded.

## Phase 6c — On-chain registration *(the backend's only write path)*

**Decision made:** the backend registers uploads. The contracts were deployed expecting it, and an on-chain audit confirmed every other post-deployment step is already wired:

```
3a stake authorized in library   OK      3f stake authorized in payment  OK
3c payment set in stake          OK      3g payment set in rent          OK
3d stake set in payment          OK      4b treasury→payment allowance   OK (500k ALEX)
3e rent authorized in payment    OK      treasury holds 1,000,000,000 ALEX
3b BACKEND authorized in library  ← THE ONLY MISSING STEP
```

- [x] `config/blockchain.js` — optional registrar signer (`getSigner`, `getLibraryWriter`). Only AlexandriaLibrary gets a write handle; no other contract does. Asserts the derived address against `BACKEND_WALLET_ADDRESS` when set.
- [x] `services/registration.service.js` — `registerOnChain()` + `preflight()`
- [x] `POST /api/upload/:arweaveHash/register` — retry for uploads stored but never registered
- [x] `GET /api/upload/registrar/status` — readiness, and exactly who must fix what
- [x] Upload flow calls it after the index row is written, **non-fatal**
- [x] **Test:** `chainReads.test.js` grew to 92/92 ✓ (18 new registrar assertions)
- [x] **Verified live** against the real AlexandriaLibrary: `not_configured` with no key; key/address mismatch refuses to load the signer; an unauthorized key reports `not_authorized` and names the exact `setAuthorizedCaller` call

### Registrar wallet — ✅ LIVE
```
Address: 0xccdC69a3020BbaEb5483B2CE20d3fA0c1204b096   (created manually in Rabby)
State:   authorized ✓ · funded 0.01 ETH ✓ · key in .env ✓
preflight(): { ready: true }
```

- [x] **Private key** → `BACKEND_PRIVATE_KEY` in `.env` (untracked, gitignored). Verified to derive exactly `BACKEND_WALLET_ADDRESS`.
- [x] **Authorization** → `library.setAuthorizedCaller(0xccdC…b096, true)`
  - tx [`0xf1b74e83…472c9f61`](https://sepolia.basescan.org/tx/0xf1b74e83b89f54d40c71a733ab379af3028ebe19f72879d5509ffdc9472c9f61), block 45866078, 47,792 gas
  - run via `node scripts/authorize-backend.js --grant` in the `AlexandriaSmartContract` repo (new script; `--revoke` undoes it, no args = read-only status)
  - **this completes `deployment.md` step 3b** — the last outstanding post-deploy step
- [x] **Gas** → 0.01 Base Sepolia ETH

**Verified by simulation**, not by writing junk to the permanent registry:
`registerUpload.staticCall(...)` succeeds → a real call would land. ~308k gas,
0.0000018 ETH each, so 0.01 ETH covers **~5,400 registrations**. On-chain metadata
is a 58-byte JSON blob (`{"t":…,"a":…,"c":…}`).

> `registerUpload` has no delete, so every test registration is permanent on-chain.
> Simulate with `staticCall` rather than registering throwaway hashes.

### ⚠️ Incident: the test suite spent real gas (2026-08-23)

`uploadFlow.test.js` stubbed Postgres, Irys, Lit, and validation — **but not the
chain**. The moment a real `BACKEND_PRIVATE_KEY` existed, one run of that suite
signed **6 live transactions** and wrote junk hashes (uploader
`0x1234…5678`, titles like "On the Origin of Species") into AlexandriaLibrary.
Permanently: `registerUpload` has no delete. Cost was negligible (~0.00001 ETH,
testnet) and those hashes will never be staked or rented, but they are there forever.

Two fixes, because one was not enough:
1. **`config/blockchain.chainWritesBlocked()`** — `getSigner()` returns null when
   the entrypoint is a `*.test.js` file or under a `tests/` directory, or when
   `NODE_ENV=test` / `CHAIN_WRITES_ENABLED=false`. The entrypoint check is the
   important one: a guard that relies on every future test author remembering to
   set a variable is a guard that eventually fails.
2. **`uploadFlow.test.js` stubs `services/registration.service`** — a test should
   not rely on a guard elsewhere to avoid spending money.

Regression-tested both ways: the suite asserts the guard is active, and a full
run leaves the registrar's nonce unchanged at 6.

> **Rule:** any new test that touches `controller/upload.controller.js` must stub
> `services/registration.service`, or the guard is the only thing between it and
> a permanent on-chain write.

Check status any time with `GET /api/upload/registrar/status`.

⚠️ **The grant is slightly broader than "register only."** `onlyAuthorized` also
covers `blacklistUploader()` and `updateUploadStatus()`. Still no ability to move
funds, stake, rent, resolve challenges, pause, or transfer ownership. Revoke with
`node scripts/authorize-backend.js --revoke`.

### Why this is a narrow exception, not an abandoned principle
The registrar key **can** call `registerUpload`. It **cannot** stake, rent, transfer $ALEX, resolve challenges, or blacklist — those are `onlyOwner` or require `msg.sender` to be the staker/renter. A compromised registrar produces spam registrations, not stolen funds. Keep it that way: never make this address a contract owner or the treasury, and keep it separate from `IRYS_WALLET_KEY`.

The archivist is recorded as `uploader`, so `stake.stake()` — which requires `getUploader(hash) == msg.sender` — still has to be signed by them. Skin in the game is unchanged.

### Failure handling
Registration runs **after** the Arweave upload and the Postgres row, and never throws. By then the bytes are paid for and permanent, so a chain failure must not turn a successful upload into a 500. Each precondition is preflighted into a named reason, because each needs a different person to act on it:

| reason | who fixes it |
|---|---|
| `not_configured` | set `BACKEND_PRIVATE_KEY` |
| `not_authorized` | contract owner runs `setAuthorizedCaller` |
| `insufficient_gas` | fund the registrar wallet |
| `would_revert` | caught by `staticCall` first — no gas spent, no nonce burned |
| `already_registered` | nothing; a retry after a timed-out-but-landed tx is safe |

---

### 🚨 RESOLVED — the deployed contracts contradicted the documented upload flow

*Kept for the record; resolved by Phase 6c above.*

`CLAUDE.md` said the frontend calls `library.registerUpload(arweaveHash, metadata)` from the archivist's own wallet, and that the backend has no Ethereum key. The deployed contract says otherwise:

```solidity
function registerUpload(string calldata arweaveHash, address uploader, string calldata metadata)
    external onlyAuthorized whenNotPaused    // ← owner or setAuthorizedCaller() only
```

Three mismatches, in order of severity:
1. **`onlyAuthorized`.** An ordinary archivist calling this reverts with `"Not authorized"`. Only the owner, or an address the owner explicitly authorized, can register. `deployment.md` step 3b agrees with the contract and not with CLAUDE.md: *"Authorize your backend to register uploads."*
2. **Three parameters, not two** — `uploader` is passed explicitly, which is exactly what a backend registering *on behalf of* an archivist would need.
3. `stake.stake()` then requires `getUploader(hash) == msg.sender`, so whoever is recorded as `uploader` must be the one who stakes. That part is consistent either way.

So the contract as deployed was written for a backend that registers uploads.

**Resolved as option (a): give the backend a narrowly-scoped registrar wallet.** See Phase 6c above. The alternatives considered were (b) change the contract to allow `msg.sender == uploader` and redeploy, and (c) a relayer / meta-transaction scheme — both rejected as more work for a PoC than the blast radius of a key that can only call `registerUpload` justifies.

### Corrections applied to CLAUDE.md
The event and function names in CLAUDE.md were aspirational; these are what is actually deployed:

| CLAUDE.md said | Actually deployed |
|---|---|
| `StakeDeposited` | `Staked(string,address,uint256)` |
| `StakeReleased` | `Unstaked(string,address,uint256)` |
| `StakeSlashed` | `slashed(string,address,uint256)` — lower-case |
| `UploadChallenged` | `challengeInitiated(string,address,string)` — lower-case |
| `BookRented(hash, renter, expiryTime)` | `BookRented(string,address,uint256,uint256)` — also carries `duration` |
| `stake.stakeForUpload(hash, amount)` | `stake.stake(hash, amount)` |
| `library.registerUpload(hash, metadata)` | `registerUpload(hash, uploader, metadata)`, `onlyAuthorized` |

A renamed event is not a cosmetic problem: `registry()` throws at startup if a watched name is missing from the ABI, precisely so a listener can never quietly stop tracking challenges while looking healthy.

## Phase 7 — Frontend: Lit SDK integration + rental unlock 🔜 *(NEXT)*

**Repo:** `AlexandriaFrontEnd` (React + Vite). Tracked here because the contract it has
to honour is defined by this backend, and getting it wrong silently voids the key
binding.

> **Current state: the backend can lock books and nothing on earth can unlock them.**
> Encryption, storage, registration, and serving the sealed payload are all done and
> verified live. The decrypt half does not exist. Until it does, Alexandria stores books
> nobody can read.

### 7a — The envelope contract *(read this before writing any code)*

The backend seals **an envelope, not a bare key** (`controller/litProtocol.js`):

```js
// buildKeyEnvelope() — the plaintext handed to Lit.Actions.Encrypt
{
  v: 1,                      // ENVELOPE_VERSION — bump if this shape changes
  k: "<base64 32-byte AES-256 key>",
  arweaveHash: "FQ4e7Gt6AB4fSj65bxiyNqrn3Yn2T4nn3dJKKD7ZCx0"   // 43-char base64url
}
```

Sealed by a PKP inside a TEE via `POST /core/v1/lit_action` running:

```js
async function main({ pkpId, message }) {
  const result = await Lit.Actions.Encrypt({ pkpId, message });
  Lit.Actions.setResponse({ response: JSON.stringify(result) });
}
```

Persisted as `litEncryptedKeyId` (the ciphertext) + `litDataToEncryptHash` (Lit's
integrity hash). **Both are required to decrypt** — the ciphertext alone is not enough.

### 7b — Decryption Lit Action *(the security-critical piece)*

JS pinned to IPFS, executed in the Lit TEE. The backend is deliberately not in this path
and cannot enforce any of it.

- [ ] Decrypt the envelope inside the TEE, then **read `arweaveHash` out of the decrypted
      plaintext — never from a `js_param`.** This is the entire guarantee. A caller-supplied
      hash is trivially forgeable: rent one cheap book, submit that hash alongside a
      different book's ciphertext, and the TEE cannot tell they don't correspond.
      → [`KEY-BINDING.md`](KEY-BINDING.md), runnable exploit: `node tests/keyBinding.demo.js`
- [ ] Check `v === 1` and reject unknown envelope versions rather than guessing
- [ ] Gate on `Rent.isRentalActive(arweaveHash, userAddress)`
      — `0xe50AD653Ee690c818900091a4d69F22e484bD2cD` on Base Sepolia (84532)
- [ ] **Uploader carve-out.** `Rent.rentBook()` rejects `getUploader(hash) == msg.sender`,
      so an archivist can *never* rent their own book. Without this they are permanently
      locked out of what they uploaded. Backend already does this
      (`grantedVia: "uploader"`); the Action must match or the two disagree.
- [ ] **Fail closed on revert.** `isRentalActive` is `view whenNotPaused` — a paused Rent
      contract makes it *revert*, not return false. Treat any revert as denial, never as
      a retryable error.
- [ ] Return **only** `k`. Never the whole envelope, never the arweaveHash, never logs
      containing either.
- [ ] Pin to IPFS and record the CID here — the Action is immutable once pinned, so the
      CID *is* the security review artifact.

```js
// Shape of the gate. The first line is the one that matters.
const env = JSON.parse(await decryptInsideTee(ciphertext, dataToEncryptHash));
const { v, k, arweaveHash } = env;                      // ← from the CIPHERTEXT
if (v !== 1) return;

const rented  = await rent.isRentalActive(arweaveHash, userAddress);   // ← NOT a js_param
const isOwner = (await library.getUploader(arweaveHash)) === userAddress;
if (!rented && !isOwner) return;                        // fail closed

Lit.Actions.setResponse({ response: k });
```

### 7c — Reader flow (rent → unlock → read)

- [ ] Browse: `GET /api/search?q=&category=&page=` · detail: `GET /api/upload/:hash`
- [ ] Rental state: `GET /api/rental/status/:hash/:address` → `{ active, expiry, blacklisted, available }`
      - handle `available: false` (503) as **"cannot currently tell"**, not "denied" — do
        not cache it as a settled no
- [ ] Price/listing: `GET /api/rental/book/:hash` → `{ rentable, pricePerDayAlex, delisted }`
- [ ] Rent on-chain, user-signed: `token.approve(rentContract, total)` → `rent.rentBook(hash, duration)`
      - duration must be exactly 1, 7, or 30 days in seconds — anything else reverts
      - price is **per day**; total = `pricePerDay × days`
- [ ] Fetch decrypt payload: `GET /api/rental/decrypt-params/:hash/:address`
      → `{ litEncryptedKeyId, litDataToEncryptHash, encryptionIv, encryptionAuthTag, grantedVia }`
- [ ] Fetch ciphertext: `gateway.irys.xyz/:arweaveHash`
- [ ] Execute the Lit Action → receive `k`
- [ ] **AES-256-GCM decrypt in-browser** (WebCrypto `subtle.decrypt`), using `k` + the IV
      + auth tag. Note WebCrypto expects the auth tag **appended to the ciphertext**,
      unlike Node's separate `setAuthTag()` — this is a common porting bug.
- [ ] Render the PDF from memory. **Never** write plaintext to disk, IndexedDB, or a blob
      URL that outlives the session, and zero `k` as soon as decryption completes.

### 7d — Archivist flow (upload → stake)

- [ ] `POST /api/upload` (multipart: `file`, `title`, `author`, `category`, `description`, `walletAddress`)
- [ ] Read `registration` from the response — the backend now registers on-chain itself,
      so the frontend **no longer calls `registerUpload`**. If `registration.registered`
      is false, surface `registration.reason` and offer
      `POST /api/upload/:hash/register` to retry.
- [ ] Stake, user-signed: `token.approve(stakeContract, amount)` → `stake.stake(hash, amount)`
      - `MIN_STAKE` is 100 ALEX (`100000000000000000000`)
      - requires `getUploader(hash) === msg.sender`, which registration already arranged
- [ ] Set a price so the book becomes rentable: `rent.setBookPrice(hash, pricePerDay)`
      — only works once status is `Approved`, i.e. after the 14-day challenge window
- [ ] Show the 14-day window honestly: staking does **not** approve a book. `unstake()`
      after the window is what flips it to `Approved` and pays the 50 ALEX upload reward.

### 7e — Wiring

- [ ] Contract addresses + ABIs — copy from `abis/*.json` (`node scripts/sync-abis.js`)
      rather than hand-transcribing; they carry address, chainId, and deployment block
- [ ] Lit: `LIT_API_URL` / PKP id. Backend uses the **Chipotle v3 REST API** directly
      (`config/lit.js`), no SDK — decide whether the frontend mirrors that or uses a Lit
      client library, and record which here
- [ ] Wallet connection (Rabby/MetaMask) on Base Sepolia 84532; prompt to switch networks
- [ ] Field limits should come from the backend, not be hardcoded — see the
      `TITLE_MAX` / `AUTHOR_MAX` / `DESCRIPTION_*` export item under *Revisit at the End*

### 7f — Tests that must exist

- [ ] **The exploit fails.** Rent book A, request book B's ciphertext with A's hash — the
      Action must refuse. This is the regression test for the entire binding design; if
      it is missing, nothing else here is verified.
- [ ] Expired rental refused · blacklisted address refused · uploader allowed without a rental
- [ ] Paused Rent contract → denial, not a crash or a retry loop
- [ ] Decrypted PDF is byte-identical to the original (mirrors what
      `scripts/smoke-test.js` proves on the backend side)

> ⚠️ **The backend cannot enforce any of 7b.** `GET /api/rental/decrypt-params` checks the
> rental too, but its `address` is an unauthenticated path parameter — that check is
> defense in depth only. The Lit Action inside the TEE is the real boundary, and it is
> the only thing standing between a rented book and a leaked one.

## 🧪 Deferred until the full test pass *(deliberate — 2026-08-25)*

Held back on purpose: both are pinned to specific deployed addresses, so a contract
redeploy invalidates them. Doing them now would mean doing them twice.

- [ ] **Verify contracts on Basescan** — `npx hardhat ignition verify chain-84532` in the
      contract repo (`BASESCAN_API_KEY` is already set). This is deployment.md step 5, and
      it is also the only way to call `resolveChallenge` / `pause` / `setAuthorizedCaller`
      from a browser instead of a script.
- [ ] **Archivist staking round-trip** — the half the backend never touches. With the
      contracts verified, entirely from Rabby via Basescan:
      ```
      token.approve(0xe3027D298450695d9c4eD9A071D34e2921fc567C, 100000000000000000000)
      stake.stake("<arweaveHash>", 100000000000000000000)
      ```
      Preconditions verified as satisfiable on 2026-08-25: uploader matches the wallet,
      status Pending, not already staked, MIN_STAKE 100 ALEX, balance 1e9 ALEX,
      stake contract unpaused. Allowance was 50 ALEX, so `approve` is required first.
- [ ] Confirm the listener records `Staked`. Expect **no status change** — only library
      events move `status`, because stake.sol routes its own changes through
      `library.updateUploadStatus()`. And expect `Pending` to persist: staking opens the
      14-day challenge window; `unstake()` after it is what flips the book to `Approved`
      and pays the upload reward.

## Cross-cutting
- [ ] Jest set up; replace placeholder `test` script
- [ ] Rejection logging (reason, uploader, timestamp) for abuse detection
- [ ] Lint config (optional)
- [x] Contract ABIs + deployed addresses imported from `AlexandriaSmartContract` — `node scripts/sync-abis.js`, output committed to `abis/`
- [ ] Irys wallet balance monitoring / low-balance alert

---

## 🔍 Revisit at the End — Upload Sizing & Throughput
Nothing here blocks Phases 5–6, but all of it should be settled before real archivists upload real books. Measurements below were taken 2026-08-06; keep them for reference so the decision isn't re-litigated from scratch.

**Why `memoryStorage` (context for every item below):** multer holds the raw PDF in RAM because CLAUDE.md forbids unencrypted PDFs on disk — RAM cleanup is enforced by the OS, disk cleanup is best-effort code that a crash can skip, and `unlink()` isn't erasure. This is a **security** choice, not a performance one (disk I/O would be <1% of request time). The cost is that max file size is bounded by **RAM × concurrency**, not by storage.

- [x] **Raise `MAX_FILE_SIZE_MB` to 150 MiB** (the `.env` fallback and example are both aligned).
      - 3000-page *text* PDF ≈ 9–45 MB → fits 150 MiB with useful headroom
      - 3000-page *scan* ≈ 150–300 MB (Internet Archive-quality, ~50–100 KB/page) → smaller scans fit; color/archival scans reach 0.75–9 GB
      - Since Alexandria targets at-risk and public-domain works (overwhelmingly scans), a low upload cap rejects a meaningful share of legitimate uploads
      - Note the cap is **MiB** (`* 1024 * 1024`), so 150 → 157,286,400 bytes
- [ ] **Fix the SimHash event-loop block — needed regardless of where the size cap lands.** Scales with *page count*, not file size, so it already bites at the current 50 MB cap.
  - Measured: 300 pages → 655 ms · 1000 pages → 2.3 s · **3000 pages → 6.5 s of fully blocking synchronous BigInt work** (every other request stalls)
  - Fix A (cheap, high value): cap the text fed to `computeSimHash` at ~200k tokens — bounds cost regardless of book length; a fingerprint from the first ~400 pages is plenty discriminative for dedup
  - Fix B: rewrite the 64-bit BigInt loop as two 32-bit halves (~10× faster). A + B together → <100 ms
- [ ] **Add an upload concurrency limit.** Peak RAM is ~2.5–3× file size per in-flight upload (multer buffer + the `Buffer.concat` copy during AES-GCM). At 150 MB that's ~450 MB each; at 500 MB, three concurrent uploads OOM a default Node heap. A queue converts an unbounded crash risk into bounded latency.
- [ ] **Benchmark `pdf-parse` on a real 3000-page PDF — not yet measured.** Estimated 10–60 s of mostly-blocking extraction, which would dominate everything above and may be the true ceiling on book size.
- [ ] Duplicate constant: `MAX_FILE_SIZE_MB`/`_BYTES` is defined twice (`middleware/upload.middleware.js:4` and `services/validation.service.js:18`). Same env var so they agree in practice, but neither imports the other. `validateLayer1`'s size check is unreachable via HTTP (multer aborts first) — it's a backstop for direct calls/tests.
- [ ] Export `TITLE_MAX` / `AUTHOR_MAX` / `DESCRIPTION_MIN` / `DESCRIPTION_MAX` from `validation.service.js` so the frontend can size its inputs and show character counters instead of hardcoding 300/200/10/2000. (Also unenforced at the DB layer — Prisma `String` → Postgres `TEXT` is unbounded.)

> **The real escape hatch for large scans is Deferred Phase 1** (archivist-funded storage — frontend uploads directly to Irys). That removes the bytes from this server entirely, so neither RAM nor the no-plaintext-on-disk rule constrains file size. Don't rebuild the in-memory upload path twice chasing 500 MB archival scans.

---

## Deferred (post-PoC — Decentralization Roadmap)
- [ ] Phase 1: archivist-funded storage (frontend uploads to Irys, remove `IRYS_WALLET_KEY`)
  - **Natural point to re-decide Arweave vs. Irys L1.** Once archivists pay for their own
    storage they are choosing the provider and absorbing the cost, and the decision comes
    with real numbers instead of estimates. Irys L1 is ~20× cheaper, which is not trivial
    when archival scans run 150–300 MB. See [`ARWEAVE-IRYS.md`](ARWEAVE-IRYS.md).
- [ ] Phase 2: decentralized indexing via The Graph (MongoDB/Postgres → subgraph)
- [ ] Phase 3: distributed validation (multi-node consensus)
- [ ] Phase 4: fully client-side upload + browser encryption (backend optional)
