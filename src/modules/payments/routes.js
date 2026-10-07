import express, { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { AppError, unauthorized } from '../../utils/errors.js';
import { safeEqualHex, sign } from './gateway.js';
import { applyPaymentResult } from './service.js';

const router = Router();

/**
 * Gateway callback. Authenticity comes from `x-signature` = HMAC-SHA256(raw body, PAYMENT_GATEWAY_KEY);
 * the raw bytes are captured in app.js because re-serialising parsed JSON would change them.
 */
function verifySignature(req, _res, next) {
  return safeEqualHex(req.headers['x-signature'] ?? '', sign(req.rawBody ?? ''))
    ? next()
    : next(unauthorized('Invalid signature.', 'INVALID_SIGNATURE'));
}

router.post(
  '/webhook',
  verifySignature, // check authenticity before looking at the contents
  validate({
    body: z.object({
      ticketId: z.number().int().positive(),
      gatewayRef: z.string().max(100).optional(),
      status: z.enum(['PAID', 'FAILED']),
    }),
  }),
  wrap(async (req, res) => send(res, { status: await applyPaymentResult(req.valid.body) })),
);

// ---------- mock gateway (development and demos only) ----------

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'";
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RideTrack test payment</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px}button{font:inherit;font-weight:700;width:100%;padding:14px;margin-top:12px;border-radius:12px;border:2px solid #0b5fff;background:#0b5fff;color:#fff}button.alt{background:#fff;color:#0b5fff}.note{color:#4a5365;font-size:15px}</style></head>
<body>${body}</body></html>`;

if (env.paymentGateway === 'mock') {
  router.get(
    '/mock/checkout/:ticketId',
    validate({ params: z.object({ ticketId: z.coerce.number().int().positive() }), query: z.object({ sig: z.string() }) }),
    wrap(async (req, res) => {
      const { ticketId } = req.valid.params;
      if (!safeEqualHex(req.valid.query.sig, sign(`checkout:${ticketId}`))) throw new AppError(403, 'INVALID_SIGNATURE', 'Invalid payment link.');
      res.set('Content-Security-Policy', CSP).type('html').send(
        page(`<h1>RideTrack</h1><p>Test payment for ticket <b>${ticketId}</b>.</p><p class="note">This is a mock gateway. No money moves.</p>
<form method="post" action="/api/v1/payments/mock/complete">
<input type="hidden" name="ticketId" value="${ticketId}"><input type="hidden" name="sig" value="${req.valid.query.sig}">
<button name="outcome" value="paid">Pay now</button><button class="alt" name="outcome" value="failed">Decline payment</button></form>`),
      );
    }),
  );

  router.post(
    '/mock/complete',
    express.urlencoded({ extended: false }),
    validate({ body: z.object({ ticketId: z.coerce.number().int().positive(), sig: z.string(), outcome: z.enum(['paid', 'failed']) }) }),
    wrap(async (req, res) => {
      const { ticketId, sig, outcome } = req.valid.body;
      if (!safeEqualHex(sig, sign(`checkout:${ticketId}`))) throw new AppError(403, 'INVALID_SIGNATURE', 'Invalid payment link.');
      const status = await applyPaymentResult({ ticketId, gatewayRef: `mock-${Date.now()}`, status: outcome === 'paid' ? 'PAID' : 'FAILED' });
      res.set('Content-Security-Policy', CSP).type('html').send(
        page(`<h1>${status === 'PAID' ? 'Payment received' : 'Payment not completed'}</h1>
<p>${status === 'PAID' ? 'Your ticket is ready. Return to the RideTrack app.' : 'Nothing was charged. Return to the RideTrack app.'}</p>
<p class="note">If the app does not reopen by itself, close this page.</p>
<script>setTimeout(function(){location.href='rtexpo://payment-return'},600)</script>`),
      );
    }),
  );
}

export default router;
