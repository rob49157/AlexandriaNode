// Layer 2: PDF structural security scanner.
//
// Scans the raw PDF buffer for dangerous dictionary entries BEFORE encryption
// or Arweave upload. Once on Arweave, storage is permanent and immutable —
// malicious content can never be removed.
//
// Detected threats:
//   /JS, /JavaScript        — embedded scripts that execute in PDF viewers
//   /OpenAction, /AA        — auto-actions triggered on document/page open
//   /Launch                 — external process / shell command execution
//   /EmbeddedFiles, /EF     — hidden binary attachments or executables
//   /SubmitForm, /ImportData — unsanitized remote data submission
//   /Encrypt                — password-protected PDFs that hide content from inspection
//
// ClamAV is required by default in production. Development can explicitly run
// without clamd, but that state is recorded as skipped and is never called clean.

// --- Standard reject shape (matches validation.service.js) ---
function reject(reason, message, httpStatus = 400) {
  return { valid: false, stage: 'security_scan', reason, message, httpStatus };
}

// --- Dangerous PDF dictionary keys ---
// Each entry: { pattern, reason, message }
// We search for these as byte sequences in the raw PDF buffer.
const DANGEROUS_PATTERNS = [
  {
    pattern: /\/JS\b/,
    reason: 'embedded_javascript',
    message: 'PDF contains embedded JavaScript (/JS) which is not allowed.',
  },
  {
    pattern: /\/JavaScript\b/,
    reason: 'embedded_javascript',
    message: 'PDF contains embedded JavaScript (/JavaScript) which is not allowed.',
  },
  {
    pattern: /\/OpenAction\b/,
    reason: 'auto_action',
    message: 'PDF contains an auto-execute action (/OpenAction) triggered on open.',
  },
  {
    pattern: /\/AA\b/,
    reason: 'auto_action',
    message: 'PDF contains additional actions (/AA) that execute automatically.',
  },
  {
    pattern: /\/Launch\b/,
    reason: 'launch_action',
    message: 'PDF contains a /Launch action that can execute external programs.',
  },
  {
    pattern: /\/EmbeddedFiles\b/,
    reason: 'embedded_files',
    message: 'PDF contains embedded file attachments (/EmbeddedFiles) which are not allowed.',
  },
  {
    pattern: /\/EF\b/,
    reason: 'embedded_files',
    message: 'PDF contains an embedded file stream (/EF) which is not allowed.',
  },
  {
    pattern: /\/SubmitForm\b/,
    reason: 'form_submission',
    message: 'PDF contains a form submission action (/SubmitForm) which is not allowed.',
  },
  {
    pattern: /\/ImportData\b/,
    reason: 'data_import',
    message: 'PDF contains a data import action (/ImportData) which is not allowed.',
  },
];

// --- Structural scan ---
// Converts the PDF buffer to a latin1 string and scans for dangerous patterns.
// This catches the vast majority of PDF-based exploits without needing a full
// PDF parser — the dictionary keys are plaintext in uncompressed objects and
// in the cross-reference table / trailer.

// Scan a PDF buffer for dangerous structural patterns.
function scanPdfStructure(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    return reject('invalid_input', 'No PDF buffer provided for security scanning.');
  }

  // Convert buffer to string for regex matching.
  // latin1 preserves all byte values 0x00-0xFF without interpretation.
  const content = pdfBuffer.toString('latin1');

  const threats = [];

  for (const { pattern, reason, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(reason);
      // Return on first threat found (fail-fast, matching validation pipeline style)
      return reject(reason, message);
    }
  }

  return { valid: true, threats: [] };
}

// --- Encrypted/password-protected PDF detection ---
// pdf-parse already catches PasswordException in Layer 1.
// This is a belt-and-suspenders check on the raw bytes for /Encrypt dictionary.

// Check if a PDF is encrypted/password-protected via the /Encrypt trailer entry.
function checkEncrypted(pdfBuffer) {
  const content = pdfBuffer.toString('latin1');
  if (/\/Encrypt\b/.test(content)) {
    return reject(
      'encrypted_pdf',
      'PDF appears to be encrypted or password-protected. Cannot validate content for permanent storage.'
    );
  }
  return { valid: true };
}

// --- ClamAV virus scan ---
// Connects to clamd daemon on port 3310 (default).
// Sends the buffer via INSTREAM protocol.
// Falls back gracefully if clamd is not running.

const net = require('net');

function getClamAVConfig() {
  const port = Number.parseInt(process.env.CLAMAV_PORT || '3310', 10);
  const timeout = Number.parseInt(process.env.CLAMAV_TIMEOUT || '30000', 10);
  return {
    host: process.env.CLAMAV_HOST || '127.0.0.1',
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3310,
    timeout: Number.isInteger(timeout) && timeout > 0 ? timeout : 30000,
    required: process.env.CLAMAV_REQUIRED === 'true' ||
      (process.env.NODE_ENV === 'production' && process.env.CLAMAV_REQUIRED !== 'false'),
  };
}

function clamavFailure(reason, message, required) {
  if (required) {
    return reject(reason, message, 503);
  }
  console.warn(`[SecurityScan] ${message} ClamAV is optional in this environment; scan skipped.`);
  return { valid: true, skipped: true, skipReason: reason };
}

// Scan a buffer for viruses using ClamAV daemon (clamd).
async function scanWithClamAV(buffer) {
  const config = getClamAVConfig();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let response = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const handleResponse = (rawResponse) => {
      const trimmed = rawResponse.replace(/[\0\r\n]+$/, '').trim();
      if (/\bFOUND$/.test(trimmed)) {
        const virusName = trimmed.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
        finish(reject('virus_detected', `ClamAV detected malware: ${virusName}.`));
      } else if (/^stream:\s*OK$/i.test(trimmed)) {
        finish({ valid: true });
      } else {
        finish(clamavFailure(
          'clamav_error',
          `ClamAV returned an invalid or error response (${trimmed || 'empty response'}).`,
          config.required
        ));
      }
    };

    socket.setTimeout(config.timeout);

    socket.on('connect', () => {
      // ClamAV INSTREAM protocol:
      // 1. Send "zINSTREAM\0"
      // 2. Send chunks: [4-byte big-endian length][data]
      // 3. Send terminator: [4 zero bytes]
      socket.write('zINSTREAM\0');

      // Send the buffer in chunks (max 2MB per chunk for clamd)
      const CHUNK_SIZE = 2 * 1024 * 1024;
      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        const lengthBuf = Buffer.alloc(4);
        lengthBuf.writeUInt32BE(chunk.length, 0);
        socket.write(lengthBuf);
        socket.write(chunk);
      }

      // Terminator
      socket.write(Buffer.alloc(4, 0));
      // Half-close our side after the INSTREAM terminator. clamd may keep the
      // connection open, so completion is driven by its NUL-terminated reply.
      socket.end();
    });

    socket.on('data', (data) => {
      response += data.toString();
      const terminator = response.search(/[\0\r\n]/);
      if (terminator !== -1) handleResponse(response.slice(0, terminator));
    });

    socket.on('end', () => {
      if (!settled) handleResponse(response);
    });

    socket.on('error', (err) => {
      finish(clamavFailure(
        'clamav_unavailable',
        `ClamAV daemon is unavailable (${err.code || err.message}).`,
        config.required
      ));
    });

    socket.on('timeout', () => {
      finish(clamavFailure('clamav_timeout', 'ClamAV scan timed out.', config.required));
    });

    socket.on('close', () => {
      if (!settled) {
        finish(clamavFailure(
          'clamav_error',
          `ClamAV closed the connection without a complete response (${response.trim() || 'empty response'}).`,
          config.required
        ));
      }
    });

    socket.connect(config.port, config.host);
  });
}

// --- Combined Layer 2 security scan ---

// scanWithClamAV skipReason → the value persisted on the upload row.
const CLAMAV_STATUS = {
  clamav_unavailable: 'unavailable',
  clamav_timeout: 'timeout',
  clamav_error: 'error',
};

// Run the full Layer 2 security scan pipeline:
// Order: structural scan → encrypted check → ClamAV virus scan (fails fast on first threat).
async function validateLayer2(pdfBuffer) {
  // 1. Structural pattern scan (fast, no I/O)
  const structResult = scanPdfStructure(pdfBuffer);
  if (!structResult.valid) return structResult;

  // 2. Encrypted/password-protected check
  const encryptResult = checkEncrypted(pdfBuffer);
  if (!encryptResult.valid) return encryptResult;

  // 3. ClamAV virus scan (network I/O; required in production by default)
  const clamResult = await scanWithClamAV(pdfBuffer);
  if (!clamResult.valid) return clamResult;

  return {
    valid: true,
    clamavSkipped: clamResult.skipped || false,
    // A skipped scan is not a clean scan, and the difference has to survive as
    // far as the librarian: an infected file is rejected here and never stored,
    // so every book in the review queue "passed" — the only thing left worth
    // saying is whether the virus scanner was actually running at the time.
    clamavStatus: CLAMAV_STATUS[clamResult.skipReason] || 'clean',
  };
}

module.exports = {
  scanPdfStructure,
  checkEncrypted,
  scanWithClamAV,
  validateLayer2,
  DANGEROUS_PATTERNS,
  CLAMAV_STATUS,
};
