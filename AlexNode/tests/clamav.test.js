const assert = require('node:assert/strict');
const net = require('node:net');
const { scanWithClamAV } = require('../services/securityScan.service');

async function withMockClamd(response, test) {
  const server = net.createServer((socket) => {
    const request = [];
    socket.on('data', (chunk) => request.push(chunk));
    socket.on('end', () => {
      const bytes = Buffer.concat(request);
      assert.equal(bytes.subarray(0, 10).toString(), 'zINSTREAM\0');
      assert.deepEqual(bytes.subarray(-4), Buffer.alloc(4));
      // Keep the connection open after the reply, as clamd is allowed to do.
      socket.write(`${response}\0`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const previous = {
    host: process.env.CLAMAV_HOST,
    port: process.env.CLAMAV_PORT,
    required: process.env.CLAMAV_REQUIRED,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(server.address().port);
  process.env.CLAMAV_REQUIRED = 'true';
  process.env.NODE_ENV = 'production';

  try {
    return await test();
  } finally {
    for (const [key, value] of Object.entries({
      CLAMAV_HOST: previous.host,
      CLAMAV_PORT: previous.port,
      CLAMAV_REQUIRED: previous.required,
      NODE_ENV: previous.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  const sample = Buffer.from('harmless test content');

  const clean = await withMockClamd('stream: OK', () => scanWithClamAV(sample));
  assert.deepEqual(clean, { valid: true }, 'NUL-terminated OK response is accepted without waiting for EOF');

  const infected = await withMockClamd('stream: Eicar-Test-Signature FOUND', () => scanWithClamAV(sample));
  assert.equal(infected.valid, false, 'FOUND response is rejected');
  assert.equal(infected.reason, 'virus_detected');

  const daemonError = await withMockClamd('stream: INSTREAM size limit exceeded. ERROR', () => scanWithClamAV(sample));
  assert.equal(daemonError.valid, false, 'clamd ERROR is not mistaken for a clean scan');
  assert.equal(daemonError.reason, 'clamav_error');
  assert.equal(daemonError.httpStatus, 503);

  const previous = {
    host: process.env.CLAMAV_HOST,
    port: process.env.CLAMAV_PORT,
    required: process.env.CLAMAV_REQUIRED,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = '1'; // Reserved low port: no clamd listener expected.
  process.env.CLAMAV_REQUIRED = '';
  process.env.NODE_ENV = 'production';
  try {
    const unavailable = await scanWithClamAV(sample);
    assert.equal(unavailable.valid, false, 'Unavailable ClamAV fails closed in production by default');
    assert.equal(unavailable.reason, 'clamav_unavailable');
    assert.equal(unavailable.httpStatus, 503);
  } finally {
    for (const [key, value] of Object.entries({
      CLAMAV_HOST: previous.host,
      CLAMAV_PORT: previous.port,
      CLAMAV_REQUIRED: previous.required,
      NODE_ENV: previous.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('ClamAV tests passed (clean, infected, daemon error, persistent connection, production fail-closed).');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
