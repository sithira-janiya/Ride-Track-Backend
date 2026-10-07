import { AppError } from '../utils/errors.js';

export function notFoundHandler(_req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', 'That endpoint does not exist.'));
}

/** Every failure leaves as `{ error: { code, message } }`. Unexpected errors are logged but never leaked. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  // body-parser errors: malformed JSON, payload too large
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is not valid JSON.' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' } });
  }
  console.error(`[${req.id ?? '-'}] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } });
}
