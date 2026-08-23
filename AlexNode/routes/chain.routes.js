const express = require('express');

const { getChainStatus } = require('../controller/chain.controller');

const router = express.Router();

// GET /api/chain/status
// Event listener health: cursor position, distance from head, last error.
// Returns 503 when the listener is stopped or its last sync failed.
router.get('/chain/status', getChainStatus);

module.exports = router;
