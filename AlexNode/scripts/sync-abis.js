#!/usr/bin/env node
// Copy contract ABIs + deployed addresses out of the AlexandriaSmartContract
// repo and into ./abis, so this repo can be built and run without it on disk.
//
//   node scripts/sync-abis.js
//   ALEXANDRIA_CONTRACTS_DIR=../../AlexandriaSmartContract/AlexandriaContract node scripts/sync-abis.js
//
// The generated files are committed. That is deliberate: the backend must not
// depend on a sibling checkout existing (CI, deploys, and other machines won't
// have one), and an ABI that silently changes underneath a running service is a
// worse failure than one that shows up in a diff.
//
// Re-run this after any contract redeploy, then review the diff — a changed
// address or a changed event signature both mean the event listener needs a
// second look before it is trusted.

const fs = require('fs');
const path = require('path');

// Hardhat Ignition writes deployments to chain-<chainId>/. 84532 = Base Sepolia.
const CHAIN_ID = process.env.ALEXANDRIA_CHAIN_ID || '84532';

const CONTRACTS_DIR =
  process.env.ALEXANDRIA_CONTRACTS_DIR ||
  path.resolve(__dirname, '..', '..', '..', 'AlexandriaSmartContract', 'AlexandriaContract');

const OUT_DIR = path.resolve(__dirname, '..', 'abis');

// Ignition names each deployment "<ModuleName>#<ContractName>". The keys on the
// left are the short names this backend uses internally.
const WANTED = {
  library: 'AlexandriaLibrary',
  stake: 'AlexandriaStake',
  rent: 'AlexandriaRent',
  token: 'AlexandriaToken',
  payment: 'AlexandriaPayment',
};

function fail(message) {
  console.error(`[sync-abis] ${message}`);
  process.exit(1);
}

/**
 * Block number each contract was deployed at, read from Ignition's journal.
 *
 * The event listener needs this: without a floor it would have to scan from
 * genesis, and Base Sepolia is ~45M blocks deep. Recording it here keeps the
 * start block a derived fact rather than a magic number that quietly goes stale
 * after the next redeploy.
 *
 * @returns {Record<string, number>} futureId → block number
 */
function deploymentBlocks(deploymentDir) {
  const journalPath = path.join(deploymentDir, 'journal.jsonl');
  if (!fs.existsSync(journalPath)) return {};

  const blocks = {};
  for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A partially-written journal line is not worth failing over.
    }
    const block = entry?.receipt?.blockNumber;
    if (entry.futureId && typeof block === 'number') {
      // Keep the earliest — a contract only gets deployed once, but later
      // wiring calls reuse the same futureId prefix.
      blocks[entry.futureId] = Math.min(blocks[entry.futureId] ?? Infinity, block);
    }
  }
  return blocks;
}

function main() {
  const deploymentDir = path.join(CONTRACTS_DIR, 'ignition', 'deployments', `chain-${CHAIN_ID}`);
  const addressesPath = path.join(deploymentDir, 'deployed_addresses.json');

  if (!fs.existsSync(addressesPath)) {
    fail(
      `No deployment found at ${addressesPath}\n` +
        `Set ALEXANDRIA_CONTRACTS_DIR to the AlexandriaContract directory, or deploy first:\n` +
        `  npx hardhat ignition deploy ./ignition/modules/Alexandria.js --network baseSepolia`
    );
  }

  const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
  const blocks = deploymentBlocks(deploymentDir);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const [shortName, contractName] of Object.entries(WANTED)) {
    // Find this contract's entry regardless of what the Ignition module is called.
    const key = Object.keys(addresses).find((k) => k.endsWith(`#${contractName}`));
    if (!key) fail(`${contractName} is missing from ${addressesPath}`);

    const artifactPath = path.join(deploymentDir, 'artifacts', `${key}.json`);
    if (!fs.existsSync(artifactPath)) fail(`No artifact at ${artifactPath}`);

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    // Only the ABI and the address are kept. Bytecode is several hundred KB and
    // is useless to a read-only client that never deploys anything.
    const out = {
      contractName: artifact.contractName,
      chainId: Number(CHAIN_ID),
      address: addresses[key],
      deploymentBlock: blocks[key] ?? null,
      abi: artifact.abi,
    };

    const outPath = path.join(OUT_DIR, `${shortName}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
    console.log(
      `[sync-abis] ${shortName.padEnd(8)} ${out.address}  block ${out.deploymentBlock ?? '?'}  (${out.abi.length} ABI entries)`
    );
  }

  console.log(`[sync-abis] wrote ${Object.keys(WANTED).length} files to ${OUT_DIR}`);
}

main();
