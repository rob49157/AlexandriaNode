const express = require('express');

const { getStakeStatusForHash } = require('../controller/stake.controller');

const router = express.Router();

// GET /api/stake/status/:arweaveHash
// On-chain stake + challenge state, joined against the Postgres index.
router.get('/stake/status/:arweaveHash', getStakeStatusForHash);

module.exports = router;
