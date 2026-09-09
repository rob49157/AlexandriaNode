const multer = require('multer');
const { MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES } = require('../config/uploadLimits');

// In-memory storage: the raw PDF lives in req.file.buffer only for the duration
// of the request. Nothing is written to disk (per the "no unencrypted PDF on
// disk" rule). Deeper validation (magic bytes, parseability) happens in Phase 2.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

// Single file upload under the `file` form field: multipart/form-data field name = "file".
const uploadSinglePdf = upload.single('file');

module.exports = { uploadSinglePdf, MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES };
