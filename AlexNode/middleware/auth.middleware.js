// Wallet address format validation ONLY — not signature verification.
// Real proof of ownership is the on-chain stake the archivist submits later;
// here we just reject obviously malformed addresses before doing any work.
// NOTE: for POST /api/upload the wallet arrives in the multipart body, so this
// middleware must run AFTER multer has parsed the form.

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

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

  // Normalize to a consistent casing for downstream use.
  req.walletAddress = walletAddress.toLowerCase();
  return next();
}

module.exports = { requireWalletAddress, ETH_ADDRESS_RE };
