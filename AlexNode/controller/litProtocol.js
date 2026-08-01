
// Lit Protocol encryption for validated PDFs.
//
// Flow: encryptPdf() ties the (soon-to-exist) file to an on-chain access
// condition — Lit will only release the decryption key to a reader whose wallet
// passes Rent.sol.isRentalActive(arweaveHash, userAddress). Encryption embeds
// the condition but does NOT call the contract, so it succeeds before any
// rental exists. The backend is never in the decryption path.
//
// Returns { ciphertext (base64), dataToEncryptHash } — both persisted to
// Postgres; dataToEncryptHash is the "litEncryptedKeyId" referenced elsewhere.

const { getLitNodeClient } = require('../config/lit');

const RENT_CONTRACT_ADDRESS = process.env.RENT_CONTRACT_ADDRESS || '';
// Lit's chain identifier for Base Sepolia.
const LIT_CHAIN = process.env.LIT_CHAIN || 'baseSepolia';

// Build the access-control condition tied to a specific upload.
//
// NOTE (Phase 5 open question): the condition references arweaveHash, but Irys
// mints that only when we upload the ciphertext — which happens AFTER encryption.
// So the caller decides how to supply it (reserve/derive a txid first, or bind a
// placeholder and finalize on upload). This helper just shapes the condition.
function buildRentalAccessControlConditions(arweaveHash) {
  if (!arweaveHash) {
    throw new Error('buildRentalAccessControlConditions requires an arweaveHash (or placeholder).');
  }
  return [
    {
      contractAddress: RENT_CONTRACT_ADDRESS,
      standardContractType: 'custom',
      chain: LIT_CHAIN,
      method: 'isRentalActive',
      parameters: [arweaveHash, ':userAddress'],
      returnValueTest: {
        comparator: '=',
        value: 'true',
      },
    },
  ];
}

// Encrypt raw PDF bytes under the given access-control conditions.
// pdfBuffer: Node Buffer (from multer memoryStorage).
async function encryptPdf(pdfBuffer, accessControlConditions) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('encryptPdf requires a non-empty Buffer.');
  }
  if (!Array.isArray(accessControlConditions) || accessControlConditions.length === 0) {
    throw new Error('encryptPdf requires accessControlConditions.');
  }

  const litNodeClient = await getLitNodeClient();

  const { ciphertext, dataToEncryptHash } = await litNodeClient.encrypt({
    accessControlConditions,
    dataToEncrypt: new Uint8Array(pdfBuffer),
  });

  return { ciphertext, dataToEncryptHash };
}

// Convenience: build the rental condition from an arweaveHash and encrypt in one step.
async function encryptForRental(pdfBuffer, arweaveHash) {
  const accessControlConditions = buildRentalAccessControlConditions(arweaveHash);
  return encryptPdf(pdfBuffer, accessControlConditions);
}

module.exports = {
  buildRentalAccessControlConditions,
  encryptPdf,
  encryptForRental,
};
