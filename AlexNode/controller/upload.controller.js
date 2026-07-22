const { validateUpload } = require('../services/validation.service');

// POST /api/upload
// Orchestration entry point for the upload pipeline.
// Phase 2: runs Layer 1 (file basics) + Layer 5 (metadata) validation.
// Later phases add encryption (3), dedup (4), and Arweave/Postgres (5).
async function createUpload(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        valid: false,
        stage: 'file_basics',
        reason: 'missing_file',
        message: 'No PDF file received. Send it as multipart/form-data under the "file" field.',
      });
    }

    // Layers 1 + 5. Returns the first failing check, or a success object with
    // sanitized metadata + page count.
    const result = await validateUpload(req.file, req.body);
    if (!result.valid) {
      const { httpStatus = 400, valid, stage, reason, message } = result;
      return res.status(httpStatus).json({ valid, stage, reason, message });
    }

    // TODO Phase 3: Lit encryptFile.
    // TODO Phase 4: SHA-256 / SimHash dedup.
    // TODO Phase 5: Irys upload + Postgres persist, then return { arweaveHash, litEncryptedKeyId }.
    return res.status(202).json({
      valid: true,
      received: true,
      pageCount: result.pageCount,
      file: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
      },
      metadata: result.metadata,
      walletAddress: req.walletAddress,
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
