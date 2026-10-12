// Arweave storage wallet setup and health check. Replaces scripts/irys-setup.js.
//
// Usage:
//   node scripts/arweave-wallet-setup.js generate   # create the storage wallet file (never overwrites)
//   node scripts/arweave-wallet-setup.js status     # address check, balance, prices, nodes
//
// The wallet is a local RSA-4096 JWK file (ARWEAVE_WALLET_FILE, decision D3),
// generated offline by Node's crypto via arweave-js. The private key is never
// printed. There is no seed phrase: the file IS the wallet, so back it up.
// Funding is manual: buy AR on an exchange and withdraw it on the Arweave network
// to the printed address. Never to an 0x address.

require('dotenv').config({ quiet: true });

const fs = require('fs');

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 22) {
  console.error(`Node ${process.versions.node} detected; arweave-js 2.x needs Node >= 22. Run: nvm use 22.21.1`);
  process.exit(1);
}

// Requiring the config validates env; report a bad value as one line, not a stack.
let arweave;
try {
  arweave = require('../config/arweave');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 150);

async function handleGenerate() {
  const file = arweave.ARWEAVE_WALLET_FILE;
  if (fs.existsSync(file)) {
    console.log(`A wallet already exists at ${file}. Not touching it.`);
    return handleStatus();
  }
  const jwk = await arweave.offline.wallets.generate();
  // 'wx' = fail if it exists. Never overwrite a key that might hold funds.
  fs.writeFileSync(file, JSON.stringify(jwk), { flag: 'wx', mode: 0o600 });
  const address = await arweave.offline.wallets.jwkToAddress(jwk);
  console.log(`Created a new RSA-4096 storage wallet at ${file}`);
  console.log(`Address: ${address}`);
  console.log('\nNext:');
  console.log('  1. Back this file up somewhere you control. Arweave keys cannot be recovered if lost.');
  console.log(`  2. Add to .env:  ARWEAVE_WALLET_ADDRESS=${address}`);
  console.log('  3. Fund it with AR, withdrawn on the Arweave network to the address above.');
  console.log('  4. Check:  node scripts/arweave-wallet-setup.js status');
}

async function handleStatus() {
  const problem = await arweave.validateWallet();
  if (problem) {
    console.error(`✗ ${problem}`);
    process.exitCode = 1;
    return;
  }
  const { address } = await arweave.loadWallet();
  console.log(`Wallet file : ${arweave.ARWEAVE_WALLET_FILE}`);
  console.log(`Address     : ${address}`);
  console.log(
    arweave.ARWEAVE_WALLET_ADDRESS
      ? '✓ Matches ARWEAVE_WALLET_ADDRESS'
      : `⚠️ ARWEAVE_WALLET_ADDRESS is not set. Add it to .env so a wrong key fails loudly:\n   ARWEAVE_WALLET_ADDRESS=${address}`
  );

  const nodes = await arweave.getNodes();
  console.log(`Nodes       : ${nodes.length} healthy${arweave.ARWEAVE_NODE_URLS.length ? ' (pinned by ARWEAVE_NODE_URLS)' : ''}; first ${nodes[0]}`);

  const balance = await arweave.getBalance();
  console.log(`Balance     : ${balance.ar} AR (${balance.winston} winston)`);
  console.log(`Max reward  : ${arweave.winstonToAr(arweave.ARWEAVE_MAX_REWARD_WINSTON)} AR per upload (ARWEAVE_MAX_REWARD_AR)`);

  // MAX_FILE_SIZE_MB may be fractional; /price takes whole bytes.
  const maxBytes = Math.round(MAX_FILE_SIZE_MB * 1024 * 1024);
  const [perMiB, perMax] = await Promise.all([arweave.getPrice(1024 * 1024), arweave.getPrice(maxBytes)]);
  console.log(`Price 1 MiB : ${arweave.winstonToAr(perMiB)} AR`);
  console.log(`Price max   : ${arweave.winstonToAr(perMax)} AR for ${MAX_FILE_SIZE_MB} MiB (largest allowed upload)`);
  if (BigInt(perMax) === 0n) {
    console.log('⚠️ The network quoted 0 for the largest upload. That is not a real price; check the nodes.');
    return;
  }
  const maxUploads = BigInt(balance.winston) / BigInt(perMax);
  console.log(`Covers      : ${maxUploads} upload(s) of the maximum size at today's price`);
  if (maxUploads === 0n) console.log('\n⚠️ The balance cannot cover one maximum-size upload. Top it up.');
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'generate') return handleGenerate();
  if (command === 'status') return handleStatus();
  console.log('Usage: node scripts/arweave-wallet-setup.js [generate | status]');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
