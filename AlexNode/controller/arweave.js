// Arweave storage via Irys — uploads the encrypted PDF, returns the arweaveHash.
//
// Deliberately split into prepare (sign) and commit (push), because the upload
// pipeline needs the transaction ID *before* it spends any money:
//
//   prepareUpload()  → signs locally. Free, offline, reversible. Yields arweaveHash.
//   ...seal the Lit envelope against that hash...
//   commitUpload()   → pushes bytes. Paid, permanent, irreversible.
//
// A data item's ID is sha256 of its signature, so it is fully determined the
// moment the item is signed — no placeholder or reserved-txid dance needed.
//
// ─── The id encoding trap ────────────────────────────────────────────────────
// @irys/bundles' DataItem exposes `get id()` as *base58* (44 chars), while
// Arweave gateways, the Irys node's upload receipt, and every on-chain consumer
// use *base64url* (43 chars). The getter and setter don't even agree with each
// other: `get id` encodes base58, `set id` decodes base64url.
//
// Using tx.id directly would 404 on every gateway and put a wrong identifier
// on-chain, so we derive the hash from tx.rawId ourselves. commitUpload then
// asserts the node's receipt agrees — a mismatch would mean we sealed the wrong
// hash into the Lit envelope, permanently breaking decryption for that book.

const { getIrys, IRYS_GATEWAY_URL } = require('../config/irys');

const APP_NAME = 'Alexandria';
const APP_VERSION = '1';

// Irys allows 2 KB of tags per data item before they cost extra. Metadata is
// user-supplied and already length-capped by Layer 5, but the cap there (300 +
// 200 + 2000 chars) can still overrun 2 KB, so tag values get truncated.
const MAX_TAG_VALUE = 200;

/**
 * Encode raw bytes as base64url — the canonical Arweave/Irys identifier form.
 * @param {Buffer} buf
 * @returns {string}
 */
function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The real transaction ID for a signed data item.
 * @param {object} tx — signed IrysTransaction
 * @returns {string} 43-char base64url string
 */
function transactionId(tx) {
  return toBase64Url(tx.rawId);
}

function tag(name, value) {
  return { name, value: String(value ?? '').slice(0, MAX_TAG_VALUE) };
}

/**
 * Build the Arweave tag set for an encrypted upload.
 *
 * The IV and auth tag live here because without them the ciphertext is
 * permanently undecryptable — and unlike Postgres, Arweave keeps them forever.
 * Storing the metadata alongside makes the stored object self-describing, so the
 * Postgres search index is rebuildable from storage alone (useful for the
 * decentralization roadmap, where Postgres stops being the source of truth).
 *
 * Nothing secret goes in tags: they are public, permanent, and unencrypted. The
 * title/author/category are public metadata anyway — they go on-chain at
 * registration and into the public search index.
 *
 * @param {{ iv: Buffer, authTag: Buffer, metadata: object, uploader: string, sha256Hash: string }} params
 * @returns {Array<{name: string, value: string}>}
 */
function buildTags({ iv, authTag, metadata, uploader, sha256Hash }) {
  return [
    tag('Content-Type', 'application/octet-stream'),
    tag('App-Name', APP_NAME),
    tag('App-Version', APP_VERSION),
    tag('Encryption', 'AES-256-GCM'),
    tag('Encryption-IV', iv.toString('base64')),
    tag('Encryption-Auth-Tag', authTag.toString('base64')),
    tag('Title', metadata.title),
    tag('Author', metadata.author),
    tag('Category', metadata.category),
    tag('Uploader', uploader),
    tag('SHA-256', sha256Hash),
  ];
}

/**
 * Sign a data item locally and derive its transaction ID. Costs nothing and
 * touches no network — the bytes are not sent anywhere until commitUpload.
 *
 * @param {Buffer} ciphertext — AES-GCM encrypted PDF
 * @param {Array<{name: string, value: string}>} tags
 * @returns {Promise<{ arweaveHash: string, tx: object }>}
 */
async function prepareUpload(ciphertext, tags) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
    throw new Error('prepareUpload requires a non-empty ciphertext Buffer.');
  }

  const irys = await getIrys();
  const tx = irys.createTransaction(ciphertext, { tags });
  await tx.sign();

  return { arweaveHash: transactionId(tx), tx };
}

/**
 * Push a signed data item to Irys. This is the paid, irreversible step.
 *
 * @param {object} tx — signed IrysTransaction from prepareUpload
 * @param {string} expectedHash — the arweaveHash we already sealed into the Lit envelope
 * @returns {Promise<{ arweaveHash: string, timestamp: number }>}
 */
async function commitUpload(tx, expectedHash) {
  const receipt = await tx.upload();

  // The node echoes back the id it stored under. If it ever disagrees with what
  // we derived and sealed, the key envelope is bound to the wrong book and the
  // upload is unrecoverable — fail loudly rather than persist a broken row.
  if (receipt && receipt.id) {
    if (receipt.id !== expectedHash) {
      throw new Error(
        `Irys returned id ${receipt.id} but the sealed envelope is bound to ${expectedHash}. ` +
          'Refusing to persist — the encrypted key would not match the stored file.'
      );
    }
  } else {
    // No id to compare against means the derivation went unverified this time.
    // Say so rather than let the check quietly no-op — if the receipt shape ever
    // changes, this is the line that turns a silent gap into a visible one.
    console.warn(
      `[arweave] Irys receipt carried no id; could not verify the derived hash ${expectedHash}. ` +
        `Receipt keys: ${receipt ? Object.keys(receipt).join(', ') : '(none)'}`
    );
  }

  return {
    arweaveHash: expectedHash,
    timestamp: receipt ? receipt.timestamp : undefined,
  };
}

/**
 * Fetch stored ciphertext back from the gateway.
 * Used by the Phase 6 read path and by the roundtrip test.
 *
 * @param {string} arweaveHash
 * @returns {Promise<Buffer>} raw encrypted bytes
 */
async function fetchEncrypted(arweaveHash) {
  const res = await fetch(`${IRYS_GATEWAY_URL}/${arweaveHash}`);
  if (!res.ok) {
    throw new Error(`Gateway returned ${res.status} for ${arweaveHash}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  prepareUpload,
  commitUpload,
  fetchEncrypted,
  buildTags,
  transactionId,
  toBase64Url,
};
