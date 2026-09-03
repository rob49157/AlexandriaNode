// Decryption Lit Action for Alexandria
//
// This script runs inside the Lit Protocol TEE (Trusted Execution Environment).
// It unseals the PKP-encrypted envelope, extracts the arweaveHash sealed inside,
// verifies on-chain rental permissions (or archivist uploader ownership), and
// releases ONLY the symmetric AES-256 key if authorized.
//
// ─── Key Invariants ─────────────────────────────────────────────────────────
// 1. Envelope unsealed FIRST: The Action never trusts a caller-supplied hash.
//    The authorization subject is read directly from the decrypted envelope plaintext.
// 2. Uploader carve-out: Archivists cannot rent their own books (Rent.sol reverts).
//    The Action permits library.getUploader(hash) === userAddress without a rental.
// 3. Fail closed on revert: If Rent.sol reverts (e.g. paused), the check fails closed.

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_RPC = 'https://base-sepolia-rpc.publicnode.com';

const RENT_CONTRACT_ADDRESS = '0xe50AD653Ee690c818900091a4d69F22e484bD2cD';
const LIBRARY_CONTRACT_ADDRESS = '0x0b26AB8C632586E846DE87D29D665fd727bBe844';

const LIT_DECRYPT_ACTION_CODE = `
async function main({ pkpId, ciphertext, userAddress }) {
  if (!userAddress || typeof userAddress !== 'string') {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'missing_user_address' }) });
    return;
  }

  // 1. Unseal the envelope inside the TEE
  let unsealedStr;
  try {
    const res = await Lit.Actions.Decrypt({ pkpId, ciphertext });
    unsealedStr = typeof res === 'string' ? res : (res.decrypted || res.plaintext || JSON.stringify(res));
  } catch (err) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'unseal_failed' }) });
    return;
  }

  // 2. Parse envelope and verify version
  let envelope;
  try {
    envelope = typeof unsealedStr === 'object' && unsealedStr !== null ? unsealedStr : JSON.parse(unsealedStr);
  } catch (err) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'invalid_envelope_json' }) });
    return;
  }

  if (!envelope || envelope.v !== 1 || !envelope.k || !envelope.arweaveHash) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'invalid_envelope_format' }) });
    return;
  }

  const { k, arweaveHash } = envelope;
  const user = userAddress.toLowerCase();

  // 3. Query on-chain permissions on Base Sepolia
  const provider = new ethers.providers.JsonRpcProvider('${BASE_SEPOLIA_RPC}');
  const rentContract = new ethers.Contract(
    '${RENT_CONTRACT_ADDRESS}',
    ['function isRentalActive(string,address) view returns (bool)'],
    provider
  );
  const libraryContract = new ethers.Contract(
    '${LIBRARY_CONTRACT_ADDRESS}',
    ['function getUploader(string) view returns (address)'],
    provider
  );

  let isRented = false;
  try {
    isRented = await rentContract.isRentalActive(arweaveHash, userAddress);
  } catch (err) {
    // Revert occurs if contract is paused -> fail closed
    isRented = false;
  }

  let isOwner = false;
  try {
    const uploader = await libraryContract.getUploader(arweaveHash);
    isOwner = Boolean(uploader && uploader.toLowerCase() === user);
  } catch (err) {
    isOwner = false;
  }

  // 4. Authorization gate
  if (!isRented && !isOwner) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'access_denied' }) });
    return;
  }

  // 5. Release ONLY the symmetric key
  Lit.Actions.setResponse({ response: JSON.stringify({ key: k }) });
}
`.trim();

module.exports = {
  LIT_DECRYPT_ACTION_CODE,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC,
  RENT_CONTRACT_ADDRESS,
  LIBRARY_CONTRACT_ADDRESS,
};
