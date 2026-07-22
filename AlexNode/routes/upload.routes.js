const express = require('express');

const { uploadSinglePdf } = require('../middleware/upload.middleware');
const { createUpload, getUpload } = require('../controller/upload.controller');

const router = express.Router();

// POST /api/upload — multipart/form-data (PDF under "file" + metadata fields)
router.post('/upload', uploadSinglePdf, createUpload);

// GET /api/upload/:arweaveHash — metadata lookup
router.get('/upload/:arweaveHash', getUpload);

module.exports = router;
