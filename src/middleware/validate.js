import { badRequest } from '../utils/errors.js';

/**
 * Validates `req.body`, `req.query` and `req.params` against zod schemas.
 * Parsed values land on `req.valid.{body,query,params}`; the raw request is left untouched.
 */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    const valid = {};
    for (const [key, schema] of Object.entries({ body, query, params })) {
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue.path.join('.');
        return next(badRequest(field ? `${field}: ${issue.message}` : issue.message));
      }
      valid[key] = result.data;
    }
    req.valid = valid;
    return next();
  };
