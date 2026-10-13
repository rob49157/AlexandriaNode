// A fake Arweave network for tests, installed as global.fetch.
//
// Every status code and body shape here is copied from what real mainnet nodes
// answered in Phase 0 (tests/fixtures/arweave-node-responses.json and
// .arweave-spike/*/run.json), NOT from documentation. That is the lesson of the
// base58 incident (CLAUDE.md): a fake written from a doc certified a bug.
//
//   GET  /info                 {"network":"arweave.N.1","height":…}
//   GET  /tx_anchor            64-char base64url block hash, no JSON
//   GET  /block/hash/{h}       JSON with numeric `height`
//   GET  /price/{bytes}        bare winston integer
//   GET  /wallet/{a}/balance   bare winston integer
//   POST /tx                   200 "OK"; 400 "Invalid anchor (last_tx)." once expired
//   GET  /tx/{id}/status       200 {block_height,block_indep_hash,number_of_confirmations}
//                              | 202 "Pending" | 404 "Not Found."
//   POST /chunk                200 "" (keeps it) | 303 "" (temporary) | 400 {"error":…}
//   GET  /tx/{id}/offset       {"size":"…","offset":"…"} (strings), only once mined
//   GET  /chunk/{abs}          {data_path,tx_path,absolute_end_offset,packing,chunk,chunk_size} | 404 ""
//   GET  /tx/{id}              the header, "data":""
//
// Chunk proofs are validated with arweave-js's own Merkle code, as a real node
// does, so a wrong chunk or path is rejected rather than silently accepted.

const crypto = require('crypto');
const Transaction = require('arweave/node/lib/transaction').default;
const { validatePath } = require('arweave/node/lib/merkle');

const NETWORK = 'arweave.N.1';

function createFakeArweave({ nodeUrls, height = 2_020_000, price = '13530674461', balance = '3000000000000' }) {
  const net = {
    height,
    price,
    balance,
    anchors: new Map(), // anchor hash -> height
    txs: new Map(), // id -> { header, minedAt?, start? }
    weaveEnd: 392_123_000_000_000n,
    calls: [],
    nodes: new Map(),
  };
  for (const url of nodeUrls) {
    net.nodes.set(url, {
      url,
      up: true,
      chunkMode: 200, // 200 | 303 | 'exceeds_disk_pool_size_limit' | 'fatal'
      postTxMode: 200, // 200 | 500
      // Blocks this node's view trails the network by, for POST /tx only: it still
      // counts an anchor as valid that the network has expired, so it answers the
      // observed 200 "OK" to a header that can never be mined (a stale node).
      postTxLag: 0,
      chunks: new Map(), // data_root -> Map(endRel -> { chunk, data_path })
      dropChunks: false, // answers GET /chunk with 404 (lost / never stored)
      tamperChunks: false, // serves corrupted chunk bytes
    });
  }

  const newAnchor = () => {
    const a = crypto.randomBytes(48).toString('base64url');
    net.anchors.set(a, net.height);
    return a;
  };

  net.mine = (id, at = net.height) => {
    const t = net.txs.get(id);
    if (!t) throw new Error(`fake: no tx ${id}`);
    const size = BigInt(t.header.data_size);
    t.minedAt = at;
    t.start = net.weaveEnd + 1n;
    net.weaveEnd += size;
  };
  net.advance = (blocks) => {
    net.height += blocks;
  };
  net.callsTo = (re) => net.calls.filter((c) => re.test(`${c.method} ${c.path}`));

  const reply = (status, body = '') => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => Buffer.from(text),
    };
  };

  async function handle(node, method, path, body) {
    let m;
    if (method === 'GET' && path === '/info') return reply(200, { network: NETWORK, height: net.height, release: 110 });
    if (method === 'GET' && path === '/peers') return reply(200, []);
    if (method === 'GET' && path === '/tx_anchor') return reply(200, newAnchor());
    if (method === 'GET' && (m = path.match(/^\/block\/hash\/(.+)$/))) {
      return net.anchors.has(m[1]) ? reply(200, { height: net.anchors.get(m[1]) }) : reply(404, 'Not Found.');
    }
    if (method === 'GET' && /^\/price\/\d+$/.test(path)) return reply(200, net.price);
    if (method === 'GET' && /^\/wallet\/[^/]+\/balance$/.test(path)) return reply(200, net.balance);

    if (method === 'POST' && path === '/tx') {
      if (node.postTxMode !== 200) return reply(node.postTxMode, 'Internal error');
      const header = JSON.parse(body);
      const anchorHeight = net.anchors.get(header.last_tx);
      if (anchorHeight === undefined || net.height - node.postTxLag > anchorHeight + 50) return reply(400, 'Invalid anchor (last_tx).');
      const tx = new Transaction(header);
      if (!(await require('arweave').init({}).transactions.verify(tx))) return reply(400, 'Transaction verification failed.');
      if (!net.txs.has(header.id)) net.txs.set(header.id, { header: { ...header, data: '' } });
      return reply(200, 'OK');
    }

    if (method === 'GET' && (m = path.match(/^\/tx\/([^/]+)\/status$/))) {
      const t = net.txs.get(m[1]);
      if (!t) return reply(404, 'Not Found.');
      if (t.minedAt === undefined) return reply(202, 'Pending');
      return reply(200, {
        block_height: t.minedAt,
        block_indep_hash: 'x'.repeat(64),
        number_of_confirmations: net.height - t.minedAt + 1,
      });
    }

    if (method === 'POST' && path === '/chunk') {
      const c = JSON.parse(body);
      const known = [...net.txs.values()].some((t) => t.header.data_root === c.data_root);
      if (!known) return reply(400, { error: 'data_root_not_found' });
      if (node.chunkMode === 'fatal') return reply(400, { error: 'invalid_proof' });
      if (typeof node.chunkMode === 'string') return reply(400, { error: node.chunkMode });
      const proof = await validatePath(
        Buffer.from(c.data_root, 'base64url'),
        Number(c.offset),
        0,
        Number(c.data_size),
        Buffer.from(c.data_path, 'base64url')
      );
      if (!proof) return reply(400, { error: 'invalid_proof' });
      if (node.chunkMode === 303) return reply(303, '');
      if (!node.chunks.has(c.data_root)) node.chunks.set(c.data_root, new Map());
      node.chunks.get(c.data_root).set(proof.rightBound - 1, { chunk: c.chunk, data_path: c.data_path });
      return reply(200, '');
    }

    if (method === 'GET' && (m = path.match(/^\/tx\/([^/]+)\/offset$/))) {
      const t = net.txs.get(m[1]);
      if (!t || t.start === undefined) return reply(404, 'Not Found.');
      const size = BigInt(t.header.data_size);
      return reply(200, { size: String(size), offset: String(t.start + size - 1n) });
    }

    if (method === 'GET' && (m = path.match(/^\/chunk\/(\d+)$/))) {
      if (node.dropChunks) return reply(404, '');
      const abs = BigInt(m[1]);
      const t = [...net.txs.values()].find(
        (x) => x.start !== undefined && abs >= x.start && abs < x.start + BigInt(x.header.data_size)
      );
      if (!t) return reply(404, '');
      const rel = Number(abs - t.start);
      const stored = node.chunks.get(t.header.data_root);
      if (!stored) return reply(404, '');
      for (const [end, v] of stored) {
        const len = Buffer.from(v.chunk, 'base64url').length;
        if (rel <= end && rel >= end - len + 1) {
          let chunk = v.chunk;
          if (node.tamperChunks) {
            const b = Buffer.from(v.chunk, 'base64url');
            b[0] ^= 0xff;
            chunk = b.toString('base64url');
          }
          return reply(200, {
            data_path: v.data_path,
            tx_path: '',
            absolute_end_offset: String(t.start + BigInt(end)),
            packing: 'unpacked',
            chunk,
            chunk_size: len,
          });
        }
      }
      return reply(404, '');
    }

    if (method === 'GET' && (m = path.match(/^\/tx\/([^/]+)$/))) {
      const t = net.txs.get(m[1]);
      return t ? reply(200, t.header) : reply(404, 'Not Found.');
    }
    return reply(400, 'Request type not found.');
  }

  net.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    const method = (opts.method || 'GET').toUpperCase();
    net.calls.push({ node: origin, method, path: u.pathname });
    const node = net.nodes.get(origin);
    if (!node || !node.up) {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    return handle(node, method, u.pathname, opts.body);
  };

  return net;
}

module.exports = { createFakeArweave };
