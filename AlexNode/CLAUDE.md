# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context: Alexandria Backend Gateway

This repository contains the **Node.js backend gateway** for Alexandria, a decentralized, censorship-resistant Web3 library designed to preserve human knowledge permanently on Arweave.

The backend is the orchestration layer — it sits between the frontend, AI validation service, and decentralized storage. It never stores unencrypted content and never holds user funds.

⚠️ **It does make exactly one kind of on-chain write: `library.registerUpload()`.** That is not a design preference — the deployed `AlexandriaLibrary.registerUpload()` is `onlyAuthorized` and takes an explicit `uploader` address, so an archivist calling it from their own wallet reverts with `"Not authorized"`. The contracts were built for a backend registrar (`deployment.md` step 3b). Everything that moves value — staking, renting, payments — is still signed by the user's own wallet, and the registrar key cannot do any of it. See **Registrar wallet** below for the exact blast radius.

### Alexandria System Architecture (Full Stack)
- **Frontend:** React + Vite (user dashboard, in-browser PDF decryption) — `AlexandriaFrontEnd` repo
- **Backend Gateway (THIS REPO):** Node.js + Express (upload orchestration, Lit Protocol encryption, Arweave indexing)
- **AI Validation:** Python + FastAPI (OCR/text extraction, content quality analysis, NLP-based checks) — separate service
- **Blockchain:** Base Testnet / Solidity (handles $ALEX token, archivist staking, time-bound rental permissions) — `AlexandriaSmartContract` repo
- **Storage:** Arweave L1 mainnet, posted directly to raw Arweave nodes with no bundler and no gateway (permanent encrypted file storage) + Postgres (off-chain search indexing). See [`ARWEAVE-DIRECT-PLAN.md`](ARWEAVE-DIRECT-PLAN.md).

### Backend Responsibilities
This service handles:
- **Upload Orchestration:** Receive PDFs from frontend, run validation, encrypt, store on Arweave, return arweaveHash to frontend
- **Security Scanning:** ClamAV virus scanning, embedded JS/attachment detection, auto-action stripping (all in-process)
- **Deduplication:** SHA-256 exact duplicate detection and SimHash near-duplicate fingerprinting (all in-process)
- **Lit Protocol Encryption:** Two-layer envelope encryption — AES-256-GCM locally for the PDF, then Lit Chipotle v3 PKP encryption for the symmetric key via REST API
- **Arweave Storage:** Sign and post encrypted PDFs to Arweave L1 nodes; a background worker confirms them, copies them to 2 independent nodes and verifies both (`services/storage.service.js`)
- **Postgres Indexing:** Maintain searchable off-chain index of all uploads (title, author, category, arweaveHash, status)
- **Event Listening:** Monitor on-chain events (uploads, rentals, challenges) and sync to Postgres (read-only, no writes)

**Critical:** The backend NEVER stores unencrypted PDFs or raw symmetric keys long-term. It generates keys, encrypts, delegates to Lit/Arweave, then discards sensitive material.

## Upload Flow (Backend + Frontend Handoff)

The smart contracts (in `AlexandriaSmartContract` repo) define the on-chain logic. The backend handles file processing and storage, then hands off to the frontend for all on-chain transactions.

### Complete Upload Flow
```
=== BACKEND (file processing + storage) ===
1. Frontend sends PDF + metadata + wallet address to backend
2. Backend runs Layer 1 validation: file size, type, magic bytes, parseability
3. Backend runs Layer 2 validation: ClamAV virus scan, embedded JS/attachment detection (in-process)
4. Backend runs Layer 3 validation: SHA-256 dedup, SimHash near-dedup (in-process)
5. Backend runs Layer 4 validation: AI content analysis via Python service (OCR, content quality)
6. Backend runs Layer 5 validation: metadata sanitization and required field checks
   → ANY failure at steps 2-6 = reject immediately, nothing stored
7. Backend generates symmetric key (crypto.randomBytes(32))
8. Backend encrypts PDF with AES-256-GCM; zeroes the plaintext
9. Backend signs the Arweave L1 transaction locally (free) → arweaveHash
   = base64url(sha256(signature)), known before anything is sent
10. Backend checks the storage wallet can pay the signed fee (else 503, nothing spent)
11. Backend seals { v, k, arweaveHash } with Lit (the decryption Lit Action gates
    on the hash INSIDE the envelope — KEY-BINDING.md); zeroes the key
12. Backend spools the ciphertext to disk, writes the Postgres row
    (status "pending_confirmation"), THEN posts the signed header to 3 nodes
13. Backend returns 202 { arweaveHash, litEncryptedKeyId, status, storage } to frontend

=== STORAGE WORKER (services/storage.service.js, background) ===
14. Waits for the header to be mined; re-posts the same signed header if lost;
    after anchor + 50 blocks unmined → "storage_failed" (archivist re-uploads)
15. Sends the chunks to 2 nodes in different /24 blocks that answer 200
16. At 16 confirmations, reads both copies back and verifies them → "pending_stake"
17. Calls library.registerUpload(arweaveHash, archivistAddress, metadata)
    → signed by the registrar wallet, because this function is onlyAuthorized
    → the ARCHIVIST is recorded as `uploader`, not the backend
    → success: "pending". Failure is non-fatal: the row stays "pending_stake" and
      is retryable via POST /api/upload/:arweaveHash/register

=== FRONTEND (value-moving transactions, signed by archivist's wallet) ===
18. Frontend polls GET /api/storage/:arweaveHash until status is "pending"
19. Frontend calls token.approve(stakeContractAddress, stakeAmount)
20. Frontend calls stake.stake(arweaveHash, stakeAmount)
    → requires getUploader(arweaveHash) == msg.sender, which step 17 satisfied
21. Backend event listener picks up on-chain events → updates Postgres status
```

### Why This Split?
- **Archivist stakes their own $ALEX** — they have real skin in the game, and
  `stake.stake()` enforces it: only the recorded uploader can stake
- **The registrar key moves no value** — it can call `registerUpload` and nothing
  else. It cannot stake, rent, transfer $ALEX, resolve challenges, or blacklist.
  A compromise means spam registrations, not stolen funds.
- **Orphan risk is minimal** — if registration fails, the encrypted file sits on
  Arweave unregistered at status "pending_stake". No money lost, no state
  corruption; retry with the arweaveHash.

### Registrar wallet
```
Address:  0xccdC69a3020BbaEb5483B2CE20d3fA0c1204b096   (BACKEND_WALLET_ADDRESS)
Key:      BACKEND_PRIVATE_KEY — blank keeps the backend fully read-only
Readiness: GET /api/upload/registrar/status
```
Requires two one-time setup steps, both outside this repo:
1. Owner (`0x5F47ecD28155790f1271df965373fD9aCEA643b9`) runs
   `library.setAuthorizedCaller("0xccdC…b096", true)` — this is `deployment.md`
   step 3b, the only post-deploy step still outstanding
2. Fund the address with Base Sepolia ETH for gas

If `BACKEND_WALLET_ADDRESS` is set, the derived address of `BACKEND_PRIVATE_KEY`
must match it or the signer refuses to load — a wrong key otherwise produces a
perfectly valid wallet that simply is not authorized, and every registration
reverts with `"Not authorized"`, which looks identical to a missing step 1.

### Deployed Contracts (Base Sepolia, chain 84532)

ABIs, addresses, and deployment blocks are committed in `abis/*.json`, generated by
`node scripts/sync-abis.js` from the AlexandriaSmartContract Ignition deployment.
Re-run it after any redeploy and **review the diff** — a changed address or event
signature means the event listener needs a second look before it is trusted.

```
AlexandriaLibrary  0x0b26AB8C632586E846DE87D29D665fd727bBe844   block 42758328
AlexandriaToken    0x99C8Ab3c870AAcD75185Ee2B0c96C0Cfe85Fd605   block 42758328
AlexandriaPayment  0xa5118F666C9A3F6FF1a8342Cd2FfC84134c8b1f8   block 42758333
AlexandriaRent     0xe50AD653Ee690c818900091a4d69F22e484bD2cD   block 42758334
AlexandriaStake    0xe3027D298450695d9c4eD9A071D34e2921fc567C   block 42758660
```

### Smart Contract Write Functions (signed by the user's wallet, NOT the backend)
```solidity
// token.sol — archivist approves the staking contract to spend tokens
token.approve(stakeContractAddress, amount)

// stake.sol — archivist locks tokens for the 14-day challenge window
stake.stake(string arweaveHash, uint256 amount)        // NOT stakeForUpload
                                                        // requires getUploader(hash) == msg.sender

// library.sol — registers upload metadata on-chain
library.registerUpload(string arweaveHash, address uploader, string metadata)
// ⚠️ onlyAuthorized — an ordinary archivist calling this reverts "Not authorized".
// See "Unresolved: who calls registerUpload" below. This is a live conflict with
// the split-flow design described above; do not assume the frontend can call it.

// Rent.sol — reader rents a book (pays $ALEX; duration must be 1, 7, or 30 days)
rent.rentBook(string arweaveHash, uint256 duration)
// ⚠️ reverts if getUploader(hash) == msg.sender — archivists cannot rent their own books
```

### Smart Contract Read Functions (backend queries — `services/blockchain.service.js`)
```solidity
library.getUpload(arweaveHash)         // ⚠️ REVERTS "Upload not found" if unregistered
library.getUploadStatus(arweaveHash)   // ⚠️ same revert; enum Pending|Challenged|Approved|Rejected
library.getUploaderHashes(uploader)    // every hash an address registered — no revert
stake.getStakeStatus(arweaveHash)      // returns a ZEROED struct if unstaked — no revert
stake.challenges(arweaveHash)          // challenger, timestamp, resolved, reason
rent.isRentalActive(arweaveHash, renter)  // ⚠️ `view whenNotPaused` — REVERTS while paused
rent.rentals(arweaveHash, renter)      // raw expiry timestamp; answers even while paused
```

Three behaviours the service layer absorbs so routes never see them:
- **Missing rows revert rather than returning empty.** "Never registered" arrives as a
  `CALL_EXCEPTION` and must become a 404 — never confused with the RPC being down,
  which is a 503. A transient outage reported as "not registered" is a lie that sounds
  permanent.
- **`isRentalActive` reverts while the Rent contract is paused.** Reported as
  `active: false, available: false` + 503, so callers fail closed but can tell "denied"
  from "cannot currently tell" and never cache a pause as a settled no.
- **`getStakeStatus` does the opposite** — a zeroed struct, not a revert.

### Smart Contract Events the Backend Listens To
Real signatures as deployed. Several differ from earlier drafts of this file
(`StakeDeposited`, `StakeReleased`, `StakeSlashed`, `UploadChallenged` never existed),
and two are lower-case. `services/eventListener.service.js` throws at startup if a
watched name is missing from the ABI, so a rename fails loudly instead of silently
indexing nothing.

```solidity
// library.sol
UploadRegistered(string indexed arweaveHash, address indexed uploader, string metadata)
UploadStatusChanged(string indexed arweaveHash, UploadStatus oldStatus, UploadStatus newStatus)
AddressBlacklisted(address indexed uploader)

// stake.sol
Staked(string indexed arweaveHash, address indexed staker, uint256 amount)
Unstaked(string indexed arweaveHash, address indexed staker, uint256 amount)
slashed(string indexed arweaveHash, address indexed staker, uint256 amount)         // lower-case
challengeInitiated(string indexed arweaveHash, address indexed challenger, string reason)  // lower-case
ChallengeResolved(string indexed arweaveHash, bool approved)
LibrarianStaked / LibrarianUnstaked / LibrarianSlashed (address-scoped)

// Rent.sol
BookRented(string indexed arweaveHash, address indexed renter, uint256 expiry, uint256 duration)
BookPriceSet(string indexed arweaveHash, uint256 price)
BookDelisted(string indexed arweaveHash)
```

#### ⚠️ `string indexed arweaveHash` — the hash is NOT in the log
A log topic is a fixed 32 bytes, so Solidity stores **keccak256(utf8(arweaveHash)) and
discards the plaintext**. ethers surfaces it as an `Indexed` placeholder, not a string,
and keccak256 cannot be reversed. Reading `event.args.arweaveHash` gets an object that
matches nothing — a listener written that way indexes zero books while looking healthy.

Resolution runs **forwards**: hash what we already know and match the digest.
1. `Upload.arweaveHashTopic` — indexed column written at upload time (one query per batch).
2. `library.getUploaderHashes(uploader)` — `uploader` is an indexed *address*, so it stays
   readable off the log; covers books registered outside this backend.

`Upload.arweaveHashTopic` must be written on every insert. Omit it and the row is
permanently invisible to status sync, silently — the same failure mode as the SimHash
band columns.

#### RESOLVED: the backend calls `registerUpload`
`registerUpload` is `onlyAuthorized` and takes an explicit `uploader`, so it was written
for a backend registrar and `deployment.md` step 3b agrees. Settled that way:
`services/registration.service.js` signs it with the registrar wallet, recording the
**archivist** as `uploader` so `stake.stake()` still has to be signed by them.

Registration is opt-in (`BACKEND_PRIVATE_KEY`) and never fatal — by the time it runs the
Arweave bytes are paid for and permanent, so a chain failure leaves the row at
`pending_stake` with a named reason rather than failing the upload. Every precondition
is preflighted into a specific reason, because each needs a different person to act:
`not_configured` (missing key), `not_authorized` (owner must run `setAuthorizedCaller`),
`insufficient_gas` (fund the wallet), `would_revert` (simulated first, so no gas or
nonce is burned on a doomed send).

### Lit Protocol Encryption (Chipotle v3)
The backend uses **two-layer envelope encryption** via the Lit Chipotle v3 REST API:
1. **Layer 1 (Local):** Generate a random AES-256 symmetric key, encrypt the PDF with AES-256-GCM
2. **Layer 2 (Lit TEE):** Encrypt the 32-byte symmetric key via `POST /core/v1/lit_action` using a PKP (Programmable Key Pair) inside a Trusted Execution Environment

Access control is enforced at **decryption time** by Lit Actions — immutable JavaScript pinned to IPFS that runs inside the TEE. The decryption Lit Action lives in the frontend (`AlexandriaFrontEnd/Alexandria-Front-end/src/services/litAction.js`) and calls `Rent.sol.isRentalActive(arweaveHash, userAddress)` with the hash read from inside the sealed envelope before releasing the symmetric key. The backend is never in the decryption path.

The old JSON-based `accessControlConditions` are deprecated (Datil network shut down Feb 2026).

## Environment & Tooling

- **Runtime:** Node.js **v22+** (managed via nvm; `.nvmrc` pins 22.21.1). Required by
  `arweave@2.x` (direct Arweave L1 storage, see `ARWEAVE-DIRECT-PLAN.md`) and declared in
  `package.json` `engines`. npm only warns on an engines mismatch, so check before deploying.
- **Module System:** CommonJS (`"type": "commonjs"` in package.json)
- **Framework:** Express.js
- **Entry Point:** `index.js`
- **Global Installs Blocked:** Always use `npx` for CLI tools

### Expected Dependencies
```
# Core
express                  — HTTP server and routing
dotenv                   — Environment variable management
cors                     — Cross-origin requests from frontend
helmet                   — Security headers

# Blockchain (read-only — event listening and status queries)
ethers                   — Smart contract event listening and read calls (no write transactions)

# Storage (direct Arweave L1 — no bundler, no gateway)
arweave                  — arweave-js 2.x: local signing, chunking, Merkle proofs only. Its own
                           uploader is NOT used (it stalls on the 303 most nodes answer); all
                           network traffic is our own fetch() to raw nodes (controller/arweave.js)

# Encryption (Lit Chipotle v3 — REST API, no heavy SDK)
# Uses native Node.js crypto for AES-256-GCM and fetch() for Lit REST API
# No @lit-protocol npm packages needed — direct HTTP calls to api.chipotle.litprotocol.com

# Database
prisma                   — ORM + migrations (dev dependency: prisma, runtime: @prisma/client)
@prisma/client           — Generated Prisma client for Postgres queries

# File Processing & Validation
multer                   — File upload handling (multipart/form-data)
crypto                   — Built-in Node.js (AES-256-GCM encryption, SHA-256 hashing)
pdf-parse                — PDF parsing, page count, text extraction for validation
file-type                — Detect true file type from magic bytes (not just extension)
sanitize-html            — Strip HTML/script tags from metadata fields
axios                    — HTTP client for AI content analysis service calls

# Security Scanning & Dedup (Backend — in-process)
clamscan                 — ClamAV virus scanning via Node.js (or clamav.js)
simhash-js               — SimHash near-duplicate fingerprinting

# Dev
nodemon                  — Auto-restart on file changes
jest                     — Testing framework (or mocha to match smart contract repo)
```

## Development Commands

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Start production server
npm start

# Run tests
npm test

# Lint (if configured)
npm run lint
```

## Project Structure (actual)

Note: the directory is `controller/` (singular), and encryption/Arweave live there
rather than in `services/`.

```
AlexNode/
├── index.js                    # Express app entry point, server startup, listener lifecycle
├── package.json
├── .env.example                # Template for required environment variables
│
├── abis/                       # Committed ABIs + addresses + deployment blocks
│   └── {library,stake,rent,token,payment}.json
│
├── scripts/
│   ├── sync-abis.js            # Regenerate abis/ from the AlexandriaSmartContract deployment
│   ├── arweave-wallet-setup.js # Storage wallet: generate | status (address check, balance, prices)
│   ├── smoke-test.js           # Live end-to-end test on Arweave mainnet (+ --full: HTTP → Base Sepolia)
│   ├── verify-upload.js        # Cross-check one book across Arweave, chain, Postgres, listener
│   └── arweave-spike.js        # Phase 0 measurements on mainnet (records raw node responses)
│
├── config/
│   ├── db.js                   # Prisma client singleton (Postgres connection)
│   ├── blockchain.js           # Ethers provider + read-only contract instances (NO signer)
│   ├── arweave.js              # Storage wallet, raw-node discovery/health, balance, price quorum
│   └── lit.js                  # Lit Chipotle v3 REST API client (stateless, no SDK)
│
├── routes/
│   ├── upload.routes.js        # POST /upload, GET /upload/:hash
│   ├── search.routes.js        # GET /search?q=...
│   ├── rental.routes.js        # GET /rental/status, /rental/book, /rental/decrypt-params
│   ├── stake.routes.js         # GET /stake/status/:hash
│   ├── chain.routes.js         # GET /chain/status (event listener health)
│   └── storage.routes.js       # GET /storage/status, /storage/:hash, /storage/:hash/data
│
├── controller/                 # singular
│   ├── upload.controller.js    # Upload orchestration + public read projection
│   ├── search.controller.js    # Postgres search queries
│   ├── rental.controller.js    # Rental status + rental-gated decrypt params
│   ├── stake.controller.js     # Stake status queries
│   ├── chain.controller.js     # Listener health
│   ├── arweave.js              # Arweave L1: sign, post header, push chunks, verify, proof-checked reads
│   ├── storage.controller.js   # Storage worker health, per-book progress, ciphertext download
│   └── litProtocol.js          # AES-256-GCM + Lit PKP key sealing
│
├── services/
│   ├── blockchain.service.js   # Read-only contract queries + revert translation
│   ├── eventListener.service.js # Watches on-chain events, syncs to Postgres via Prisma
│   ├── validation.service.js   # Layer 1 + Layer 5 validation pipeline
│   ├── securityScan.service.js # Layer 2 structural PDF scan + ClamAV
│   ├── dedup.service.js        # Layer 3 SHA-256 + banded-LSH near-dup lookup
│   ├── storage.service.js      # Storage worker: pending_confirmation → stored → registered
│   ├── spool.service.js        # Ciphertext waiting for its chunks to be sent (atomic, ciphertext only)
│   └── simhash.service.js      # 64-bit SimHash fingerprinting
│
├── prisma/
│   ├── schema.prisma           # Upload, Event, SyncState (source of truth for DB shape)
│   └── migrations/             # Generated SQL migrations
│
├── middleware/
│   ├── auth.middleware.js      # Wallet address format + EIP-55 checksum (not signature auth)
│   ├── upload.middleware.js    # Multer config, file size/type validation
│   └── error.middleware.js     # Global error handler
│
└── tests/                      # Plain `node tests/<name>.test.js` — no runner yet
    ├── uploadFlow.test.js      # Request path → 202; Lit/Postgres stubbed, Arweave via the fake network
    ├── storageWorker.test.js   # Worker: mining, copies, 303s, crash/resume, deadline, verify, registration
    ├── arweaveConfig.test.js   # Wallet checks, node discovery/seeds, balance, price quorum
    ├── helpers/fakeArweaveNetwork.js # Fake nodes built from recorded mainnet responses
    ├── fixtures/arweave-node-responses.json # Verbatim mainnet node responses
    ├── securityAndDedup.test.js # Layer 2 + Layer 3
    ├── readPaths.test.js       # GET /upload/:hash + /search
    ├── chainReads.test.js      # On-chain reads + event listener
    ├── encryption.manual.js    # Hits the live Lit API — run manually
    └── keyBinding.demo.js      # Runnable exploit demo for KEY-BINDING.md
```

## Environment Variables

```bash
# Server
PORT=3001
NODE_ENV=development

# Database (Postgres via Prisma — Neon in this project)
DATABASE_URL=postgresql://user:password@host/alexandria

# Blockchain (Base Sepolia, chain 84532) — read-only, event listening + status queries
# Comma-separated for automatic failover. sepolia.base.org intermittently returns
# "no backend is currently healthy", so publicnode is tried first.
BASE_TESTNET_RPC_URL=https://base-sepolia-rpc.publicnode.com,https://sepolia.base.org

# Leave BLANK to use the deployed addresses committed in abis/*.json. Set one only
# to repoint a single redeployed contract — a mismatch with abis/ is logged loudly.
TOKEN_CONTRACT_ADDRESS=
LIBRARY_CONTRACT_ADDRESS=
STAKE_CONTRACT_ADDRESS=
RENT_CONTRACT_ADDRESS=
PAYMENT_CONTRACT_ADDRESS=

# Event listener
EVENT_LISTENER_ENABLED=true         # false = run the API without chain syncing
CHAIN_POLL_INTERVAL_MS=12000
CHAIN_CONFIRMATIONS=3               # reorg buffer
CHAIN_LOG_CHUNK=10000               # getLogs span; publicnode caps at 50k, drpc ~10k
# CHAIN_START_BLOCK=                # defaults to the earliest deployment block in abis/

# Arweave L1 storage (see .env.example for every option)
ARWEAVE_WALLET_FILE=.arweave-wallet.json   # RSA JWK key file — keep OUTSIDE the repo; back it up
ARWEAVE_WALLET_ADDRESS=             # asserted against the file; an 0x address is rejected by name
ARWEAVE_NODE_URLS=                  # blank = discover raw peers; set to pin nodes (our own node)
ARWEAVE_CONFIRMATIONS=16            # header finality before a book counts as stored
ARWEAVE_MIN_HOLDERS=2               # independent nodes holding a verified copy
ARWEAVE_MAX_REWARD_AR=3             # fee cap per upload
STORAGE_WORKER_ENABLED=true

# Lit Protocol — Chipotle v3 REST API
LIT_API_KEY=                        # from dashboard.chipotle.litprotocol.com
LIT_PKP_ID=                         # PKP wallet ID minted via dashboard or API
LIT_API_URL=https://api.chipotle.litprotocol.com/core/v1

# AI Validation Service
VALIDATION_SERVICE_URL=http://localhost:8000

# File Upload Limits
MAX_FILE_SIZE_MB=150
```

## API Endpoints

### Upload
```
POST /api/upload
  - Body: multipart/form-data (PDF file + metadata + walletAddress)
  - Auth: None (wallet address included as metadata, real proof of ownership is on-chain staking)
  - Flow: validate → encrypt → sign → seal → spool → index (status: pending_confirmation) → post header
  - Returns: 202 { arweaveHash, litEncryptedKeyId, status: "pending_confirmation", storage }
  - The storage worker then stores it (≈25–40 min) and registers it on-chain; the
    frontend polls GET /api/storage/:arweaveHash and lets the archivist stake once
    status is "pending"
  - 503 storage_wallet_low | arweave_unavailable | arweave_price_above_cap: nothing stored or paid

GET /api/upload/:arweaveHash
  - Returns: Upload metadata (title, author, status, uploader, timestamp)

POST /api/upload/:arweaveHash/register
  - Retry registration. 409 storage_not_confirmed while the book is not stored yet
```

### Storage (direct Arweave L1)
```
GET /api/storage/status
  - Worker health, storage wallet balance, settings, pending/failed counts, oldest
    pending upload. 503 when the worker is stopped.

GET /api/storage/:arweaveHash
  - Progress of one upload: { status, stored, mined, confirmations,
    confirmationsRequired, copiesComplete, copiesRequired, verifiedCopies, error }

GET /api/storage/:arweaveHash/data
  - The ciphertext, read from raw Arweave nodes with every chunk proof-checked.
    Raw nodes are plain HTTP, which the HTTPS frontend cannot fetch, and no
    third-party gateway is used. Only for books this backend indexed and verified
    as stored. Public bytes, useless without the Lit-released key.
```

### Search
```
GET /api/search?q=<query>&category=<cat>&page=<n>
  - Searches Postgres index
  - Returns: Paginated list of approved uploads matching query
```

### Rental (live on-chain reads — `controller/rental.controller.js`)
```
GET /api/rental/status/:arweaveHash/:address
  - Live rental permission from Rent.sol. Never cached — a rental expires on a
    wall-clock timestamp, so a cached "active" is a cached authorization.
  - Returns: { active, expiry, expiryUnix, blacklisted, available, reason, book }
  - 503 with active:false when the Rent contract is paused (fail closed, but the
    caller can tell "denied" from "cannot currently tell")

GET /api/rental/book/:arweaveHash
  - Returns: { registered, onChainStatus, uploader, rentable, pricePerDay, delisted }

GET /api/rental/decrypt-params/:arweaveHash/:address
  - Rental-gated. Returns: { litEncryptedKeyId, litDataToEncryptHash,
    encryptionIv, encryptionAuthTag, grantedVia: "rental"|"uploader" }
  - ⚠️ NOT the security boundary. `address` is unauthenticated, so anyone can name
    a wallet holding a valid rental. Acceptable only because everything served is
    inert: the key is sealed in a Lit PKP envelope released solely by the Lit
    Action in the TEE, and the IV + auth tag are already public in the Arweave
    tags. This check is defense in depth. If this route ever returns a usable
    key, it must first require a signed SIWE-style message.
  - ⚠️ The uploader is allowed through without a rental, because Rent.rentBook()
    forbids archivists from renting their own books. The decryption Lit Action
    needs the same carve-out or archivists cannot open their own uploads.
```

### Stake Status
```
GET /api/stake/status/:arweaveHash
  - On-chain stake + challenge state, joined against the Postgres index
  - Returns: { status, registered, staked, stakeActive, stakeAmount,
    stakeAmountAlex, stakeTime, challengePeriodEnds, challengePeriodOver,
    challenge, index: { status, inSync } }
  - `status` comes from AlexandriaLibrary (the authority stake.sol and rent.sol
    both read). "pending_stake" exists only off-chain: bytes are on Arweave but
    registerUpload() has not been called. `index.inSync: false` means the event
    listener has not caught up — expected briefly, a bug if persistent.
```

### Chain / listener health
```
GET /api/chain/status
  - Returns: { chainId, running, startBlock, lastProcessedBlock, headBlock,
    confirmations, blocksBehind, caughtUp, storedEvents, lastError, contracts }
  - 503 when the listener is stopped or its last sync failed. Without this,
    "the listener died four hours ago" and "nobody staked today" look identical.
```

## Upload Validation Pipeline

Every file uploaded to Alexandria must pass a multi-layer validation pipeline **before** encryption or Arweave storage. If any check fails, the upload is rejected immediately — nothing gets encrypted or stored on-chain.

### Layer 1: Basic File Validation (Backend — Immediate)
Performed in `upload.middleware.js` and `upload.controller.js` before anything else:

```
Check                         Why                                         Action on Fail
─────────────────────────────────────────────────────────────────────────────────────────
File size limit               Prevent abuse / storage spam                Reject with 413
File extension check          Must be .pdf                                Reject with 400
MIME type check               Must be application/pdf                     Reject with 400
Magic bytes verification      First 5 bytes must be "%PDF-"              Reject with 400
                              (prevents renamed executables)
PDF parseability              File must open as a valid PDF               Reject with 400
                              (catches corrupted or truncated files)
Page count check              Reject empty PDFs (0 pages)                 Reject with 400
```

### Layer 2: Security Scanning (Backend — In-Process)
Performed in `validation.service.js` using local ClamAV and PDF parsing:

```
Check                         Why                                         Action on Fail
─────────────────────────────────────────────────────────────────────────────────────────
ClamAV virus scan             Detect malware, trojans, ransomware         Reject + log threat
Embedded JavaScript scan      PDFs can contain JS that executes on open   Strip or reject
Embedded file/attachment      PDFs can bundle hidden executables          Strip or reject
  detection
Auto-action detection         /OpenAction, /AA, /Launch entries that      Strip or reject
                              auto-execute on open
External link/URI scan        Detect phishing links, malicious URLs       Flag for review
Form/XFA detection            Interactive forms can carry exploits        Strip or reject
Encrypted/password-protected  Cannot validate content we can't read       Reject with 400
  PDF detection
```

### Layer 3: Deduplication (Backend — In-Process)
Performed in `validation.service.js` using built-in crypto and SimHash:

```
Check                         Why                                         Action on Fail
─────────────────────────────────────────────────────────────────────────────────────────
SHA-256 hash                  Exact duplicate detection — reject if       Reject with 409
                              hash already exists in Postgres
SimHash fingerprint           Near-duplicate detection — flag if          Flag for librarian
                              similarity score > threshold                review
```

### Layer 4: Content Quality Analysis (AI Validation Service)
Performed by the Python FastAPI service for ML/NLP-based checks:

```
Check                         Why                                         Action on Fail
─────────────────────────────────────────────────────────────────────────────────────────
OCR/text extraction check     Verify PDF contains actual readable         Flag if no text
                              content (not blank or image-only spam)      (may be valid scan)
Page content analysis         Detect gibberish, auto-generated filler,    Flag for review
                              or non-book content
Language/quality scoring      NLP-based content quality assessment        Flag for review
```

### Layer 5: Metadata Validation (Backend)
Performed in `upload.controller.js` on the archivist-supplied metadata:

```
Check                         Why                                         Action on Fail
─────────────────────────────────────────────────────────────────────────────────────────
Title present and reasonable  Prevent empty or spam titles                Reject with 400
Author present                Required metadata field                    Reject with 400
Category from allowed list    Prevent garbage categories                 Reject with 400
Description length check      Min/max character limits                   Reject with 400
Metadata sanitization         Strip HTML, script tags, control chars     Sanitize in place
                              from all text fields
```

### Validation Flow Summary
```
PDF arrives at POST /api/upload
         │
         ▼
┌─────────────────────────┐
│ Layer 1: File Basics     │  ← Instant, in-process
│ Size, extension, MIME,   │
│ magic bytes, parseability│
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ Layer 2: Security Scan   │  ← In-process (local ClamAV)
│ ClamAV, embedded JS,     │
│ auto-actions, attachments│
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ Layer 3: Deduplication   │  ← In-process (crypto + SimHash)
│ SHA-256 exact dedup,     │
│ SimHash near-dedup       │
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ Layer 4: Content Quality │  ← Calls AI Validation Service
│ OCR/text extraction,     │
│ NLP content analysis     │
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ Layer 5: Metadata Check  │  ← In-process
│ Title, author, category, │
│ sanitization             │
└────────┬────────────────┘
         │ ALL PASS
         ▼
    Proceed to encryption
    and Arweave upload
```

### Validation Response to Frontend
```javascript
// Success — all checks passed
{ valid: true, sha256: "abc123...", simHash: "def456..." }

// Failure — returns first failing check
{
  valid: false,
  stage: "security_scan",          // Which layer failed
  reason: "embedded_javascript",   // Specific check that failed
  message: "PDF contains embedded JavaScript which is not allowed"
}
```

### Key Design Decisions
- **Fail fast:** Checks run in order from cheapest to most expensive. File size/type checks happen before ClamAV, ClamAV before SimHash, and the expensive AI/NLP content analysis runs last (only if all local checks pass).
- **No partial uploads:** If any check fails, nothing gets encrypted or stored. No cleanup needed.
- **Scan before encrypt:** All scanning happens on the raw PDF. Once encrypted, the content is opaque — you can never scan it again.
- **Temporary file handling:** Raw PDF exists in memory (or a temp directory) only during validation. Deleted immediately after encryption or rejection.
- **Logging:** All rejections logged with reason, uploader address, and timestamp for abuse detection patterns.

---

## Encryption Flow (Backend Responsibility)

**Decision:** The backend uses **two-layer envelope encryption** via native Node.js `crypto` (AES-256-GCM) and the Lit Chipotle v3 REST API. This replaces the old Lit SDK v7 `encryptFile` (Datil network, shut down Feb 2026).

- **Layer 1:** AES-256-GCM encrypts the raw PDF with a locally-generated random symmetric key (fast, no network)
- **Layer 2:** The 32-byte symmetric key is encrypted by a PKP inside a Lit TEE via `POST /core/v1/lit_action` (small network call)
- **Access control** is NOT embedded at encryption time. It is enforced at decryption time by a Lit Action (built in the frontend).

The backend NEVER stores unencrypted PDFs or raw symmetric keys. Keys are zeroed from memory immediately after encryption.

#### The sealed payload is an envelope, not a bare key
The decryption Lit Action gates on `Rent.isRentalActive(arweaveHash, user)`. If that `arweaveHash` were a caller-supplied parameter, the gate would be trivially bypassable: rent one cheap book, then submit *that* hash alongside a *different* book's ciphertext — the TEE cannot tell they don't correspond.

So the hash is sealed **inside** the ciphertext as `{ v, k, arweaveHash }`. The decryption Action reads it out of the decrypted plaintext and gates on that value, which the caller cannot forge.

This is why encryption is split into two calls (`aesEncryptPdf` → `sealKey`): the `arweaveHash` only exists once the Arweave transaction is signed, which happens between them.

**The decrypt half is built in the frontend** (`src/services/litAction.js`) and reads `arweaveHash` from the decrypted envelope — never from a `js_param`. Every edit to it must re-pass the reviewer checklist and the negative test in **[`KEY-BINDING.md`](KEY-BINDING.md)** (the exploit, a runnable demo, and the checklist), because the guarantee is worthless if that Action gets it wrong.

### At Upload Time
```javascript
// controller/upload.controller.js, simplified
const { ciphertext, iv, authTag, symmetricKey } = aesEncryptPdf(pdfBuffer); // Layer 1, local

// Sign the Arweave L1 transaction locally — free, offline. The id is
// base64url(sha256(signature)) and the signature covers data_root, so the
// arweaveHash is fixed before anything is sent (prepareUpload re-checks this).
const prepared = await prepareUpload(ciphertext, buildTags({ ... })); // { arweaveHash, header, reward, anchorHeight }

// The storage wallet must cover the signed fee, or nothing happens (503).
// Layer 2: seal the key BOUND to that hash, still before anything can be paid.
const { encryptedSymmetricKey, dataToEncryptHash } = await sealKey(symmetricKey, prepared.arweaveHash);
symmetricKey.fill(0);

await spool.write(arweaveHash, ciphertext);              // chunks go out later, must be these bytes
await prisma.upload.create({ ...status: 'pending_confirmation', arweaveUploaderState: { header } });
await postHeader(prepared.header);                       // paid once mined
// → 202. services/storage.service.js does the rest (chunks, confirmations, copies, registration).
```

**Order matters.** Sealing before posting means a Lit failure costs nothing; reversed, it would leave paid-for bytes nobody can decrypt. Persisting before posting means a failed database write never leaves a header that may be mined (and paid for) with no row telling the worker to send its data.

⚠️ **Arweave id encoding.** A transaction id is **32 raw bytes** (`sha256` of the signature), rendered as **base64url, 43 characters**: gateways, tags, on-chain consumers and our DB all use that form, and it was verified live on mainnet (ARWEAVE-DIRECT-PLAN.md §9 Q1). Two rules, learned the hard way under the old upload path (whose receipts were base58, 44 chars, and never compared equal as strings):
1. Derive the id yourself and check it: `prepareUpload` recomputes base64url(sha256(signature)) and refuses a mismatch.
2. Never compare two ids as strings: use `sameTransactionId()`, which compares the decoded 32 bytes.

> A wrong belief about the id format was once copied into a test fake, so the mock asserted the assumption instead of testing reality, and the bug survived every suite until a live upload. That is why the test fakes are now built from recorded mainnet responses (`tests/fixtures/`, `.arweave-spike/*/run.json`).

📄 **Why direct L1, and the sourced facts behind every design choice:** [`ARWEAVE-DIRECT.md`](ARWEAVE-DIRECT.md) (protocol research), [`ARWEAVE-UPLOAD-OPTIONS.md`](ARWEAVE-UPLOAD-OPTIONS.md) (alternatives), [`ARWEAVE-DIRECT-PLAN.md`](ARWEAVE-DIRECT-PLAN.md) (decisions D1–D9, Phase 0 live answers Q1–Q13).

### Security Rules
- Symmetric keys exist in memory only during the upload transaction
- No unencrypted PDFs written to disk at any point
- Backend holds exactly two keys, both low-privilege and separate: the Arweave
  storage wallet (`ARWEAVE_WALLET_FILE`, an RSA JWK file kept outside the repo; pays
  for Arweave bytes only) and `BACKEND_PRIVATE_KEY` (calls `library.registerUpload()`
  only). Neither can move $ALEX or stake. Do not merge them into one wallet, and
  never give either contract ownership.
- The spool (`ARWEAVE_SPOOL_DIR`) holds AES-GCM ciphertext only, deleted once the book is verified stored
- Upload requests include wallet address as metadata (not cryptographic auth — on-chain staking is the real proof of ownership)
- File uploads validated for size, type, and content before processing

### Storage Wallet Funding Model
- The Arweave storage wallet is a **dedicated, low-privilege wallet** — it can only pay for Arweave uploads
- The **project treasury** periodically sends it AR (bought on an exchange and withdrawn on the Arweave network — never to an 0x address)
- Keep it lightly funded: if the server is compromised, an attacker can only spend what is loaded. Each upload is also capped by `ARWEAVE_MAX_REWARD_AR`
- The treasury wallet stays offline and never touches the backend server
- Balance: `GET /api/storage/status` or `node scripts/arweave-wallet-setup.js status` (shows how many maximum-size uploads it covers). Every row records its exact fee in `arweaveReward` (D7)

## Prisma Schema (Postgres)

The source of truth is `prisma/schema.prisma`. Run `npx prisma migrate dev` after editing.

### Upload model
```prisma
model Upload {
  arweaveHash       String   @id // Primary key (original identifier)
  title             String
  author            String
  category          String
  description       String
  uploader          String   // Wallet address
  uploadTimestamp   DateTime @default(now())
  status            String   // "pending" | "challenged" | "approved" | "rejected"
  fileSize          Int      // Bytes
  sha256Hash        String   @unique // Exact duplicate detection
  simHash           String   // Near-duplicate detection reference
  litEncryptedKeyId String   // Reference to Lit Protocol encrypted key
  onChainTxHash     String?  // On-chain registration tx hash (optional initially)

  @@index([title, author]) // Search queries
}
```

The live schema has drifted from the sketch above — `prisma/schema.prisma` is the
source of truth. Notably `Upload` also carries `arweaveHashTopic` (keccak256 of the
hash; the only join key from a log topic back to a row — see the indexed-string note
above), `pageCount`, `litDataToEncryptHash`, `encryptionIv`, `encryptionAuthTag`,
`isNearDuplicate` / `nearDuplicateOf`, and `simHashBand0..3`.

### Event model (synced blockchain events)
```prisma
model Event {
  id               Int      @id @default(autoincrement())
  eventName        String   // "UploadRegistered", "Staked", "BookRented", ...
  contract         String   // "library" | "stake" | "rent"
  arweaveHash      String?  // null when the topic could not be resolved to a known book
  arweaveHashTopic String?  // keccak256 topic exactly as emitted
  args             Json
  blockNumber      Int
  logIndex         Int
  transactionHash  String
  timestamp        DateTime

  // Idempotency: a restarted listener re-scans an overlapping range on purpose,
  // and a reorg can re-deliver logs. Replay upserts instead of duplicating.
  @@unique([transactionHash, logIndex])
}
```

### SyncState model (listener cursor)
```prisma
model SyncState {
  id                 String   @id // "chain-84532"
  lastProcessedBlock Int
  updatedAt          DateTime @updatedAt
}
```
A separate table rather than `max(Event.blockNumber)` because quiet blocks still count
as processed — deriving the cursor from the last stored event would re-scan every
eventless block on every restart.

## Testing Approach

- **Unit tests:** Test encryption service, validation calls, and Postgres operations in isolation
- **Integration tests:** Test full upload flow with mocked external services (Arweave, Lit)
- **Event listener tests:** Test that on-chain event syncing correctly updates Postgres
- **Never test with real funds or mainnet contracts**

## Critical Design Constraints

### What the Backend Does
- Orchestrates the upload pipeline (validate → encrypt → store on Arweave → index in Postgres)
- Returns arweaveHash to frontend for on-chain staking/registration
- Provides search/query API for the frontend
- Listens to on-chain events (read-only) and syncs state to Postgres
- Generates and encrypts symmetric keys (then discards them)

### What the Backend Does NOT Do
- **Move value on-chain** — it holds a registrar key that can call
  `library.registerUpload()` and nothing else. Staking, renting, payments, challenge
  resolution, and blacklisting are all either user-signed or `onlyOwner`.
- Store unencrypted PDFs or symmetric keys
- Handle staking, registration, or rental payments (all done by frontend/user wallet)
- Make access control decisions (Lit Protocol reads Rent.sol directly)
- Run NLP/ML content analysis itself (delegates to separate Python FastAPI service for OCR and content quality)
- Manage user wallets or private keys (users sign all transactions in their browser)

### Relationship to Other Repos
- **AlexandriaSmartContract:** Backend needs contract ABIs and deployed addresses for read-only event listening and status queries. ABIs are generated by `npx hardhat compile` in that repo. All write transactions (staking, registration, rentals) are handled by the frontend.
- **AlexandriaFrontEnd:** Frontend calls this backend's REST API for uploads and search. Frontend calls smart contracts directly for all on-chain transactions (staking, registration, rentals, payments) using the user's own wallet.
- **AI Validation Service:** Backend calls this via HTTP (POST /analyze with PDF) for NLP/ML content quality checks (OCR, gibberish detection, content scoring). ClamAV, SHA-256, and SimHash are handled directly by the backend.

## Decentralization Roadmap

The current architecture is **intentionally centralized for the PoC**. The backend server is a single point of control for uploads, validation, and indexing. This is the right tradeoff for shipping — but the design allows progressive decentralization over time.

### What's Already Decentralized (PoC)
- **Storage:** Arweave is permanent and permissionless — once uploaded, no one can delete or censor content
- **Access control:** Lit Protocol reads on-chain state directly — the backend is not in the decryption path
- **Payments & staking:** All on-chain, user-signed from their own wallets, no intermediary
- **Rentals:** Frontend talks directly to smart contracts

### What's Centralized (PoC)
- **Upload pipeline:** Single backend server validates, encrypts, and uploads to Arweave
- **Storage funding:** Single Arweave storage wallet funded by project treasury pays for all uploads
- **Search index:** Postgres on the backend server — if the server goes down, search is unavailable (though all data still exists on Arweave and on-chain)
- **Validation:** Backend decides what passes validation — single authority on content quality

### Phase 1: Archivist-Funded Storage
Move Arweave storage costs from the project to the archivists themselves:
- Frontend posts encrypted PDFs to Arweave nodes using the archivist's own Arweave wallet
- Backend only handles validation and Lit Protocol encryption, returns the encrypted blob to the frontend
- Removes the storage wallet (`ARWEAVE_WALLET_FILE`) from the backend entirely — no funded wallets on the server at all
- Archivists pay for storage as part of their upload cost (alongside staking)

### Phase 2: Decentralized Indexing
Replace the centralized Postgres index:
- Use **The Graph** to index on-chain events (uploads, rentals, challenges) into a decentralized subgraph
- Frontend queries the subgraph directly instead of the backend's `/api/search` endpoint
- On-chain metadata (title, author, category) stored in smart contract events, indexed by The Graph
- Postgres becomes optional (local cache for performance, not the source of truth)

### Phase 3: Distributed Validation
Remove the single-server validation bottleneck:
- Multiple independent validation nodes run the same pipeline
- Consensus required (e.g., 2-of-3 validators must agree) before upload proceeds
- Validators stake tokens to participate — slashed for incorrect validations
- Could use existing librarian role as the validator set

### Phase 4: Fully Decentralized Upload
Remove the backend server from the upload path entirely:
- Frontend handles the full pipeline: validate → encrypt → upload to Arweave → stake on-chain
- Validation runs client-side or via decentralized validator network
- Lit Protocol encryption happens in-browser
- Backend server becomes optional — only needed for convenience features (caching, notifications)
- The protocol works even if every backend server goes offline
