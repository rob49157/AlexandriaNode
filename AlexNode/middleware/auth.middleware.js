// Wallet address format validation ONLY — not signature verification.
// Real proof of ownership is the on-chain stake the archivist submits later;
// here we just reject obviously malformed addresses before doing any work.
// NOTE: for POST /api/upload the wallet arrives in the multipart body, so this
// middleware must run AFTER multer has parsed the form.

const { ethers } = require('ethers');

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Is this a well-formed Ethereum address?
 *
 * ethers.isAddress() adds EIP-55 checksum verification on top of the shape
 * check: an all-lower or all-upper address passes (no checksum to test), but a
 * mixed-case one must checksum correctly. That turns a mistyped character in a
 * copied address from a silent wrong-owner row into a 400.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
function isValidWalletAddress(address) {
  return typeof address === 'string' && ETH_ADDRESS_RE.test(address) && ethers.isAddress(address);
}

function requireWalletAddress(req, res, next) {
  const walletAddress = (req.body && req.body.walletAddress) || '';

  if (!walletAddress) {
    return res.status(400).json({
      valid: false,
      stage: 'auth',
      reason: 'missing_wallet_address',
      message: 'walletAddress is required.',
    });
  }

  if (!ETH_ADDRESS_RE.test(walletAddress)) {
    return res.status(400).json({
      valid: false,
      stage: 'auth',
      reason: 'invalid_wallet_address',
      message: 'walletAddress must be a 0x-prefixed 40-hex-character Ethereum address.',
    });
  }

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({
      valid: false,
      stage: 'auth',
      reason: 'invalid_wallet_checksum',
      message:
        'walletAddress has an invalid EIP-55 checksum — it was probably mistyped. ' +
        'Send it as your wallet reports it, or in all lower case.',
    });
  }

  // Normalize to a consistent casing for downstream use. Lower-case rather than
  // checksummed because it is compared against DB rows written the same way.
  req.walletAddress = walletAddress.toLowerCase();
  return next();
}

module.exports = { requireWalletAddress, isValidWalletAddress, ETH_ADDRESS_RE };
