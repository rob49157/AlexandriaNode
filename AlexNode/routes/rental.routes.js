const express = require('express');

const {
  getRentalStatus,
  getDecryptParams,
  getBookRentalInfo,
} = require('../controller/rental.controller');

const router = express.Router();

// GET /api/rental/status/:arweaveHash/:address
// Live rental permission for one reader, read from Rent.sol.
router.get('/rental/status/:arweaveHash/:address', getRentalStatus);

// GET /api/rental/book/:arweaveHash
// Price, delisting, and whether the book is rentable at all.
router.get('/rental/book/:arweaveHash', getBookRentalInfo);

// GET /api/rental/decrypt-params/:arweaveHash/:address
// Rental-gated. Serves the sealed key envelope + AES-GCM parameters.
//
// The gate here is defense in depth, not the security boundary — `address` is
// unauthenticated, and the real check happens inside the Lit Action against the
// arweaveHash sealed in the ciphertext. See the comment on getDecryptParams.
router.get('/rental/decrypt-params/:arweaveHash/:address', getDecryptParams);

module.exports = router;
