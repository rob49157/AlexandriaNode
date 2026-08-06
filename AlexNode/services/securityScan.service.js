// Layer 2: PDF structural security scanner.
//
// Scans the raw PDF buffer for dangerous dictionary entries BEFORE encryption
// or Arweave/Irys upload. Once on Arweave, storage is permanent and immutable —
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
// ClamAV virus scanning is optional — connects to clamd if available,
// falls back gracefully in dev mode.

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

/**
 * Scan a PDF buffer for dangerous structural patterns.
 *
 * @param {Buffer} pdfBuffer — raw PDF bytes (from multer memoryStorage)
 * @returns {{ valid: boolean, stage?: string, reason?: string, message?: string, threats?: string[] }}
 */
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

/**
 * Check if a PDF is encrypted/password-protected via the /Encrypt trailer entry.
 *
 * @param {Buffer} pdfBuffer
 * @returns {{ valid: boolean, stage?: string, reason?: string, message?: string }}
 */
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

const CLAMAV_HOST = process.env.CLAMAV_HOST || '127.0.0.1';
const CLAMAV_PORT = parseInt(process.env.CLAMAV_PORT, 10) || 3310;
const CLAMAV_TIMEOUT = parseInt(process.env.CLAMAV_TIMEOUT, 10) || 30000;

/**
 * Scan a buffer for viruses using ClamAV daemon (clamd).
 *
 * @param {Buffer} buffer — file bytes to scan
 * @returns {Promise<{ valid: boolean, stage?: string, reason?: string, message?: string, skipped?: boolean }>}
 */
async function scanWithClamAV(buffer) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let response = '';

    socket.setTimeout(CLAMAV_TIMEOUT);

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
    });

    socket.on('data', (data) => {
      response += data.toString();
    });

    socket.on('end', () => {
      socket.destroy();
      // ClamAV response: "stream: OK" or "stream: <virusname> FOUND"
      const trimmed = response.trim();
      if (trimmed.includes('FOUND')) {
        const virusName = trimmed.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
        resolve(reject('virus_detected', `ClamAV detected malware: ${virusName}.`));
      } else {
        resolve({ valid: true });
      }
    });

    socket.on('error', (err) => {
      socket.destroy();
      // ClamAV not running — log warning and skip (structural scan is still active)
      console.warn(`[SecurityScan] ClamAV daemon not available (${err.code || err.message}). Structural scan still active.`);
      resolve({ valid: true, skipped: true, skipReason: 'clamav_unavailable' });
    });

    socket.on('timeout', () => {
      socket.destroy();
      console.warn('[SecurityScan] ClamAV scan timed out. Structural scan still active.');
      resolve({ valid: true, skipped: true, skipReason: 'clamav_timeout' });
    });

    socket.connect(CLAMAV_PORT, CLAMAV_HOST);
  });
}

// --- Combined Layer 2 security scan ---

/**
 * Run the full Layer 2 security scan pipeline.
 *
 * Order: structural scan → encrypted check → ClamAV virus scan.
 * Fails fast on the first threat detected.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ valid: boolean, clamavSkipped?: boolean }>}
 */
async function validateLayer2(pdfBuffer) {
  // 1. Structural pattern scan (fast, no I/O)
  const structResult = scanPdfStructure(pdfBuffer);
  if (!structResult.valid) return structResult;

  // 2. Encrypted/password-protected check
  const encryptResult = checkEncrypted(pdfBuffer);
  if (!encryptResult.valid) return encryptResult;

  // 3. ClamAV virus scan (optional, network I/O)
  const clamResult = await scanWithClamAV(pdfBuffer);
  if (!clamResult.valid) return clamResult;

  return {
    valid: true,
    clamavSkipped: clamResult.skipped || false,
  };
}

module.exports = {
  scanPdfStructure,
  checkEncrypted,
  scanWithClamAV,
  validateLayer2,
  DANGEROUS_PATTERNS,
};
