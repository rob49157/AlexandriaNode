# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context: Alexandria Backend Gateway

This repository contains the **Node.js backend gateway** for Alexandria, a decentralized, censorship-resistant Web3 library designed to preserve human knowledge permanently on Arweave.

The backend is the orchestration layer — it sits between the frontend, smart contracts, AI validation service, and decentralized storage. It never stores unencrypted content and never holds user funds.

### Alexandria System Architecture (Full Stack)
- **Frontend:** React + Vite (user dashboard, in-browser PDF decryption) — `AlexandriaFrontEnd` repo
- **Backend Gateway (THIS REPO):** Node.js + Express (upload orchestration, Lit Protocol encryption, Arweave indexing)
- **AI Validation:** Python + FastAPI (PDF validation, SimHash duplicate detection, malware scanning) — separate service
- **Blockchain:** Base Testnet / Solidity (handles $ALEX token, archivist staking, time-bound rental permissions) — `AlexandriaSmartContract` repo
- **Storage:** Arweave via Irys (permanent encrypted file storage) + MongoDB (off-chain search indexing)

### Backend Responsibilities
This service handles:
- **Upload Orchestration:** Receive PDFs from frontend, run validation, encrypt, store on Arweave, trigger on-chain staking
- **Lit Protocol Encryption:** Encrypt symmetric keys with on-chain access conditions tied to Rent.sol
- **Arweave/Irys Storage:** Upload encrypted PDFs to permanent storage, manage transaction IDs
- **MongoDB Indexing:** Maintain searchable off-chain index of all uploads (title, author, category, arweaveHash, status)
- **Smart Contract Interaction:** Call contract functions for staking, upload registration, and status queries
- **Event Listening:** Monitor on-chain events (uploads, rentals, challenges) and sync to MongoDB

**Critical:** The backend NEVER stores unencrypted PDFs or raw symmetric keys long-term. It generates keys, encrypts, delegates to Lit/Arweave, then discards sensitive material.

## How the Backend Connects to Smart Contracts

The smart contracts (in `AlexandriaSmartContract` repo) define the on-chain logic. This backend calls them at specific points in the workflow:

### Upload Flow (Backend Orchestrates)
```
1. Frontend sends PDF + metadata to backend
2. Backend runs Layer 1 validation: file size, type, magic bytes, parseability
3. Backend runs Layer 2 validation: ClamAV virus scan, embedded JS/attachment detection
4. Backend runs Layer 3 validation: SHA-256 dedup, SimHash near-dedup, text extraction
5. Backend runs Layer 4 validation: metadata sanitization and required field checks
   → ANY failure at steps 2-5 = reject immediately, nothing stored
6. Backend generates symmetric key (crypto.randomBytes(32))
7. Backend encrypts PDF with AES-256-GCM
8. Backend uploads encrypted PDF to Arweave via Irys → gets arweaveHash
9. Backend encrypts symmetric key with Lit Protocol, setting access condition:
   → Lit checks Rent.sol.isRentalActive(arweaveHash, userAddress)
10. Backend calls smart contract: stakeForUpload(arweaveHash, stakeAmount)
11. Backend calls smart contract: registerUpload(arweaveHash, metadata)
12. Backend stores searchable metadata in MongoDB
13. Backend discards symmetric key and unencrypted PDF from memory
```

### Smart Contract Functions the Backend Calls
```
// From token.sol — approve staking contract to spend tokens
token.approve(stakeContractAddress, amount)

// From stake.sol — lock tokens for 14-day validation
stake.stakeForUpload(arweaveHash, amount)

// From library.sol — register upload metadata on-chain
library.registerUpload(arweaveHash, metadata)

// From library.sol — query upload status
library.getUpload(arweaveHash)

// From stake.sol — query stake status
stake.getStakeStatus(arweaveHash)
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

# Blockchain
ethers                   — Smart contract interaction (must match Hardhat's ethers version)

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
crypto                   — Built-in Node.js (AES-256-GCM encryption)
pdf-parse                — PDF parsing, page count, text extraction for validation
file-type                — Detect true file type from magic bytes (not just extension)
sanitize-html            — Strip HTML/script tags from metadata fields
axios                    — HTTP client for AI validation service calls

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
│   ├── blockchain.js           # Ethers.js provider + contract instances
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
│   ├── blockchain.service.js   # Smart contract calls (stake, register, query)
│   ├── validation.service.js   # Calls AI validation Python service
│   └── eventListener.service.js # Listens to on-chain events, syncs MongoDB
│
├── models/
│   ├── Upload.model.js         # MongoDB schema for upload metadata
│   └── Event.model.js          # MongoDB schema for synced blockchain events
│
├── middleware/
│   ├── auth.middleware.js       # Wallet signature verification
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

# Blockchain (Base Testnet / Sepolia)
BASE_TESTNET_RPC_URL=https://sepolia.base.org
BACKEND_WALLET_PRIVATE_KEY=         # Wallet that calls smart contracts
TOKEN_CONTRACT_ADDRESS=
LIBRARY_CONTRACT_ADDRESS=
STAKE_CONTRACT_ADDRESS=
RENT_CONTRACT_ADDRESS=
PAYMENT_CONTRACT_ADDRESS=

# Arweave / Irys
IRYS_NODE_URL=https://node2.irys.xyz
IRYS_WALLET_KEY=                    # Funded wallet for Arweave uploads

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
  - Body: multipart/form-data (PDF file + metadata)
  - Auth: Wallet signature
  - Flow: validate → encrypt → store on Arweave → stake on-chain → index in MongoDB
  - Returns: { arweaveHash, transactionId, stakeStatus }

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

### Layer 2: Security Scanning (Backend + AI Service)
Performed in `validation.service.js` by calling the Python FastAPI validation service:

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

### Layer 3: Content Integrity (AI Validation Service)
Performed by the Python FastAPI service for content-level checks:

```
Check                         Why                                         Action on Fail
─────────────────────────────────────────────────────────────────────────────────────────
SHA-256 hash                  Exact duplicate detection — reject if       Reject with 409
                              hash already exists in MongoDB
SimHash fingerprint           Near-duplicate detection — flag if          Flag for librarian
                              similarity score > threshold                review
OCR/text extraction check     Verify PDF contains actual readable         Flag if no text
                              content (not blank or image-only spam)      (may be valid scan)
Page content analysis         Detect gibberish, auto-generated filler,    Flag for review
                              or non-book content
```

### Layer 4: Metadata Validation (Backend)
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
│ Layer 2: Security Scan   │  ← Calls AI Validation Service
│ ClamAV, embedded JS,     │
│ auto-actions, attachments│
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ Layer 3: Content Check   │  ← Calls AI Validation Service
│ SHA-256 dedup, SimHash,  │
│ OCR/text extraction      │
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ Layer 4: Metadata Check  │  ← In-process
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
- **Fail fast:** Checks run in order from cheapest to most expensive. File size/type checks happen before ClamAV, which happens before SimHash.
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
- Backend wallet private key stored in .env, never committed
- All user-facing endpoints verify wallet signatures
- File uploads validated for size, type, and content before processing

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
- **Integration tests:** Test full upload flow with mocked external services (Arweave, Lit, blockchain)
- **Contract interaction tests:** Use Hardhat local node to test real contract calls from the backend
- **Never test with real funds or mainnet contracts**

## Critical Design Constraints

### What the Backend Does
- Orchestrates the upload pipeline (validate → encrypt → store → stake → index)
- Provides search/query API for the frontend
- Listens to on-chain events and syncs state to MongoDB
- Generates and encrypts symmetric keys (then discards them)

### What the Backend Does NOT Do
- Store unencrypted PDFs or symmetric keys
- Handle rental payments (frontend calls smart contracts directly)
- Make access control decisions (Lit Protocol reads Rent.sol directly)
- Run AI validation itself (delegates to separate Python FastAPI service)
- Manage user wallets or private keys (users sign transactions in their browser)

### Relationship to Other Repos
- **AlexandriaSmartContract:** Backend needs contract ABIs and deployed addresses to call functions and listen to events. ABIs are generated by `npx hardhat compile` in that repo.
- **AlexandriaFrontEnd:** Frontend calls this backend's REST API for uploads and search. Frontend calls smart contracts directly for rentals and payments.
- **AI Validation Service:** Backend calls this via HTTP (POST /validate with PDF) and receives validation results (pass/fail, SHA-256, SimHash).
