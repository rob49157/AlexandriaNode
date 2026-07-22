const sanitizeHtml = require('sanitize-html');

// pdf-parse v2 exposes a PDFParse class (+ typed exceptions) via its CJS build.
const { PDFParse, PasswordException, InvalidPDFException } = require('pdf-parse');

// file-type v21 is pure ESM - load it lazily via dynamic import from CommonJS.
let _fileTypeFromBuffer;
async function getFileTypeFromBuffer() {
  if (!_fileTypeFromBuffer) {
    ({ fileTypeFromBuffer: _fileTypeFromBuffer } = await import('file-type'));
  }
  return _fileTypeFromBuffer;
}

// --- Config -----------------------------------------------
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const ALLOWED_CATEGORIES = [
  'science', 'history', 'literature', 'philosophy', 'technology',
  'art', 'mathematics', 'medicine', 'law', 'religion', 'reference', 'other',
];

const TITLE_MAX = 300;
const AUTHOR_MAX = 200;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 2000;

// --- Standard result shapes -------------------------------
// Reject carries an internal httpStatus for the controller; the wire body is
// the documented { valid, stage, reason, message }.
function reject(stage, reason, message, httpStatus = 400) {
  return { valid: false, stage, reason, message, httpStatus };
}

// --- Text sanitization ------------------------------------
// Strip ALL HTML/script tags and control characters, collapse whitespace, trim.
function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  const stripped = sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
  return stripped
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ') // control chars -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Layer 1: Basic file validation -----------------------
// file = multer file object { originalname, mimetype, size, buffer }
async function validateLayer1(file) {
  if (!file || !file.buffer) {
    return reject('file_basics', 'missing_file', 'No PDF file received.');
  }
  if (file.size === 0) {
    return reject('file_basics', 'empty_file', 'Uploaded file is empty (0 bytes).');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return reject('file_basics', 'file_too_large', `File exceeds the maximum size of ${MAX_FILE_SIZE_MB} MB.`, 413);
  }

  // Extension check - must be .pdf
  if (!/\.pdf$/i.test(file.originalname || '')) {
    return reject('file_basics', 'invalid_extension', 'File extension must be .pdf.');
  }

  // Client-declared MIME (weak, spoofable - the magic-byte check below is authoritative)
  if (file.mimetype !== 'application/pdf') {
    return reject('file_basics', 'invalid_mime_type', 'Content-Type must be application/pdf.');
  }

  // Magic bytes - detect the TRUE type from content (catches renamed executables/images)
  const fileTypeFromBuffer = await getFileTypeFromBuffer();
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || detected.mime !== 'application/pdf') {
    return reject(
      'file_basics',
      'not_a_pdf',
      `File content is not a PDF (detected: ${detected ? detected.mime : 'unknown'}).`
    );
  }

  // Parseability + page count > 0
  let parser;
  try {
    parser = new PDFParse({ data: file.buffer });
    const result = await parser.getText();
    const pageCount = result.total || (result.pages ? result.pages.length : 0);
    if (!pageCount || pageCount < 1) {
      return reject('file_basics', 'empty_pdf', 'PDF has no pages.');
    }
    return { valid: true, pageCount, text: result.text || '' };
  } catch (err) {
    if (PasswordException && err instanceof PasswordException) {
      return reject('file_basics', 'encrypted_pdf', 'Password-protected PDFs cannot be validated.');
    }
    if (InvalidPDFException && err instanceof InvalidPDFException) {
      return reject('file_basics', 'unparseable_pdf', 'File is not a valid or is a corrupted PDF.');
    }
    return reject('file_basics', 'unparseable_pdf', 'File could not be parsed as a valid PDF.');
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy().catch(() => {});
    }
  }
}

// --- Layer 5: Metadata validation + sanitization ----------
// Returns { valid: true, metadata: <sanitized> } or a reject.
function validateLayer5(rawMetadata = {}) {
  const metadata = {
    title: sanitizeText(rawMetadata.title),
    author: sanitizeText(rawMetadata.author),
    category: sanitizeText(rawMetadata.category).toLowerCase(),
    description: sanitizeText(rawMetadata.description),
  };

  if (!metadata.title) {
    return reject('metadata', 'missing_title', 'Title is required.');
  }
  if (metadata.title.length > TITLE_MAX) {
    return reject('metadata', 'title_too_long', `Title must be at most ${TITLE_MAX} characters.`);
  }
  if (!metadata.author) {
    return reject('metadata', 'missing_author', 'Author is required.');
  }
  if (metadata.author.length > AUTHOR_MAX) {
    return reject('metadata', 'author_too_long', `Author must be at most ${AUTHOR_MAX} characters.`);
  }
  if (!metadata.category) {
    return reject('metadata', 'missing_category', 'Category is required.');
  }
  if (!ALLOWED_CATEGORIES.includes(metadata.category)) {
    return reject('metadata', 'invalid_category', `Category must be one of: ${ALLOWED_CATEGORIES.join(', ')}.`);
  }
  if (metadata.description.length < DESCRIPTION_MIN) {
    return reject('metadata', 'description_too_short', `Description must be at least ${DESCRIPTION_MIN} characters.`);
  }
  if (metadata.description.length > DESCRIPTION_MAX) {
    return reject('metadata', 'description_too_long', `Description must be at most ${DESCRIPTION_MAX} characters.`);
  }

  return { valid: true, metadata };
}

// --- Orchestrator: run available layers in fail-fast order -
// Phase 2 = Layer 1 + Layer 5. Layers 2/3/4 land in later phases.
async function validateUpload(file, rawMetadata) {
  const layer1 = await validateLayer1(file);
  if (!layer1.valid) return layer1;

  const layer5 = validateLayer5(rawMetadata);
  if (!layer5.valid) return layer5;

  return {
    valid: true,
    pageCount: layer1.pageCount,
    metadata: layer5.metadata,
  };
}

module.exports = {
  validateUpload,
  validateLayer1,
  validateLayer5,
  sanitizeText,
  ALLOWED_CATEGORIES,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
};
