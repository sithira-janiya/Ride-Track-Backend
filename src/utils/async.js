/** Express 4 does not catch rejected promises; wrap async handlers so errors reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Sends `{ data }` with the given status. */
export const send = (res, data, status = 200) => res.status(status).json({ data });
