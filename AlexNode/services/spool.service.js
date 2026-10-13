// Ciphertext spool: the encrypted PDF waits here between the request and the
// moment its chunks are stored and verified (ARWEAVE-DIRECT-PLAN.md §2.2).
//
// Why it has to exist: chunks are sent only after the header is mined (minutes
// later, by the storage worker), and resuming an upload "must provide the same
// data as the original upload" [arweave-js README]. Memory does not survive a
// restart; a file does.
//
// Only AES-256-GCM ciphertext is ever written here, never a plaintext PDF
// (CLAUDE.md security rules). Files are deleted once the book is verified stored,
// or when the upload fails for good.

const fs = require('fs');
const path = require('path');
const { ARWEAVE_SPOOL_DIR } = require('../config/arweave');

const ID = /^[A-Za-z0-9_-]{43}$/;

function fileFor(arweaveHash) {
  // The id is the file name, so it must never contain a path separator.
  if (!ID.test(arweaveHash)) throw new Error(`Refusing to spool under a non-Arweave id: ${arweaveHash}`);
  return path.join(ARWEAVE_SPOOL_DIR, `${arweaveHash}.bin`);
}

/**
 * Write atomically: a crash mid-write leaves a .tmp file, never a truncated
 * spool that would later fail the data_root check (or worse, be half-sent).
 */
async function write(arweaveHash, ciphertext) {
  const file = fileFor(arweaveHash);
  await fs.promises.mkdir(ARWEAVE_SPOOL_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(ciphertext);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
  return file;
}

async function read(arweaveHash) {
  return fs.promises.readFile(fileFor(arweaveHash));
}

async function exists(arweaveHash) {
  try {
    await fs.promises.access(fileFor(arweaveHash));
    return true;
  } catch {
    return false;
  }
}

async function remove(arweaveHash) {
  await fs.promises.rm(fileFor(arweaveHash), { force: true });
}

module.exports = { write, read, exists, remove, fileFor };
