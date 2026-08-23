// Irys storage wallet management and setup helper.
//
// Usage:
//   node scripts/irys-setup.js generate      # Generate a new EVM wallet key for .env
//   node scripts/irys-setup.js status        # Check on-chain & Irys node balances
//   node scripts/irys-setup.js fund [amount] # Fund Irys node from on-chain balance (e.g. 0.005)
//   node scripts/irys-setup.js test          # Perform a live devnet smoke test upload

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { Uploader } = require('@irys/upload');
const { Ethereum } = require('@irys/upload-ethereum');

// Load .env
const envPath = path.resolve(__dirname, '../.env');
require('dotenv').config({ path: envPath });

const IRYS_NETWORK = process.env.IRYS_NETWORK || 'devnet';
const IRYS_RPC_URL = process.env.IRYS_RPC_URL || 'https://sepolia.base.org';
const IRYS_WALLET_KEY = process.env.IRYS_WALLET_KEY || '';
const IRYS_GATEWAY_URL = process.env.IRYS_GATEWAY_URL || 'https://gateway.irys.xyz';

async function getIrysInstance(privateKey = IRYS_WALLET_KEY) {
  if (!privateKey) {
    throw new Error('No IRYS_WALLET_KEY configured in .env or passed to function.');
  }
  const builder = Uploader(Ethereum).withWallet(privateKey).withRpc(IRYS_RPC_URL);
  return IRYS_NETWORK === 'mainnet' ? await builder.mainnet() : await builder.devnet();
}

async function handleGenerate() {
  console.log('\n=== Generate New Irys Storage Wallet ===');
  const wallet = ethers.Wallet.createRandom();
  console.log(`Address:     ${wallet.address}`);
  console.log(`Private Key: ${wallet.privateKey}`);
  console.log('\nThis wallet is exclusively for paying Arweave/Irys storage fees.');
  console.log('It will NEVER hold user funds or sign on-chain contracts.');

  // Check if .env exists
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('IRYS_WALLET_KEY=')) {
      envContent = envContent.replace(/IRYS_WALLET_KEY=.*(\r?\n|$)/, `IRYS_WALLET_KEY=${wallet.privateKey}$1`);
    } else {
      envContent += `\n# Arweave / Irys Storage Wallet\nIRYS_NETWORK=devnet\nIRYS_RPC_URL=https://sepolia.base.org\nIRYS_WALLET_KEY=${wallet.privateKey}\nIRYS_GATEWAY_URL=https://gateway.irys.xyz\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('\n✓ Saved IRYS_WALLET_KEY to .env');
  } else {
    console.log('\nNo .env found. Please add the following to your .env:');
    console.log(`IRYS_NETWORK=devnet\nIRYS_RPC_URL=https://sepolia.base.org\nIRYS_WALLET_KEY=${wallet.privateKey}\nIRYS_GATEWAY_URL=https://gateway.irys.xyz`);
  }

  console.log('\n--- Next Steps ---');
  console.log(`1. Fund this address (${wallet.address}) with Base Sepolia testnet ETH.`);
  console.log('   Faucets:');
  console.log('   - https://www.alchemy.com/faucets/base-sepolia');
  console.log('   - https://faucets.chain.link/base-sepolia');
  console.log('   - https://learnweb3.io/faucets/base_sepolia');
  console.log('2. Once funded on Base Sepolia, fund the Irys node:');
  console.log('   node scripts/irys-setup.js fund 0.005');
  console.log('3. Verify with a test upload:');
  console.log('   node scripts/irys-setup.js test');
}

async function handleStatus() {
  console.log('\n=== Irys Wallet Status ===');
  if (!IRYS_WALLET_KEY) {
    console.error('✗ IRYS_WALLET_KEY is not set in .env.');
    console.log('Run `node scripts/irys-setup.js generate` to create one.');
    return;
  }

  const wallet = new ethers.Wallet(IRYS_WALLET_KEY);
  console.log(`Storage Wallet Address: ${wallet.address}`);
  console.log(`Network:                ${IRYS_NETWORK}`);
  console.log(`Chain RPC URL:          ${IRYS_RPC_URL}`);

  try {
    const provider = new ethers.JsonRpcProvider(IRYS_RPC_URL);
    const onChainBalWei = await provider.getBalance(wallet.address);
    const onChainEth = ethers.formatEther(onChainBalWei);
    console.log(`On-Chain Balance:       ${onChainEth} ETH`);

    const irys = await getIrysInstance();
    const irysBalanceAtomic = await irys.getBalance();
    const irysBalanceEth = ethers.formatEther(irysBalanceAtomic.toString());
    console.log(`Irys Node Balance:      ${irysBalanceEth} ETH (atomic: ${irysBalanceAtomic.toString()})`);

    // Price quote for 1 MB
    const oneMbPriceAtomic = await irys.getPrice(1024 * 1024);
    const oneMbPriceEth = ethers.formatEther(oneMbPriceAtomic.toString());
    console.log(`Price per 1 MB upload:  ~${oneMbPriceEth} ETH (${oneMbPriceAtomic.toString()} wei)`);

    if (Number(irysBalanceAtomic) === 0) {
      if (Number(onChainBalWei) > 0) {
        console.log('\n💡 You have on-chain funds. To fund your Irys node balance:');
        console.log('   node scripts/irys-setup.js fund 0.005');
      } else {
        console.log('\n⚠️ Irys balance is 0 and on-chain balance is 0.');
        console.log(`   Fund address ${wallet.address} via Base Sepolia faucet.`);
      }
    } else {
      console.log('\n✓ Irys node is funded and ready for uploads!');
    }
  } catch (err) {
    console.error('Failed to query status:', err.message);
  }
}

async function handleFund(amountEth) {
  console.log('\n=== Fund Irys Node ===');
  if (!IRYS_WALLET_KEY) {
    console.error('✗ IRYS_WALLET_KEY is not set in .env.');
    return;
  }

  const irys = await getIrysInstance();
  const amountToFund = amountEth || '0.005';
  console.log(`Funding Irys node with ${amountToFund} ETH using wallet ${irys.address}...`);

  try {
    const atomicUnits = irys.utils.toAtomic(amountToFund);
    console.log(`Submitting fund transaction for ${atomicUnits.toString()} atomic units...`);
    const fundTx = await irys.fund(atomicUnits);
    console.log('✓ Funding successful!');
    console.log('Tx details:', fundTx);

    const newBalance = await irys.getBalance();
    console.log(`New Irys node balance: ${ethers.formatEther(newBalance.toString())} ETH`);
  } catch (err) {
    console.error('✗ Funding failed:', err.message);
    if (err.message.includes('insufficient funds')) {
      console.log('Make sure your wallet address has enough on-chain Base Sepolia ETH to cover the amount and gas.');
    }
  }
}

async function handleTest() {
  console.log('\n=== Irys Devnet Smoke Test ===');
  if (!IRYS_WALLET_KEY) {
    console.error('✗ IRYS_WALLET_KEY is not set in .env.');
    return;
  }

  try {
    const irys = await getIrysInstance();
    const balance = await irys.getBalance();
    console.log(`Connected as: ${irys.address}`);
    console.log(`Irys node balance: ${ethers.formatEther(balance.toString())} ETH`);

    if (Number(balance) === 0) {
      console.error('✗ Irys balance is 0. Upload cannot proceed without node funds.');
      console.log('Run `node scripts/irys-setup.js status` for funding instructions.');
      return;
    }

    const testPayload = Buffer.from(
      JSON.stringify({
        project: 'Alexandria',
        test: 'Irys devnet live smoke test',
        timestamp: new Date().toISOString(),
      })
    );

    console.log(`Creating test upload (${testPayload.length} bytes)...`);
    const tags = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'App-Name', value: 'Alexandria-SmokeTest' },
      { name: 'Timestamp', value: Date.now().toString() },
    ];

    const tx = irys.createTransaction(testPayload, { tags });
    await tx.sign();

    // Derived base64url transaction ID
    const base64UrlId = Buffer.from(tx.rawId)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    console.log(`Signed transaction with derived ID: ${base64UrlId}`);
    console.log('Uploading to Irys devnet...');
    const receipt = await tx.upload();
    console.log('✓ Upload successful! Receipt:', receipt);

    const gatewayUrl = `${IRYS_GATEWAY_URL}/${receipt.id || base64UrlId}`;
    console.log(`\nViewable on gateway: ${gatewayUrl}`);

    // Verify fetching it back
    console.log('Verifying download from gateway...');
    const res = await fetch(gatewayUrl);
    if (res.ok) {
      const fetchedText = await res.text();
      console.log('✓ Successfully retrieved content from gateway:');
      console.log(fetchedText);
      console.log('\n🎉 Irys devnet smoke test PASSED!');
    } else {
      console.warn(`Gateway returned status ${res.status}. Note: gateways may take a few seconds to index new items.`);
    }
  } catch (err) {
    console.error('✗ Smoke test failed:', err);
  }
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'generate') {
    await handleGenerate();
  } else if (command === 'status') {
    await handleStatus();
  } else if (command === 'fund') {
    const amount = process.argv[3];
    await handleFund(amount);
  } else if (command === 'test') {
    await handleTest();
  } else {
    console.log('Usage: node scripts/irys-setup.js [generate | status | fund <amount> | test]');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
