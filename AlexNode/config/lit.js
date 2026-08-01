// Lit Protocol node client singleton (Datil network line, v7 SDK).
//
// We use LitNodeClientNodeJs (the server build — no browser wallet deps). The
// client must connect() to the network before encrypt() works, because encrypt
// needs the network's BLS subnet public key fetched during the handshake.
// Encryption itself is free and keyless; only DECRYPTION requires auth/payment
// (handled later in the reader's browser, never by this backend).

const { LitNodeClientNodeJs } = require('@lit-protocol/lit-node-client');

// Network from env; default to the free dev network.
const LIT_NETWORK = process.env.LIT_NETWORK || 'datil-dev';

let client = null;
let connecting = null;

// Lazily create + connect a shared client. Concurrent callers await the same
// in-flight connection instead of opening duplicates.
async function getLitNodeClient() {
  if (client && client.ready) return client;

  if (!connecting) {
    const instance = new LitNodeClientNodeJs({
      litNetwork: LIT_NETWORK,
      debug: false,
    });
    connecting = instance
      .connect()
      .then(() => {
        client = instance;
        connecting = null;
        return client;
      })
      .catch((err) => {
        connecting = null;
        throw err;
      });
  }

  return connecting;
}

async function disconnectLit() {
  if (client) {
    try {
      await client.disconnect();
    } finally {
      client = null;
    }
  }
}

module.exports = { getLitNodeClient, disconnectLit, LIT_NETWORK };
