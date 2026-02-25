# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context: Alexandria Backend Gateway

This repository contains the **Node.js backend gateway** for Alexandria, a decentralized, censorship-resistant Web3 library designed to preserve human knowledge permanently on Arweave.

The backend is the orchestration layer — it sits between the frontend, AI validation service, and decentralized storage. It never stores unencrypted content, never holds user funds, and never writes to the blockchain. All on-chain transactions (staking, registration, rentals) are signed by users directly from the frontend.

### Alexandria System Architecture (Full Stack)
- **Frontend:** React + Vite (user dashboard, in-browser PDF decryption) — `AlexandriaFrontEnd` repo
- **Backend Gateway (THIS REPO):** Node.js + Express (upload orchestration, Lit Protocol encryption, Arweave indexing)
- **AI Validation:** Python + FastAPI (OCR/text extraction, content quality analysis, NLP-based checks) — separate service
- **Blockchain:** Base Testnet / Solidity (handles $ALEX token, archivist staking, time-bound rental permissions) — `AlexandriaSmartContract` repo
- **Storage:** Arweave via Irys (permanent encrypted file storage) + MongoDB (off-chain search indexing)

### Backend Responsibilities
This service handles:
- **Upload Orchestration:** Receive PDFs from frontend, run validation, encrypt, store on Arweave, return arweaveHash to frontend
- **Security Scanning:** ClamAV virus scanning, embedded JS/attachment detection, auto-action stripping (all in-process)
- **Deduplication:** SHA-256 exact duplicate detection and SimHash near-duplicate fingerprinting (all in-process)
- **Lit Protocol Encryption:** Encrypt symmetric keys with on-chain access conditions tied to Rent.sol
- **Arweave/Irys Storage:** Upload encrypted PDFs to permanent storage, manage transaction IDs
- **MongoDB Indexing:** Maintain searchable off-chain index of all uploads (title, author, category, arweaveHash, status)
- **Event Listening:** Monitor on-chain events (uploads, rentals, challenges) and sync to MongoDB (read-only, no writes)

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
11. Backend stores metadata + uploader wallet address in MongoDB (status: "pending_stake")
12. Backend discards symmetric key and unencrypted PDF from memory
13. Backend returns { arweaveHash, litEncryptedKeyId } to frontend

=== FRONTEND (on-chain transactions, signed by archivist's wallet) ===
14. Frontend calls token.approve(stakeContractAddress, stakeAmount)
15. Frontend calls stake.stakeForUpload(arweaveHash, stakeAmount)
16. Frontend calls library.registerUpload(arweaveHash, metadata)
17. Backend event listener picks up on-chain events → updates MongoDB status to "pending"
```

### Why This Split?
- **Backend has no wallet** — no private key to compromise, no funds to drain
- **Archivist stakes their own $ALEX** — they have real skin in the game
- **Decentralized** — on-chain actions are always user-signed, not server-signed
- **Orphan risk is minimal** — if archivist closes browser after step 13 but before step 16, the encrypted file sits on Arweave unregistered. No money lost, no state corruption. Archivist can retry staking later with the arweaveHash.

### Smart Contract Functions (Called by Frontend, NOT Backend)
```
// From token.sol — archivist approves staking contract to spend tokens
token.approve(stakeContractAddress, amount)

// From stake.sol — archivist locks tokens for 14-day validation
stake.stakeForUpload(arweaveHash, amount)

// From library.sol — archivist registers upload metadata on-chain
library.registerUpload(arweaveHash, metadata)

// From Rent.sol — reader rents a book (pays $ALEX)
rent.rentBook(arweaveHash, duration)
```

### Smart Contract Read Functions (Backend queries for status endpoints)
```
// From library.sol — query upload status
library.getUpload(arweaveHash)

// From stake.sol — query stake status
stake.getStakeStatus(arweaveHash)

// From Rent.sol — query rental status
rent.isRentalActive(arweaveHash, renterAddress)
```

### Smart Contract Events the Backend Listens To
```
// Sync these to MongoDB for frontend queries
UploadRegistered(arweaveHash, uploader, timestamp)
UploadStatusChanged(arweaveHash, newStatus)
StakeDeposited(arweaveHash, staker, amount)
StakeReleased(arweaveHash, staker, amount)
StakeSlashed(arweaveHash, staker, amount)
BookRented(arweaveHash, renter, expiryTime)
UploadChallenged(arweaveHash, challenger, reason)
ChallengeResolved(arweaveHash, approved)
```

### Lit Protocol Access Conditions
When encrypting a symmetric key, the backend sets this access condition:
```javascript
const accessControlConditions = [
  {
    contractAddress: RENT_CONTRACT_ADDRESS,
    standardContractType: "custom",
    chain: "baseSepolia",
    method: "isRentalActive",
    parameters: [arweaveHash, ":userAddress"],
    returnValueTest: {
      comparator: "=",
      value: "true"
    }
  }
];
```
This means Lit Protocol will only release the decryption key if `Rent.sol.isRentalActive()` returns true for the requesting user.

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

# Encryption
@lit-protocol/lit-node-client  — Lit Protocol SDK for key encryption
@lit-protocol/constants        — Lit Protocol chain/network constants

# Database
mongoose                 — MongoDB ODM

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

## Project Structure (Planned)

```
AlexNode/
├── index.js                    # Express app entry point, server startup
├── package.json
├── .env.example                # Template for required environment variables
│
├── config/
│   ├── db.js                   # MongoDB connection setup
│   ├── blockchain.js           # Ethers.js provider + read-only contract instances (no signer)
│   ├── irys.js                 # Irys client configuration
│   └── lit.js                  # Lit Protocol client setup
│
├── routes/
│   ├── upload.routes.js        # POST /upload, GET /upload/:hash
│   ├── search.routes.js        # GET /search?query=...
│   ├── rental.routes.js        # GET /rental/status/:hash/:address
│   └── stake.routes.js         # GET /stake/status/:hash
│
├── controllers/
│   ├── upload.controller.js    # Upload orchestration logic
│   ├── search.controller.js    # MongoDB search queries
│   ├── rental.controller.js    # Rental status queries
│   └── stake.controller.js     # Stake status queries
│
├── services/
│   ├── encryption.service.js   # AES-256-GCM encrypt/decrypt, key generation
│   ├── arweave.service.js      # Irys upload, Arweave fetch
│   ├── lit.service.js          # Lit Protocol key encryption with access conditions
│   ├── blockchain.service.js   # Read-only smart contract queries (status checks)
│   ├── validation.service.js   # ClamAV scanning, SHA-256/SimHash dedup, calls AI service for content analysis
│   └── eventListener.service.js # Listens to on-chain events, syncs MongoDB
│
├── models/
│   ├── Upload.model.js         # MongoDB schema for upload metadata
│   └── Event.model.js          # MongoDB schema for synced blockchain events
│
├── middleware/
│   ├── auth.middleware.js       # Wallet address validation (format check, not signature verification)
│   ├── upload.middleware.js     # Multer config, file size/type validation
│   └── error.middleware.js     # Global error handler
│
└── tests/
    ├── upload.test.js
    ├── validation.test.js          # File validation pipeline tests
    ├── encryption.test.js
    ├── blockchain.test.js
    └── search.test.js
```

## Environment Variables

```bash
# Server
PORT=3001
NODE_ENV=development

# MongoDB
MONGODB_URI=mongodb://localhost:27017/alexandria

# Blockchain (Base Testnet / Sepolia) — read-only, for event listening and status queries
BASE_TESTNET_RPC_URL=https://sepolia.base.org
TOKEN_CONTRACT_ADDRESS=
LIBRARY_CONTRACT_ADDRESS=
STAKE_CONTRACT_ADDRESS=
RENT_CONTRACT_ADDRESS=
PAYMENT_CONTRACT_ADDRESS=

# Arweave / Irys
IRYS_NODE_URL=https://node2.irys.xyz
IRYS_WALLET_KEY=                    # Dedicated storage wallet, funded by project treasury

# Lit Protocol
LIT_NETWORK=cayenne               # or habanero for production

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
  - Flow: validate → encrypt → store on Arweave → index in MongoDB (status: pending_stake)
  - Returns: { arweaveHash, litEncryptedKeyId }
  - Frontend then handles on-chain staking and registration with returned arweaveHash

GET /api/upload/:arweaveHash
  - Returns: Upload metadata (title, author, status, uploader, timestamp)
```

### Search
```
GET /api/search?q=<query>&category=<cat>&page=<n>
  - Searches MongoDB index
  - Returns: Paginated list of approved uploads matching query
```

### Rental Status
```
GET /api/rental/status/:arweaveHash/:address
  - Checks on-chain rental status
  - Returns: { active: bool, expiryTime: timestamp }
```

### Stake Status
```
GET /api/stake/status/:arweaveHash
  - Checks on-chain stake status
  - Returns: { status: "pending"|"challenged"|"approved"|"rejected", stakeAmount, stakeTime }
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
                              hash already exists in MongoDB
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

### At Upload Time
```javascript
// 1. Generate symmetric key
const symmetricKey = crypto.randomBytes(32);

// 2. Encrypt PDF
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', symmetricKey, iv);
const encryptedPDF = Buffer.concat([cipher.update(pdfBuffer), cipher.final()]);
const authTag = cipher.getAuthTag();

// 3. Upload encrypted PDF + iv + authTag to Arweave via Irys
const arweaveHash = await irys.upload(encryptedPayload);

// 4. Encrypt symmetric key with Lit Protocol
await litClient.saveEncryptionKey({
  accessControlConditions: [{
    contractAddress: RENT_CONTRACT_ADDRESS,
    method: "isRentalActive",
    parameters: [arweaveHash, ":userAddress"],
    returnValueTest: { comparator: "=", value: "true" }
  }],
  symmetricKey: symmetricKey
});

// 5. DISCARD symmetricKey from memory — never store it
```

### Security Rules
- Symmetric keys exist in memory only during the upload transaction
- No unencrypted PDFs written to disk at any point
- Backend has no Ethereum wallet — it never signs on-chain transactions (staking, registration, rentals)
- Backend does have an Irys wallet key (`IRYS_WALLET_KEY`) solely for paying Arweave storage fees
- Upload requests include wallet address as metadata (not cryptographic auth — on-chain staking is the real proof of ownership)
- File uploads validated for size, type, and content before processing

### Irys Wallet Funding Model
- The Irys wallet is a **dedicated, low-privilege storage wallet** — it can only pay for Arweave uploads
- The **project treasury wallet** periodically tops up the Irys wallet with small amounts
- Keep the Irys wallet lightly funded to minimize exposure — if the server is compromised, the attacker can only burn through whatever storage credits are currently loaded
- The treasury wallet stays offline and never touches the backend server
- Monitor Irys wallet balance and alert when it needs a top-up

## MongoDB Schemas

### Upload Document
```javascript
{
  arweaveHash: String,          // Primary identifier, indexed
  title: String,                // Searchable, text-indexed
  author: String,               // Searchable, text-indexed
  category: String,             // Filterable
  description: String,          // Searchable
  uploader: String,             // Wallet address
  uploadTimestamp: Date,
  status: String,               // "pending" | "challenged" | "approved" | "rejected"
  fileSize: Number,             // Bytes
  sha256Hash: String,           // For duplicate detection reference
  simHash: String,              // For near-duplicate detection reference
  litEncryptedKeyId: String,    // Reference to Lit Protocol encrypted key
  onChainTxHash: String         // Transaction hash of on-chain registration
}
```

### Synced Event Document
```javascript
{
  eventName: String,            // e.g., "BookRented", "StakeDeposited"
  arweaveHash: String,
  args: Object,                 // Event arguments
  blockNumber: Number,
  transactionHash: String,
  timestamp: Date
}
```

## Testing Approach

- **Unit tests:** Test encryption service, validation calls, and MongoDB operations in isolation
- **Integration tests:** Test full upload flow with mocked external services (Arweave, Lit)
- **Event listener tests:** Test that on-chain event syncing correctly updates MongoDB
- **Never test with real funds or mainnet contracts**

## Critical Design Constraints

### What the Backend Does
- Orchestrates the upload pipeline (validate → encrypt → store on Arweave → index in MongoDB)
- Returns arweaveHash to frontend for on-chain staking/registration
- Provides search/query API for the frontend
- Listens to on-chain events (read-only) and syncs state to MongoDB
- Generates and encrypts symmetric keys (then discards them)

### What the Backend Does NOT Do
- **Write to the blockchain** — no Ethereum wallet, no on-chain transactions (staking, registration, rentals are all frontend)
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
- **Search index:** MongoDB on the backend server — if the server goes down, search is unavailable (though all data still exists on Arweave and on-chain)
- **Validation:** Backend decides what passes validation — single authority on content quality

### Phase 1: Archivist-Funded Storage
Move Arweave storage costs from the project to the archivists themselves:
- Frontend uploads encrypted PDFs directly to Irys using the archivist's wallet
- Backend only handles validation and Lit Protocol encryption, returns the encrypted blob to the frontend
- Removes `IRYS_WALLET_KEY` from backend entirely — no funded wallets on the server at all
- Archivists pay for storage as part of their upload cost (alongside staking)

### Phase 2: Decentralized Indexing
Replace the centralized MongoDB index:
- Use **The Graph** to index on-chain events (uploads, rentals, challenges) into a decentralized subgraph
- Frontend queries the subgraph directly instead of the backend's `/api/search` endpoint
- On-chain metadata (title, author, category) stored in smart contract events, indexed by The Graph
- MongoDB becomes optional (local cache for performance, not the source of truth)

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
