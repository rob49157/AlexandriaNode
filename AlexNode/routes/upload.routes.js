const express = require('express');

const { uploadSinglePdf } = require('../middleware/upload.middleware');
const { requireWalletAddress } = require('../middleware/auth.middleware');
const { createUpload, getUpload } = require('../controller/upload.controller');

const router = express.Router();

// POST /api/upload — multipart/form-data (PDF under "file" + metadata fields)
// Order matters: multer parses the body first, then wallet-format check, then controller.
router.post('/upload', uploadSinglePdf, requireWalletAddress, createUpload);

// GET /api/upload/:arweaveHash — metadata lookup
router.get('/upload/:arweaveHash', getUpload);

module.exports = router;
