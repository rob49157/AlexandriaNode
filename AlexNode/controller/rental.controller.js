// Rental status + the rental-gated decryption payload.
//
// Both endpoints read live on-chain state through services/blockchain.service.
// Nothing here is authoritative: Rent.sol owns rental permission, and the Lit
// Action owns whether a key is ever released. See getDecryptParams below for
// why that distinction is what makes this route safe to serve.

const prisma = require('../config/db');
const { isValidArweaveHash } = require('./arweave');
const { isValidWalletAddress } = require('../middleware/auth.middleware');
const { isRentalActive, getBookRental, getUploadOnChain, ChainError } = require('../services/blockchain.service');

function badRequest(res, reason, message) {
  return res.status(400).json({ error: reason, message });
}

/**
 * Validate the two path params every route here takes.
 * @returns {{ arweaveHash: string, address: string }|null} null after responding
 */
function readParams(req, res, { requireAddress = true } = {}) {
  const { arweaveHash, address } = req.params;

  if (!isValidArweaveHash(arweaveHash)) {
    badRequest(res, 'invalid_hash', 'arweaveHash must be a 43-character base64url transaction ID.');
    return null;
  }

  if (requireAddress && !isValidWalletAddress(address)) {
    badRequest(res, 'invalid_address', 'address must be a valid Ethereum address.');
    return null;
  }

  return { arweaveHash, address };
}

/** Turn a ChainError into its intended HTTP response; re-throw anything else. */
function handleChainError(err, res, next) {
  if (err instanceof ChainError) {
    return res.status(err.status).json({
      error: err.reason,
      message: err.message,
    });
  }
  return next(err);
}

// GET /api/rental/status/:arweaveHash/:address
//
// Live rental permission for one reader on one book, straight from Rent.sol.
// Deliberately not cached — a rental expires on a wall-clock timestamp, and a
// cached "active" is a cached authorization.
async function getRentalStatus(req, res, next) {
  const params = readParams(req, res);
  if (!params) return undefined;

  try {
    const [rental, book] = await Promise.all([
      isRentalActive(params.arweaveHash, params.address),
      getBookRental(params.arweaveHash),
    ]);

    // `available: false` means the Rent contract is paused, so its own
    // permission check reverts rather than answering. Reported as 503 with
    // active:false — the caller must fail closed, but must not cache this as a
    // settled "no".
    const status = rental.available === false ? 503 : 200;

    return res.status(status).json({
      arweaveHash: params.arweaveHash,
      address: params.address,
      active: rental.active,
      expiry: rental.expiry,
      expiryUnix: rental.expiryUnix,
      blacklisted: rental.blacklisted,
      available: rental.available !== false,
      reason: rental.reason,
      book: {
        pricePerDay: book.pricePerDay,
        pricePerDayAlex: book.pricePerDayAlex,
        priceSet: book.priceSet,
        delisted: book.delisted,
      },
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// GET /api/rental/decrypt-params/:arweaveHash/:address
//
// Serves the material the frontend needs to attempt decryption: the sealed
// symmetric key, Lit's integrity hash for it, and the AES-GCM IV + auth tag.
//
// ─── What actually protects the book ─────────────────────────────────────────
//
// Not this endpoint. The key is sealed inside a Lit PKP envelope, and it is
// released only by a Lit Action running in a TEE, which re-checks
// Rent.isRentalActive() against the arweaveHash sealed *inside* the ciphertext.
// Everything served here is inert without that release: the ciphertext of a key
// nobody can open, plus an IV and an auth tag that are already public in the
// Arweave tags.
//
// ⚠️ The rental check below is therefore defense in depth, and it is only as
// strong as the address it is handed. `address` is a path parameter with no
// signature behind it, so anyone can name a wallet that holds a valid rental and
// be served this payload. That is an accepted PoC tradeoff *only* because the
// Lit Action is the real gate — it would not be acceptable if this route ever
// returned a usable key.
//
// The fix, when it is worth building: require a signed SIWE-style message over
// a server-issued nonce and recover the address from the signature instead of
// reading it from the URL. That is the same upgrade auth.middleware.js needs.
//
// ⚠️ Archivists cannot rent their own books — Rent.rentBook() rejects
// `getUploader(hash) == msg.sender` outright. So the uploader is allowed through
// here explicitly. The decryption Lit Action needs the same carve-out, or an
// archivist will be unable to open the book they uploaded. See KEY-BINDING.md.
async function getDecryptParams(req, res, next) {
  const params = readParams(req, res);
  if (!params) return undefined;

  try {
    const row = await prisma.upload.findUnique({
      where: { arweaveHash: params.arweaveHash },
      select: {
        arweaveHash: true,
        uploader: true,
        status: true,
        litEncryptedKeyId: true,
        litDataToEncryptHash: true,
        encryptionIv: true,
        encryptionAuthTag: true,
      },
    });

    if (!row) {
      return res.status(404).json({
        error: 'not_found',
        message: `No upload indexed for ${params.arweaveHash}.`,
      });
    }

    const requester = params.address.toLowerCase();
    const isUploader = row.uploader && row.uploader.toLowerCase() === requester;

    let rental = null;
    if (!isUploader) {
      rental = await isRentalActive(params.arweaveHash, params.address);

      if (rental.available === false) {
        return res.status(503).json({
          error: 'rent_contract_paused',
          message: 'Rental permission cannot be checked right now — the Rent contract is paused.',
        });
      }

      if (!rental.active) {
        return res.status(403).json({
          error: 'no_active_rental',
          message: rental.blacklisted
            ? 'This address is blacklisted from renting.'
            : 'No active rental for this address. Rent the book on-chain first.',
          expiry: rental.expiry,
        });
      }
    }

    return res.json({
      arweaveHash: row.arweaveHash,
      status: row.status,
      grantedVia: isUploader ? 'uploader' : 'rental',
      expiry: rental ? rental.expiry : null,
      // The sealed envelope { v, k, arweaveHash } and Lit's integrity hash for
      // it. Handed to the Lit Action, never opened here — the backend is not in
      // the decryption path and holds nothing that could open it.
      litEncryptedKeyId: row.litEncryptedKeyId,
      litDataToEncryptHash: row.litDataToEncryptHash,
      // AES-256-GCM parameters for the PDF itself, once the Action releases the
      // symmetric key. Both are also on the Arweave tags.
      encryptionIv: row.encryptionIv,
      encryptionAuthTag: row.encryptionAuthTag,
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

// GET /api/rental/book/:arweaveHash
// Price and listing state, plus whether the library has it registered at all.
async function getBookRentalInfo(req, res, next) {
  const params = readParams(req, res, { requireAddress: false });
  if (!params) return undefined;

  try {
    const [book, onChain] = await Promise.all([
      getBookRental(params.arweaveHash),
      getUploadOnChain(params.arweaveHash),
    ]);

    return res.json({
      arweaveHash: params.arweaveHash,
      registered: onChain.registered,
      onChainStatus: onChain.registered ? onChain.status : null,
      uploader: onChain.registered ? onChain.uploader : null,
      // rentBook() requires Approved status, a non-zero price, and not delisted.
      rentable: Boolean(onChain.registered && onChain.status === 'approved' && book.priceSet && !book.delisted),
      ...book,
    });
  } catch (err) {
    return handleChainError(err, res, next);
  }
}

module.exports = { getRentalStatus, getDecryptParams, getBookRentalInfo, handleChainError, readParams };
