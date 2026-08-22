const express = require('express');

const { search } = require('../controller/search.controller');

const router = express.Router();

// GET /api/search?q=&category=&status=&page=&limit=
// Public catalogue search over the Postgres index. No auth — the index holds
// only metadata, and the files themselves are gated by Lit at decryption time.
router.get('/search', search);

module.exports = router;
