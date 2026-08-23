// On-chain registration — the backend's ONLY write path.
//
// Calls AlexandriaLibrary.registerUpload(arweaveHash, uploader, metadata) after
// the encrypted PDF is on Arweave, recording the archivist as `uploader` so that
// stake.stake() — which requires getUploader(hash) == msg.sender — still has to
// be signed by the archivist's own wallet. The backend registers; it never stakes.
//
// ─── Why the backend does this at all ────────────────────────────────────────
//
// registerUpload is `onlyAuthorized`. An archivist calling it directly reverts
// with "Not authorized". The deployed contracts were written for a backend
// registrar (deployment.md step 3b), so this is the flow they support.
//
// ─── Failing safely ──────────────────────────────────────────────────────────
//
// Registration is never allowed to break an upload. By the time it runs, the
// bytes are already paid for and permanent on Arweave and the index row exists.
// A failure here leaves the row at "pending_stake" with a recorded reason, and
// it can be retried later with nothing lost — the same recoverable state as an
// archivist who closed the browser mid-flow.
//
// Every failure is preflighted into a NAMED reason rather than a raw revert,
// because the three likely ones need three different humans to fix them:
//   not_authorized  → owner runs library.setAuthorizedCaller(backend, true)
//   insufficient_gas → someone funds the registrar with Base Sepolia ETH
//   not_configured  → BACKEND_PRIVATE_KEY is missing from .env

const { ethers } = require('ethers');
const { getLibraryWriter, getSigner, signerError, getContracts } = require('../config/blockchain');

// registerUpload writes `metadata` to storage AND emits it in the log, so its
// length is paid for twice. Keys are short for that reason; the full record
// lives in Postgres and on the Arweave tags, and this is the on-chain breadcrumb
// that lets the catalogue be rebuilt from events alone if Postgres is ever lost.
const MAX_METADATA_FIELD = 200;

function clip(value) {
  return String(value ?? '').slice(0, MAX_METADATA_FIELD);
}

/**
 * Compact on-chain metadata blob.
 * @param {{title: string, author: string, category: string}} meta
 * @returns {string}
 */
function buildMetadata(meta) {
  return JSON.stringify({
    t: clip(meta.title),
    a: clip(meta.author),
    c: clip(meta.category),
  });
}

/**
 * Result shape shared by every path out of registerOnChain.
 */
function outcome(ok, reason, message, extra = {}) {
  return { registered: ok, reason, message, ...extra };
}

/**
 * Is the registrar able to transact at all? Checked before simulating so the
 * common misconfigurations produce their own specific message.
 *
 * @returns {Promise<{ready: boolean, reason?: string, message?: string, address?: string}>}
 */
async function preflight() {
  const signer = getSigner();
  if (!signer) {
    return {
      ready: false,
      reason: 'not_configured',
      message:
        signerError() ||
        'BACKEND_PRIVATE_KEY is not set, so the backend cannot register uploads on-chain. ' +
          'Uploads still succeed and stay at status "pending_stake".',
    };
  }

  const { library } = getContracts();

  const [authorized, balance] = await Promise.all([
    library.authorizedCallers(signer.address),
    signer.provider.getBalance(signer.address),
  ]);

  // The owner passes onlyAuthorized without being in the mapping, so check both.
  let allowed = authorized;
  if (!allowed) {
    const owner = await library.owner();
    allowed = owner.toLowerCase() === signer.address.toLowerCase();
  }

  if (!allowed) {
    return {
      ready: false,
      reason: 'not_authorized',
      address: signer.address,
      message:
        `${signer.address} is not an authorized caller on AlexandriaLibrary. ` +
        `The contract owner must run: library.setAuthorizedCaller("${signer.address}", true)`,
    };
  }

  if (balance === 0n) {
    return {
      ready: false,
      reason: 'insufficient_gas',
      address: signer.address,
      message:
        `${signer.address} holds no Base Sepolia ETH, so it cannot pay gas. ` +
        'Fund it from a faucet (https://www.alchemy.com/faucets/base-sepolia).',
    };
  }

  return { ready: true, address: signer.address, balance: ethers.formatEther(balance) };
}

/**
 * Register an upload on-chain.
 *
 * Idempotent: an already-registered hash returns `already_registered` rather
 * than reverting, so a retry after a timeout is safe even when the original
 * transaction actually landed.
 *
 * @param {string} arweaveHash
 * @param {string} uploader archivist wallet — recorded on-chain as the owner
 * @param {{title: string, author: string, category: string}} meta
 * @returns {Promise<{registered: boolean, reason: string|null, message?: string, txHash?: string}>}
 */
async function registerOnChain(arweaveHash, uploader, meta) {
  const check = await preflight();
  if (!check.ready) return outcome(false, check.reason, check.message, { address: check.address });

  const { library } = getContracts();

  // Cheap read first: registerUpload reverts on a duplicate, and a retry after a
  // timed-out-but-landed transaction is exactly when that happens.
  if (await library.uploadExists(arweaveHash)) {
    return outcome(true, 'already_registered', 'This hash is already registered on-chain.');
  }

  const writer = getLibraryWriter();
  const metadata = buildMetadata(meta);
  const uploaderAddress = ethers.getAddress(uploader);

  try {
    // Simulate before spending. A staticCall reverts with the same reason the
    // real transaction would, but costs nothing and burns no nonce — which
    // matters because a reverted send still consumes gas and a nonce.
    await writer.registerUpload.staticCall(arweaveHash, uploaderAddress, metadata);
  } catch (err) {
    const reason = err.reason || err.shortMessage || err.message;
    return outcome(false, 'would_revert', `registerUpload would revert: ${reason}`);
  }

  try {
    const tx = await writer.registerUpload(arweaveHash, uploaderAddress, metadata);
    // One confirmation: enough to know it landed, and the event listener will
    // reconcile status independently if this process dies before it resolves.
    const receipt = await tx.wait(1);

    console.log(`[registration] ${arweaveHash} registered on-chain in ${receipt.hash}`);
    return outcome(true, null, 'Registered on-chain.', {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
  } catch (err) {
    // Nothing to clean up: a failed send changes no state, and the Arweave bytes
    // and index row are both already durable.
    const reason = err.reason || err.shortMessage || err.message;
    console.error(`[registration] ${arweaveHash} failed: ${reason}`);
    return outcome(false, 'transaction_failed', `On-chain registration failed: ${reason}`);
  }
}

module.exports = { registerOnChain, preflight, buildMetadata, MAX_METADATA_FIELD };
