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
- **Storage:** Arweave via Irys (permanent encrypted file storage) + Postgres (off-chain search indexing)

### Backend Responsibilities
This service handles:
- **Upload Orchestration:** Receive PDFs from frontend, run validation, encrypt, store on Arweave, return arweaveHash to frontend
- **Security Scanning:** ClamAV virus scanning, embedded JS/attachment detection, auto-action stripping (all in-process)
- **Deduplication:** SHA-256 exact duplicate detection and SimHash near-duplicate fingerprinting (all in-process)
- **Lit Protocol Encryption:** Two-layer envelope encryption — AES-256-GCM locally for the PDF, then Lit Chipotle v3 PKP encryption for the symmetric key via REST API
- **Arweave/Irys Storage:** Upload encrypted PDFs to permanent storage, manage transaction IDs
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
8. Backend encrypts PDF with AES-256-GCM
9. Backend uploads encrypted PDF to Arweave via Irys → gets arweaveHash
10. Backend encrypts symmetric key with Lit Protocol, setting access condition:
    → Lit checks Rent.sol.isRentalActive(arweaveHash, userAddress)
11. Backend stores metadata + uploader wallet address in Postgres (status: "pending_stake")
12. Backend discards symmetric key and unencrypted PDF from memory
13. Backend returns { arweaveHash, litEncryptedKeyId } to frontend

13. Backend calls library.registerUpload(arweaveHash, archivistAddress, metadata)
    → signed by the registrar wallet, because this function is onlyAuthorized
    → the ARCHIVIST is recorded as `uploader`, not the backend
    → non-fatal: on failure the row stays "pending_stake" and is retryable via
      POST /api/upload/:arweaveHash/register
14. Backend returns { arweaveHash, litEncryptedKeyId, registration } to frontend

=== FRONTEND (value-moving transactions, signed by archivist's wallet) ===
15. Frontend calls token.approve(stakeContractAddress, stakeAmount)
16. Frontend calls stake.stake(arweaveHash, stakeAmount)
    → requires getUploader(arweaveHash) == msg.sender, which step 13 satisfied
17. Backend event listener picks up on-chain events → updates Postgres status
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

Access control is enforced at **decryption time** by Lit Actions — immutable JavaScript pinned to IPFS that runs inside the TEE. The decryption Lit Action (Phase 5+) will call `Rent.sol.isRentalActive(arweaveHash, userAddress)` before releasing the symmetric key. The backend is never in the decryption path.

The old JSON-based `accessControlConditions` are deprecated (Datil network shut down Feb 2026).

## Environment & Tooling

- **Runtime:** Node.js v18+ (managed via nvm)
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

# Storage
@irys/sdk                — Arweave uploads via Irys
arweave                  — Arweave transaction queries

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
│   └── sync-abis.js            # Regenerate abis/ from the AlexandriaSmartContract deployment
│
├── config/
│   ├── db.js                   # Prisma client singleton (Postgres connection)
│   ├── blockchain.js           # Ethers provider + read-only contract instances (NO signer)
│   ├── irys.js                 # Irys client configuration
│   └── lit.js                  # Lit Chipotle v3 REST API client (stateless, no SDK)
│
├── routes/
│   ├── upload.routes.js        # POST /upload, GET /upload/:hash
│   ├── search.routes.js        # GET /search?q=...
│   ├── rental.routes.js        # GET /rental/status, /rental/book, /rental/decrypt-params
│   ├── stake.routes.js         # GET /stake/status/:hash
│   └── chain.routes.js         # GET /chain/status (event listener health)
│
├── controller/                 # singular
│   ├── upload.controller.js    # Upload orchestration + public read projection
│   ├── search.controller.js    # Postgres search queries
│   ├── rental.controller.js    # Rental status + rental-gated decrypt params
│   ├── stake.controller.js     # Stake status queries
│   ├── chain.controller.js     # Listener health
│   ├── arweave.js              # Irys prepare/commit, tags, hash validation
│   └── litProtocol.js          # AES-256-GCM + Lit PKP key sealing
│
├── services/
│   ├── blockchain.service.js   # Read-only contract queries + revert translation
│   ├── eventListener.service.js # Watches on-chain events, syncs to Postgres via Prisma
│   ├── validation.service.js   # Layer 1 + Layer 5 validation pipeline
│   ├── securityScan.service.js # Layer 2 structural PDF scan + ClamAV
│   ├── dedup.service.js        # Layer 3 SHA-256 + banded-LSH near-dup lookup
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
    ├── uploadFlow.test.js      # Full upload pipeline, mocked Irys/Lit/Postgres
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

# Arweave / Irys
IRYS_NODE_URL=https://node2.irys.xyz
IRYS_WALLET_KEY=                    # Dedicated storage wallet, funded by project treasury

# Lit Protocol — Chipotle v3 REST API
LIT_API_KEY=                        # from dashboard.chipotle.litprotocol.com
LIT_PKP_ID=                         # PKP wallet ID minted via dashboard or API
LIT_API_URL=https://api.chipotle.litprotocol.com/core/v1

# AI Validation Service
VALIDATION_SERVICE_URL=http://localhost:8000

# File Upload Limits
MAX_FILE_SIZE_MB=50
```

## API Endpoints (Planned)

### Upload
```
POST /api/upload
  - Body: multipart/form-data (PDF file + metadata + walletAddress)
  - Auth: None (wallet address included as metadata, real proof of ownership is on-chain staking)
  - Flow: validate → encrypt → store on Arweave → index in Postgres (status: pending_stake)
  - Returns: { arweaveHash, litEncryptedKeyId }
  - Frontend then handles on-chain staking and registration with returned arweaveHash

GET /api/upload/:arweaveHash
  - Returns: Upload metadata (title, author, status, uploader, timestamp)
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
- **Access control** is NOT embedded at encryption time. It is enforced at decryption time by a Lit Action (Phase 5+).

The backend NEVER stores unencrypted PDFs or raw symmetric keys. Keys are zeroed from memory immediately after encryption.

#### The sealed payload is an envelope, not a bare key
The decryption Lit Action gates on `Rent.isRentalActive(arweaveHash, user)`. If that `arweaveHash` were a caller-supplied parameter, the gate would be trivially bypassable: rent one cheap book, then submit *that* hash alongside a *different* book's ciphertext — the TEE cannot tell they don't correspond.

So the hash is sealed **inside** the ciphertext as `{ v, k, arweaveHash }`. The decryption Action reads it out of the decrypted plaintext and gates on that value, which the caller cannot forge.

This is why encryption is split into two calls (`aesEncryptPdf` → `sealKey`): the `arweaveHash` only exists once the Irys data item is signed, which happens between them.

**The decrypt half is not built yet, and the guarantee is worthless without it.** The decryption Lit Action must read `arweaveHash` from the decrypted envelope and gate on that — never on a `js_param`. See **[`KEY-BINDING.md`](KEY-BINDING.md)** for the exploit, a runnable demo, and a reviewer checklist.

### At Upload Time
```javascript
const { aesEncryptPdf, sealKey } = require('./controller/litProtocol');
const { prepareUpload, commitUpload, buildTags } = require('./controller/arweave');

// Layer 1: Local AES-256-GCM (raw Buffer — base64 would cost 33% more on Arweave)
const { ciphertext, iv, authTag, symmetricKey } = aesEncryptPdf(pdfBuffer);

// Sign the Irys data item locally — free, offline, and yields the arweaveHash
// (a data item's id is sha256 of its signature, so it's known before upload).
const { arweaveHash, tx } = await prepareUpload(ciphertext, buildTags({ ... }));

// Layer 2: Seal the key BOUND to that hash, still before spending anything
const { encryptedSymmetricKey, dataToEncryptHash } = await sealKey(symmetricKey, arweaveHash);
symmetricKey.fill(0);

// Only now push bytes — the paid, irreversible step
await commitUpload(tx, arweaveHash);

// Persist encryptedSymmetricKey + dataToEncryptHash (litEncryptedKeyId) in Postgres
```

**Order matters.** Sealing before pushing means a Lit failure costs nothing. Reversed, it would leave permanently paid-for bytes that nobody can ever decrypt.

⚠️ **Arweave id encoding:** `@irys/bundles` exposes `DataItem.id` as **base58** (44 chars), but gateways, upload receipts, and on-chain consumers all use **base64url** (43 chars) — and its own getter/setter disagree (`get id` encodes base58, `set id` decodes base64url). Always derive the hash as base64url of `tx.rawId`; `controller/arweave.js` does this via `transactionId()`.

### Security Rules
- Symmetric keys exist in memory only during the upload transaction
- No unencrypted PDFs written to disk at any point
- Backend holds exactly two keys, both low-privilege and separate:
  `IRYS_WALLET_KEY` (pays for Arweave bytes only) and `BACKEND_PRIVATE_KEY`
  (calls `library.registerUpload()` only). Neither can move $ALEX or stake.
  Do not merge them into one wallet, and never give either contract ownership.
- Backend does have an Irys wallet key (`IRYS_WALLET_KEY`) solely for paying Arweave storage fees
- Upload requests include wallet address as metadata (not cryptographic auth — on-chain staking is the real proof of ownership)
- File uploads validated for size, type, and content before processing

### Irys Wallet Funding Model
- The Irys wallet is a **dedicated, low-privilege storage wallet** — it can only pay for Arweave uploads
- The **project treasury wallet** periodically tops up the Irys wallet with small amounts
- Keep the Irys wallet lightly funded to minimize exposure — if the server is compromised, the attacker can only burn through whatever storage credits are currently loaded
- The treasury wallet stays offline and never touches the backend server
- Monitor Irys wallet balance and alert when it needs a top-up

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
- **Storage funding:** Single Irys wallet funded by project treasury pays for all Arweave uploads
- **Search index:** Postgres on the backend server — if the server goes down, search is unavailable (though all data still exists on Arweave and on-chain)
- **Validation:** Backend decides what passes validation — single authority on content quality

### Phase 1: Archivist-Funded Storage
Move Arweave storage costs from the project to the archivists themselves:
- Frontend uploads encrypted PDFs directly to Irys using the archivist's wallet
- Backend only handles validation and Lit Protocol encryption, returns the encrypted blob to the frontend
- Removes `IRYS_WALLET_KEY` from backend entirely — no funded wallets on the server at all
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
