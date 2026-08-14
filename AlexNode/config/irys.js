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

const { Uploader } = require('@irys/upload');
const { Ethereum } = require('@irys/upload-ethereum');

const IRYS_NETWORK = process.env.IRYS_NETWORK || 'devnet';
const IRYS_RPC_URL = process.env.IRYS_RPC_URL || 'https://sepolia.base.org';
const IRYS_WALLET_KEY = process.env.IRYS_WALLET_KEY || '';
const IRYS_GATEWAY_URL = process.env.IRYS_GATEWAY_URL || 'https://gateway.irys.xyz';

let _irysPromise;

/**
 * Get the memoized Irys uploader, building it on first use.
 * @returns {Promise<object>} configured Irys client
 */
function getIrys() {
  if (!IRYS_WALLET_KEY) {
    return Promise.reject(
      new Error(
        'IRYS_WALLET_KEY is not set. Add a funded storage wallet private key to .env ' +
          '(devnet funds come free from an Irys faucet — see https://docs.irys.xyz).'
      )
    );
  }

  if (!_irysPromise) {
    const builder = Uploader(Ethereum).withWallet(IRYS_WALLET_KEY).withRpc(IRYS_RPC_URL);

    // mainnet() vs devnet() picks which Irys node — and therefore which ledger —
    // the upload lands on. Getting this wrong on mainnet spends real money.
    _irysPromise = (IRYS_NETWORK === 'mainnet' ? builder.mainnet() : builder.devnet()).then((irys) => {
      console.log(`[irys] connected to ${IRYS_NETWORK} as ${irys.address}`);
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
};
