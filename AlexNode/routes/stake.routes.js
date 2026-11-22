const express = require('express');

const { getStakeStatusForHash, getArchivistUploads } = require('../controller/stake.controller');

const router = express.Router();

// GET /api/stake/status/:arweaveHash
// On-chain stake + challenge state, joined against the Postgres index.
router.get('/stake/status/:arweaveHash', getStakeStatusForHash);

// GET /api/stake/archivist/:address
// One wallet's uploads with their stake state, and whether each can be
// published now (unstake() after an unchallenged 14-day window).
router.get('/stake/archivist/:address', getArchivistUploads);

module.exports = router;
