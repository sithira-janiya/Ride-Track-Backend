/** An error we expect and can describe to the client: `{ error: { code, message } }` with an HTTP status. */
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'VALIDATION_ERROR') => new AppError(400, code, message);
export const unauthorized = (message = 'Please log in again.', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = 'You are not allowed to do this.', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = 'Not found.', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);
