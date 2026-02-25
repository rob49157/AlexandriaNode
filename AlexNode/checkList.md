# Alexandria Project Checklist

## Smart Contracts (AlexandriaSmartContract)

### token.sol — $ALEX ERC20 Token
- [ ] Standard ERC20 implementation (transfer, approve, balanceOf, etc.)
- [ ] Mintable/burnable functionality (if tokenomics require)
- [ ] Stake contract approval integration
- [ ] Unit tests for all token functions
- [ ] Hardhat Ignition deployment module

### library.sol — Central Upload Registry
- [ ] `registerUpload(arweaveHash, metadata)` — record upload on-chain
- [ ] `getUpload(arweaveHash)` — query upload metadata
- [ ] Upload status tracking (pending → challenged → approved → rejected)
- [ ] Emit `UploadRegistered` event
- [ ] Emit `UploadStatusChanged` event
- [ ] Unit tests for registration and status transitions
- [ ] Hardhat Ignition deployment module

### stake.sol — Upload Staking & Validation
- [ ] `stakeForUpload(arweaveHash, amount)` — lock tokens for 14-day validation
- [ ] `getStakeStatus(arweaveHash)` — query stake state
- [ ] `releaseStake(arweaveHash)` — return stake + reward after 14 days if valid
- [ ] `slashStake(arweaveHash)` — penalize invalid uploads
- [ ] `challengeUpload(arweaveHash, reason)` — librarian flags suspicious content
- [ ] `resolveChallenge(arweaveHash, approved)` — admin/DAO resolves disputes
- [ ] 14-day minimum lock period enforced via `block.timestamp`
- [ ] Auto-approval logic if no challenges by day 14
- [ ] Minimum stake amount requirement
- [ ] Reentrancy protection on all stake/withdraw functions
- [ ] Emit `StakeDeposited` event
- [ ] Emit `StakeReleased` event
- [ ] Emit `StakeSlashed` event
- [ ] Emit `UploadChallenged` event
- [ ] Emit `ChallengeResolved` event
- [ ] Unit tests for full staking lifecycle
- [ ] Unit tests for challenge/resolve flow
- [ ] Unit tests for time-based transitions (use `time.increaseTo`)
- [ ] Hardhat Ignition deployment module

### Rent.sol — Time-Bound Rental Permissions
- [ ] `rentBook(arweaveHash, duration)` — record rental with expiry timestamp
- [ ] `isRentalActive(arweaveHash, renter)` — returns bool (Lit Protocol calls this)
- [ ] Time-bound expiry enforced via `block.timestamp`
- [ ] Blacklist support (optional — ban addresses caught leaking)
- [ ] Emit `BookRented` event
- [ ] Unit tests for rental creation and expiry
- [ ] Unit tests for `isRentalActive` with active/expired/blacklisted cases
- [ ] Hardhat Ignition deployment module

### payment.sol — Revenue Distribution
- [ ] Receive and split rental payments (archivist / protocol treasury / librarian pool)
- [ ] Upload reward distribution to successful archivists
- [ ] `claimLibrarianRewards()` — librarians withdraw accumulated rewards
- [ ] Percentage splits sum to 100% validation
- [ ] Rounding error protection in revenue distribution
- [ ] Reentrancy protection on all payment functions
- [ ] Checks-effects-interactions pattern on all transfers
- [ ] Unit tests for payment splitting
- [ ] Unit tests for reward claims
- [ ] Hardhat Ignition deployment module

### Smart Contract Integration
- [ ] All 5 contracts compile cleanly (`npx hardhat compile`)
- [ ] All tests pass (`npx hardhat test`)
- [ ] Gas reporting reviewed (`REPORT_GAS=true npx hardhat test`)
- [ ] Contracts deployed to local Hardhat node for integration testing
- [ ] Contracts deployed to Base Sepolia testnet
- [ ] Contract ABIs exported for backend and frontend consumption
- [ ] Deployed addresses documented

---

## Backend — Node.js Gateway (AlexNode)

### Project Setup
- [ ] `npm init` with CommonJS module system
- [ ] Install all dependencies (express, dotenv, cors, helmet, mongoose, etc.)
- [ ] `.env.example` with all required environment variables
- [ ] `.gitignore` (node_modules, .env, temp files)
- [ ] `index.js` entry point with Express server startup
- [ ] `npm run dev` script (nodemon)
- [ ] `npm start` script (production)
- [ ] `npm test` script (jest or mocha)

### Config Layer
- [ ] `config/db.js` — MongoDB connection setup
- [ ] `config/blockchain.js` — Ethers.js read-only provider + contract instances (no signer)
- [ ] `config/irys.js` — Irys client configuration with `IRYS_WALLET_KEY`
- [ ] `config/lit.js` — Lit Protocol client setup

### MongoDB Models
- [ ] `models/Upload.model.js` — Upload document schema
  - [ ] arweaveHash (indexed)
  - [ ] title, author, description (text-indexed for search)
  - [ ] category (filterable)
  - [ ] uploader (wallet address)
  - [ ] uploadTimestamp
  - [ ] status (pending_stake / pending / challenged / approved / rejected)
  - [ ] fileSize, sha256Hash, simHash
  - [ ] litEncryptedKeyId
  - [ ] onChainTxHash
- [ ] `models/Event.model.js` — Synced blockchain event schema
  - [ ] eventName, arweaveHash, args, blockNumber, transactionHash, timestamp

### Middleware
- [ ] `middleware/auth.middleware.js` — Wallet signature verification
- [ ] `middleware/upload.middleware.js` — Multer config, file size/type validation
- [ ] `middleware/error.middleware.js` — Global error handler

### Validation Pipeline (validation.service.js)

#### Layer 1: Basic File Validation (in-process)
- [ ] File size limit check (MAX_FILE_SIZE_MB)
- [ ] File extension check (.pdf only)
- [ ] MIME type check (application/pdf)
- [ ] Magic bytes verification (first 5 bytes = "%PDF-")
- [ ] PDF parseability check (pdf-parse)
- [ ] Page count check (reject 0 pages)

#### Layer 2: Security Scanning (in-process)
- [ ] ClamAV virus scan integration (clamscan npm package)
- [ ] Embedded JavaScript detection
- [ ] Embedded file/attachment detection
- [ ] Auto-action detection (/OpenAction, /AA, /Launch)
- [ ] External link/URI scanning
- [ ] Form/XFA detection
- [ ] Encrypted/password-protected PDF detection

#### Layer 3: Deduplication (in-process)
- [ ] SHA-256 hash computation (built-in crypto)
- [ ] SHA-256 duplicate check against MongoDB
- [ ] SimHash fingerprint computation (simhash-js)
- [ ] SimHash near-duplicate similarity check

#### Layer 4: Content Quality Analysis (AI service call)
- [ ] HTTP call to Python FastAPI service (POST /analyze)
- [ ] Handle OCR/text extraction results
- [ ] Handle content quality scoring results
- [ ] Handle service unavailable / timeout errors

#### Layer 5: Metadata Validation (in-process)
- [ ] Title present and reasonable length
- [ ] Author present
- [ ] Category from allowed list
- [ ] Description min/max length check
- [ ] Sanitize all text fields (sanitize-html — strip HTML, script tags, control chars)

### Encryption Service (encryption.service.js)
- [ ] `generateKey()` — crypto.randomBytes(32)
- [ ] `encryptPDF(pdfBuffer, key)` — AES-256-GCM with random IV + auth tag
- [ ] `decryptPDF(encryptedPayload, key)` — for testing only
- [ ] Key discarded from memory after use

### Arweave Service (arweave.service.js)
- [ ] Irys client initialization with `IRYS_WALLET_KEY`
- [ ] `uploadEncryptedPDF(encryptedPayload)` — upload to Arweave, return arweaveHash
- [ ] Handle upload failures and retries
- [ ] Monitor Irys wallet balance

### Lit Protocol Service (lit.service.js)
- [ ] Lit client initialization
- [ ] `encryptKey(symmetricKey, arweaveHash)` — encrypt with Rent.sol access conditions
- [ ] Access condition: `Rent.sol.isRentalActive(arweaveHash, :userAddress) == true`
- [ ] Return litEncryptedKeyId

### Blockchain Service (blockchain.service.js) — READ-ONLY
- [ ] Read-only provider connection (no signer)
- [ ] `getUploadStatus(arweaveHash)` — query library.sol
- [ ] `getStakeStatus(arweaveHash)` — query stake.sol
- [ ] `getRentalStatus(arweaveHash, address)` — query Rent.sol

### Event Listener Service (eventListener.service.js)
- [ ] Listen for `UploadRegistered` events → update MongoDB
- [ ] Listen for `UploadStatusChanged` events → update MongoDB
- [ ] Listen for `StakeDeposited` events → update MongoDB
- [ ] Listen for `StakeReleased` events → update MongoDB
- [ ] Listen for `StakeSlashed` events → update MongoDB
- [ ] Listen for `BookRented` events → update MongoDB
- [ ] Listen for `UploadChallenged` events → update MongoDB
- [ ] Listen for `ChallengeResolved` events → update MongoDB
- [ ] Handle reconnection on provider disconnect
- [ ] Store last processed block number (avoid reprocessing)

### Routes & Controllers

#### Upload
- [ ] `POST /api/upload` — full upload pipeline (validate → encrypt → Arweave → Lit → MongoDB)
  - [ ] Accept multipart/form-data (PDF + metadata)
  - [ ] Verify wallet signature (auth middleware)
  - [ ] Run 5-layer validation
  - [ ] Encrypt PDF
  - [ ] Upload to Arweave
  - [ ] Encrypt key with Lit Protocol
  - [ ] Save to MongoDB (status: pending_stake)
  - [ ] Return `{ arweaveHash, litEncryptedKeyId }`
  - [ ] Discard symmetric key and unencrypted PDF from memory
- [ ] `GET /api/upload/:arweaveHash` — return upload metadata from MongoDB

#### Search
- [ ] `GET /api/search` — search MongoDB index
  - [ ] Query parameter (`q`)
  - [ ] Category filter
  - [ ] Pagination (page, limit)
  - [ ] Only return approved uploads

#### Rental Status
- [ ] `GET /api/rental/status/:arweaveHash/:address` — query on-chain rental status

#### Stake Status
- [ ] `GET /api/stake/status/:arweaveHash` — query on-chain stake status

### Backend Tests
- [ ] Unit tests: encryption service (encrypt/decrypt roundtrip)
- [ ] Unit tests: validation pipeline (each layer independently)
- [ ] Unit tests: MongoDB operations (CRUD)
- [ ] Integration tests: full upload flow with mocked Arweave/Lit
- [ ] Event listener tests: on-chain events correctly update MongoDB
- [ ] API tests: all endpoints return expected responses

### Logging & Error Handling
- [ ] All validation rejections logged (reason, uploader address, timestamp)
- [ ] Arweave upload failures logged
- [ ] Lit Protocol errors logged
- [ ] Global error handler returns consistent error format

---

## AI Validation Service (Python / FastAPI)

- [ ] FastAPI project setup
- [ ] `POST /analyze` endpoint — accept PDF file
- [ ] OCR / text extraction (verify PDF contains readable content)
- [ ] Page content analysis (detect gibberish, auto-generated filler)
- [ ] Language/quality scoring
- [ ] Return structured response (pass/fail, flags, scores)
- [ ] Handle malformed/corrupt PDFs gracefully
- [ ] Health check endpoint
- [ ] Unit tests

---

## Frontend (AlexandriaFrontEnd)

### Wallet & Auth
- [ ] Wallet connection (MetaMask or similar)
- [ ] Wallet signature generation for backend API auth

### Upload Flow (Archivist)
- [ ] PDF file selection + metadata form (title, author, category, description)
- [ ] Send PDF + metadata to backend `POST /api/upload`
- [ ] Receive `{ arweaveHash, litEncryptedKeyId }` from backend
- [ ] Call `token.approve(stakeContractAddress, stakeAmount)` — user signs
- [ ] Call `stake.stakeForUpload(arweaveHash, stakeAmount)` — user signs
- [ ] Call `library.registerUpload(arweaveHash, metadata)` — user signs
- [ ] Display upload status and confirmation
- [ ] Handle retry if user closes browser between backend response and on-chain registration

### Search & Browse
- [ ] Search bar calling `GET /api/search`
- [ ] Category filtering
- [ ] Paginated results display
- [ ] Upload detail view (`GET /api/upload/:arweaveHash`)

### Rental Flow (Reader)
- [ ] Call `rent.rentBook(arweaveHash, duration)` — user signs + pays $ALEX
- [ ] Payment automatically split by payment.sol on-chain
- [ ] Display rental confirmation and expiry countdown

### PDF Decryption & Viewing
- [ ] Download encrypted PDF from Arweave (direct fetch)
- [ ] Request decryption key from Lit Protocol (Lit checks `isRentalActive` on-chain)
- [ ] Decrypt PDF in browser memory (AES-256-GCM)
- [ ] Watermark PDF before display (wallet address, rental date, expiry date, tx hash)
- [ ] Display in PDF viewer
- [ ] Never write decrypted PDF to localStorage or disk
- [ ] Clear decrypted content from memory on page close or rental expiry

### Librarian Dashboard
- [ ] View pending uploads flagged for review
- [ ] Call `stake.challengeUpload(arweaveHash, reason)` — librarian signs
- [ ] View challenge resolution status
- [ ] Call `claimLibrarianRewards()` — withdraw accumulated rewards

### Archivist Dashboard
- [ ] View own uploads and their statuses (pending, approved, challenged, rejected)
- [ ] View stake status and countdown to release
- [ ] View rental revenue earned

---

## Infrastructure & DevOps

### Development Environment
- [ ] Node.js v18+ installed (nvm)
- [ ] MongoDB running locally (or Atlas connection)
- [ ] ClamAV installed locally for virus scanning
- [ ] Hardhat local node available for contract testing
- [ ] Python environment for AI validation service

### Environment Variables
- [ ] Backend `.env` configured (PORT, MONGODB_URI, RPC URL, contract addresses, Irys key, Lit network, validation service URL)
- [ ] Contract addresses updated after each deployment
- [ ] ABIs copied from smart contract repo after compilation

### Irys Wallet Management
- [ ] Dedicated Irys wallet created (separate from treasury/deployer)
- [ ] Irys wallet funded by project treasury
- [ ] Keep lightly funded to minimize exposure
- [ ] Balance monitoring and low-balance alerts

### Deployment
- [ ] Smart contracts deployed to Base Sepolia testnet
- [ ] Backend deployed (server, MongoDB, ClamAV)
- [ ] AI validation service deployed
- [ ] Frontend deployed (static hosting)
- [ ] All services can communicate (backend ↔ AI service, frontend ↔ backend, frontend ↔ contracts)

---

## Decentralization Roadmap (Post-PoC)

### Phase 1: Archivist-Funded Storage
- [ ] Frontend uploads encrypted PDFs directly to Irys using archivist's wallet
- [ ] Backend only validates + encrypts, returns encrypted blob to frontend
- [ ] Remove `IRYS_WALLET_KEY` from backend

### Phase 2: Decentralized Indexing
- [ ] Deploy subgraph on The Graph for on-chain event indexing
- [ ] Frontend queries subgraph directly for search
- [ ] MongoDB becomes optional cache

### Phase 3: Distributed Validation
- [ ] Multiple independent validation nodes
- [ ] Consensus mechanism (2-of-3 validators agree)
- [ ] Validator staking for participation

### Phase 4: Fully Decentralized Upload
- [ ] Full upload pipeline runs in frontend / validator network
- [ ] Lit Protocol encryption in-browser
- [ ] Backend server becomes optional
