const express = require('express');

const { uploadSinglePdf } = require('../middleware/upload.middleware');
const { requireWalletAddress } = require('../middleware/auth.middleware');
const {
  createUpload,
  getUpload,
  retryRegistration,
  getRegistrarStatus,
} = require('../controller/upload.controller');

const router = express.Router();

// POST /api/upload — multipart/form-data (PDF under "file" + metadata fields)
// Order matters: multer parses the body first, then wallet-format check, then controller.
router.post('/upload', uploadSinglePdf, requireWalletAddress, createUpload);

// GET /api/upload/registrar/status — can the backend register on-chain at all?
// Declared BEFORE /upload/:arweaveHash, or Express would match "registrar" as a
// hash and answer 400 instead.
router.get('/upload/registrar/status', getRegistrarStatus);

// GET /api/upload/:arweaveHash — metadata lookup
router.get('/upload/:arweaveHash', getUpload);

// POST /api/upload/:arweaveHash/register — retry on-chain registration for an
// upload that is stored and indexed but never reached the library contract.
router.post('/upload/:arweaveHash/register', retryRegistration);

module.exports = router;
