const express = require('express');

const {
	getReviewQueue,
	getChallengeReviews,
	submitChallengeReview,
} = require('../controller/librarian.controller');

const router = express.Router();

// GET /api/librarian/review-queue?librarian=&limit=
// Books that are registered, actively staked, unchallenged and still inside the
// challenge window — i.e. the ones stake.challengeUpload() will accept.
router.get('/librarian/review-queue', getReviewQueue);
router.get('/librarian/challenges', getChallengeReviews);
router.post('/librarian/challenges/:arweaveHash/reviews', submitChallengeReview);

module.exports = router;
