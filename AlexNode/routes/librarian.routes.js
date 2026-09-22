const express = require('express');

const { getReviewQueue } = require('../controller/librarian.controller');

const router = express.Router();

// GET /api/librarian/review-queue?librarian=&limit=
// Books that are registered, actively staked, unchallenged and still inside the
// challenge window — i.e. the ones stake.challengeUpload() will accept.
router.get('/librarian/review-queue', getReviewQueue);

module.exports = router;
