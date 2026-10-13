const express = require('express');

const { getStorageStatus, getUploadStorage, getUploadData } = require('../controller/storage.controller');

const router = express.Router();

// GET /api/storage/status — storage worker health, wallet balance, pending counts.
// Declared BEFORE /storage/:arweaveHash, or Express would match "status" as a hash.
router.get('/storage/status', getStorageStatus);

// GET /api/storage/:arweaveHash — progress of one upload after the 202.
router.get('/storage/:arweaveHash', getUploadStorage);

// GET /api/storage/:arweaveHash/data — the encrypted book, read from raw nodes
// (proof-checked). The browser cannot read raw nodes itself: they are plain HTTP.
router.get('/storage/:arweaveHash/data', getUploadData);

module.exports = router;
