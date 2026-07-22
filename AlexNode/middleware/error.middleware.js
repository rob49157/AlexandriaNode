const multer = require('multer');

// 404 handler for unmatched routes — keep it before the error handler.
function notFound(req, res, next) {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.originalUrl}` });
}

// Global error handler. Must keep the 4-arg signature so Express treats it as
// an error handler. Translates known errors (multer) into clean responses and
// falls back to 500 for everything else.
function errorHandler(err, req, res, next) {
  // Multer errors — most importantly, oversized files (Layer 1 size cap → 413).
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        valid: false,
        stage: 'file_basics',
        reason: 'file_too_large',
        message: `File exceeds the maximum allowed size of ${process.env.MAX_FILE_SIZE_MB || 50} MB.`,
      });
    }
    return res.status(400).json({
      valid: false,
      stage: 'file_basics',
      reason: 'upload_error',
      message: err.message,
    });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('Unhandled error:', err);
  }

  res.status(status).json({
    error: err.code || 'internal_error',
    message: status >= 500 ? 'Internal server error' : err.message,
  });
}

module.exports = { notFound, errorHandler };
