const { MAX_FILE_SIZE_MB } = require('../middleware/upload.middleware');

// POST /api/upload
// Orchestration entry point for the upload pipeline. For Phase 1 this just
// confirms the file + metadata reached the controller. Real validation (Layers
// 1-5), encryption, Arweave storage, and Postgres persistence land in later phases.
async function createUpload(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        valid: false,
        stage: 'file_upload',
        reason: 'missing_file',
        message: 'No PDF file received. Send it as multipart/form-data under the "file" field.',
      });
    }

    const { title, author, category, description, walletAddress } = req.body;

    // TODO Phase 2: run validation.service Layer 1 + Layer 5 here.
    // TODO Phase 3: Lit encryptFile.
    // TODO Phase 4: SHA-256 / SimHash dedup.
    // TODO Phase 5: Irys upload + Postgres persist, then return { arweaveHash, litEncryptedKeyId }.
    const stubValidation = { valid: true, stage: null, reason: null, message: 'stub: validation not yet implemented' };

    return res.status(202).json({
      received: true,
      validation: stubValidation,
      file: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        maxSizeMb: MAX_FILE_SIZE_MB,
      },
      metadata: { title, author, category, description, walletAddress },
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/upload/:arweaveHash
// Metadata lookup. Real implementation queries Postgres (Phase 6). Stubbed for now.
async function getUpload(req, res, next) {
  try {
    const { arweaveHash } = req.params;
    return res.status(501).json({
      message: 'Not implemented yet — upload metadata lookup lands in Phase 6.',
      arweaveHash,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { createUpload, getUpload };
