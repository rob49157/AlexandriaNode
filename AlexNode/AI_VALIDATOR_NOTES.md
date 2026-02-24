# Alexandria AI Validator — Planning Notes

This will be its own repo (`AlexandriaAI` or similar). Python + FastAPI service that the Node backend calls via HTTP.

---

## Two Tiers of Validation

### Tier 1: Upload-Time Checks (Blocking)
Called synchronously by the Node backend at upload time. Must pass before encryption/storage.

- **ClamAV virus/malware scan** — reject infected files
- **SHA-256 exact duplicate** — reject if hash already exists in the library
- **SimHash near-duplicate** — flag if fingerprint similarity exceeds threshold
- **PDF security scan** — embedded JS, auto-actions, hidden attachments
- **File integrity** — valid PDF structure, not corrupted/truncated

**Latency target:** These need to be fast (seconds). They block the upload flow.

---

### Tier 2: AI Librarian (Async, During 14-Day Window)
Runs in the background after an upload is accepted. Monitors pending uploads and performs deeper analysis. Can auto-flag suspicious uploads by calling `challengeUpload()` on the smart contract.

#### Semantic Duplicate Detection
- Extract full text from PDF (OCR for scanned books, direct extraction for digital)
- Generate text embeddings (sentence-transformers or similar)
- Compare against vector database of all existing library content
- Flag if semantic similarity score exceeds threshold (catches same book different formatting, different editions, plagiarized rewrites, translated copies)

#### Content Quality Analysis
- Is this a real book or auto-generated filler/garbage?
- Does it contain meaningful, coherent text?
- Quality score based on readability, structure, chapter organization

#### Metadata Verification
- Extract title/author from PDF content (title page, copyright page)
- Compare against archivist-supplied metadata
- Flag mismatches (wrong title, wrong author, intentional mislabeling)

#### Language Detection
- Detect actual language(s) of the content
- Verify it matches the declared language in metadata

#### Category Verification
- Classify the book's actual subject matter
- Compare against archivist-declared category
- Flag if the content doesn't match (e.g., labeled "Science" but it's fiction)

#### Completeness Check
- Does this look like a full book? Or just a few chapters/excerpt?
- Check for abrupt endings, missing pages, table of contents vs actual content
- Flag suspiciously short uploads relative to declared content

---

## Architecture Decisions Needed

- [ ] **Vector database choice** for semantic search — Pinecone, Weaviate, ChromaDB, pgvector?
- [ ] **Embedding model** — sentence-transformers (local), OpenAI embeddings, or Cohere?
- [ ] **OCR engine** — Tesseract (free) vs cloud OCR (Google Vision, AWS Textract)?
- [ ] **Similarity thresholds** — what SimHash and semantic similarity scores trigger flags vs auto-reject?
- [ ] **AI Librarian authority level:**
  - Can it auto-reject? Or only flag for human librarian review?
  - Should it call `challengeUpload()` directly, or just update a status in MongoDB for human librarians to act on?
- [ ] **GPU requirements** — embedding generation and OCR may need GPU. Cloud vs self-hosted?
- [ ] **Processing queue** — how does Tier 2 pick up new uploads? Poll MongoDB? Listen to on-chain events? Message queue (Redis/RabbitMQ)?
- [ ] **Cost per upload** — embedding generation + vector search + OCR has real compute cost. Factor into staking economics?

---

## Tech Stack (Expected)

```
Python 3.11+
FastAPI                     — HTTP API framework
uvicorn                     — ASGI server
pyclamd                     — ClamAV integration
PyPDF2 / pdfplumber         — PDF text extraction
pytesseract                 — OCR for scanned PDFs
sentence-transformers       — Text embedding generation
faiss / chromadb            — Vector similarity search (or hosted: Pinecone)
simhash                     — Near-duplicate fingerprinting
langdetect / fasttext       — Language detection
ethers.py / web3.py         — Smart contract interaction (for challengeUpload)
celery / rq                 — Background task queue for Tier 2 async processing
redis                       — Queue broker + caching
```

---

## API Endpoints (Called by Node Backend)

### Tier 1 (Synchronous)
```
POST /api/validate/upload
  - Body: PDF file + metadata
  - Returns: { valid: bool, sha256, simHash, threats[], flags[] }
  - Latency: < 10 seconds
```

### Tier 2 (Async — triggers background job)
```
POST /api/validate/deep-analysis
  - Body: { arweaveHash, mongoUploadId }
  - Returns: { jobId } (immediate acknowledgment)
  - Processing happens in background worker

GET /api/validate/deep-analysis/:jobId
  - Returns: { status, results: { semanticDuplicates[], qualityScore, metadataMatch, language, category, completeness } }
```

---

## How It Connects to Smart Contracts

The AI Librarian (Tier 2) needs a funded wallet to call `challengeUpload()` on the Stake contract when it finds problems. This means:
- The AI service needs `STAKE_CONTRACT_ADDRESS` and a private key
- It acts as an authorized librarian on-chain
- Its wallet address must be registered as a librarian in the smart contract
- Challenge reason should include which check failed (e.g., "semantic_duplicate:0.94_similarity_with:<arweaveHash>")

---

## Relationship to Other Repos

- **AlexandriaNode** calls Tier 1 synchronously during upload, triggers Tier 2 async after upload succeeds
- **AlexandriaSmartContract** — AI Librarian calls `challengeUpload()` and needs contract ABIs
- **AlexandriaFrontEnd** — no direct interaction (frontend doesn't talk to AI service)
