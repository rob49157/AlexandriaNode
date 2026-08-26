// Irys client — pays for and pushes encrypted PDFs to Arweave.
//
// Uses @irys/upload + @irys/upload-ethereum. (The @irys/sdk package named in
// CLAUDE.md is deprecated/EOL; these are its replacements.)
//
// The builder is async and hits the chain RPC to construct its token config, so
// the client is built once and memoized rather than rebuilt per upload. The
// promise itself is cached, so concurrent uploads during startup share one build
// instead of racing to create several.
//
// This is the only wallet the backend holds. It is a low-privilege storage
// wallet that can do nothing but pay for Arweave uploads — it never signs
// on-chain Alexandria transactions (staking, registration, rentals are all
// frontend/user-signed).

const { ethers } = require('ethers');
const { Uploader } = require('@irys/upload');
const { BaseEth, Ethereum } = require('@irys/upload-ethereum');

// ⚠️ The token is NOT interchangeable with the RPC URL, and getting this wrong
// silently strands money.
//
// Irys treats `base-eth` and `ethereum` as different tokens with different
// ledgers, even though both settle to the same Irys address. Configure the
// client with `Ethereum` while pointing withRpc() at Base Sepolia and this is
// what happens: fund() sends ETH to Irys on *Base Sepolia*, then Irys looks for
// that transaction on *Ethereum Sepolia*, fails to find it, and rejects the
// notification with "Tx doesn't exist". The transfer is mined and irreversible;
// the credit never appears.
//
// That happened here (tx 0x113ecf03…102c9a, 0.005 ETH). It was recoverable only
// because Irys uses the same deposit address for both tokens, so re-submitting
// the same tx hash under `base-eth` found it. Do not rely on that.
//
// Rule: the token must match the chain that withRpc() points at.
const TOKENS = {
  'base-eth': BaseEth, // Base mainnet / Base Sepolia on devnet
  ethereum: Ethereum, // Ethereum mainnet / Sepolia on devnet
};

const IRYS_TOKEN = process.env.IRYS_TOKEN || 'base-eth';

const IRYS_NETWORK = process.env.IRYS_NETWORK || 'devnet';
// Not sepolia.base.org: that endpoint intermittently answers "no backend is
// currently healthy", and here it would fail during client construction — i.e.
// before an upload starts rather than during one, but still a hard failure on a
// request that should have worked. Same reasoning as config/blockchain.js.
const IRYS_RPC_URL = process.env.IRYS_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
const IRYS_WALLET_KEY = (process.env.IRYS_WALLET_KEY || '').trim();
const IRYS_WALLET_ADDRESS = (process.env.IRYS_WALLET_ADDRESS || '').trim();
const IRYS_GATEWAY_URL = process.env.IRYS_GATEWAY_URL || 'https://gateway.irys.xyz';

let _irysPromise;

/**
 * Check IRYS_WALLET_KEY before handing it to the Irys SDK.
 *
 * Two mistakes are worth catching by name, because both otherwise surface much
 * later as something misleading:
 *
 *   1. Pasting the wallet ADDRESS instead of its private key. An address is 42
 *      chars and a key is 66, and the two are adjacent in every wallet UI. The
 *      SDK's own error for this does not mention the length, so it reads as a
 *      malformed-config problem rather than "you copied the wrong field".
 *   2. Exporting the wrong account's key. This one is silent — you get a
 *      perfectly valid wallet with no storage credit, and the first real upload
 *      fails with an unhelpful balance error. Setting IRYS_WALLET_ADDRESS turns
 *      that into a startup failure naming both addresses.
 *
 * @returns {string|null} an error message, or null if the key is usable
 */
function validateWalletKey() {
  if (!IRYS_WALLET_KEY) {
    return (
      'IRYS_WALLET_KEY is not set. Add a funded storage wallet private key to .env ' +
      '(devnet funds come free from an Irys faucet — see https://docs.irys.xyz).'
    );
  }

  const key = IRYS_WALLET_KEY.startsWith('0x') ? IRYS_WALLET_KEY : `0x${IRYS_WALLET_KEY}`;

  if (/^0x[0-9a-fA-F]{40}$/.test(key)) {
    return (
      `IRYS_WALLET_KEY looks like a wallet ADDRESS (${key.length} chars), not a private key (66). ` +
      'In Rabby: pick the account, then Export Private Key — not the address shown at the top. ' +
      `If ${key} is the intended wallet, put it in IRYS_WALLET_ADDRESS instead.`
    );
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(key);
  } catch {
    return 'IRYS_WALLET_KEY is not a valid private key. It should be 0x followed by 64 hex characters.';
  }

  if (IRYS_WALLET_ADDRESS && wallet.address.toLowerCase() !== IRYS_WALLET_ADDRESS.toLowerCase()) {
    return (
      `IRYS_WALLET_KEY derives ${wallet.address} but IRYS_WALLET_ADDRESS is ${IRYS_WALLET_ADDRESS}. ` +
      'One of them is from the wrong account — uploads would be paid from a wallet with no storage credit.'
    );
  }

  return null;
}

/**
 * Get the memoized Irys uploader, building it on first use.
 * @returns {Promise<object>} configured Irys client
 */
function getIrys() {
  const problem = validateWalletKey();
  if (problem) return Promise.reject(new Error(problem));

  const token = TOKENS[IRYS_TOKEN];
  if (!token) {
    return Promise.reject(
      new Error(`IRYS_TOKEN="${IRYS_TOKEN}" is not supported. Use one of: ${Object.keys(TOKENS).join(', ')}.`)
    );
  }

  if (!_irysPromise) {
    const builder = Uploader(token).withWallet(IRYS_WALLET_KEY).withRpc(IRYS_RPC_URL);

    // mainnet() vs devnet() picks which Irys node — and therefore which ledger —
    // the upload lands on. Getting this wrong on mainnet spends real money.
    _irysPromise = (IRYS_NETWORK === 'mainnet' ? builder.mainnet() : builder.devnet()).then((irys) => {
      console.log(`[irys] connected to ${IRYS_NETWORK} as ${irys.address} (token: ${irys.token})`);
      return irys;
    });

    // Don't cache a rejected build — a transient RPC failure at startup would
    // otherwise poison every later upload for the life of the process.
    _irysPromise.catch(() => {
      _irysPromise = undefined;
    });
  }

  return _irysPromise;
}

/**
 * Current storage-wallet balance, in atomic units of the funding token.
 *
 * Backs the low-balance alerting in the cross-cutting checklist: uploads start
 * failing with 402s once this hits zero, and the failure is easier to act on if
 * it is noticed before it happens.
 *
 * @returns {Promise<{ atomic: string, network: string, address: string }>}
 */
async function getBalance() {
  const irys = await getIrys();
  const balance = await irys.getBalance();
  return {
    atomic: balance.toString(),
    network: IRYS_NETWORK,
    address: irys.address,
  };
}

/**
 * Price quote for storing `bytes` bytes, in atomic units.
 * Useful for pre-flight cost checks before committing to an upload.
 *
 * @param {number} bytes
 * @returns {Promise<string>} atomic units
 */
async function getPrice(bytes) {
  const irys = await getIrys();
  const price = await irys.getPrice(bytes);
  return price.toString();
}

module.exports = {
  getIrys,
  getBalance,
  getPrice,
  IRYS_NETWORK,
  IRYS_GATEWAY_URL,
  IRYS_WALLET_ADDRESS,
  IRYS_TOKEN,
  validateWalletKey,
};
