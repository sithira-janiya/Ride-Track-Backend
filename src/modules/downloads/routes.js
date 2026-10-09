import fs from 'node:fs';

import { Router } from 'express';
import QRCode from 'qrcode';

import { env } from '../../config/env.js';
import { wrap } from '../../utils/async.js';
import { notFound } from '../../utils/errors.js';

/**
 * Android app download. The QR code always encodes the same URL (`/download/android`), so a printed code keeps
 * working when a new APK is built: replace the file at APK_PATH, or point APK_URL at the new build.
 */
const router = Router();

export const androidDownloadUrl = () => `${env.publicUrl}/download/android`;

const qrOptions = { errorCorrectionLevel: 'M', margin: 2, width: 512 };
// replaces helmet's default, whose upgrade-insecure-requests breaks the QR image on a plain-HTTP (LAN) deployment
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

router.get('/android', (req, res, next) => {
  if (env.apkUrl) return res.redirect(302, env.apkUrl);
  if (!fs.existsSync(env.apkPath)) return next(notFound('The Android app is not available yet.', 'APK_NOT_FOUND'));
  // Content-Disposition: attachment makes the phone's browser download it straight away; the type comes from ".apk".
  // no-cache: revalidate (ETag) so a rebuilt APK is never served stale.
  return res.download(env.apkPath, 'RideTrack.apk', { headers: { 'Cache-Control': 'no-cache' } }, (err) => err && !res.headersSent && next(err));
});

router.get('/android/qr.svg', wrap(async (_req, res) => {
  res.type('image/svg+xml').send(await QRCode.toString(androidDownloadUrl(), { ...qrOptions, type: 'svg' }));
}));

router.get('/android/qr.png', wrap(async (_req, res) => {
  res.type('png').send(await QRCode.toBuffer(androidDownloadUrl(), qrOptions));
}));

/** A page to show or print: the QR code plus a direct link for people already on their phone. */
router.get('/', (_req, res) => {
  const url = androidDownloadUrl();
  res.set('Content-Security-Policy', CSP).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get RideTrack</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0B5FFF; color: #fff; }
  main { text-align: center; padding: 24px 16px; }
  img { width: min(300px, 80vw); background: #fff; border-radius: 16px; padding: 12px; }
  a { display: inline-block; margin-top: 20px; padding: 14px 24px; border-radius: 999px; background: #fff; color: #0B5FFF; font-weight: 600; text-decoration: none; }
  p { opacity: .85; } code { word-break: break-all; }
</style></head>
<body><main>
  <h1>RideTrack for Android</h1>
  <p>Scan with your phone camera. The app downloads automatically.</p>
  <img src="/download/android/qr.svg" alt="QR code for ${url}">
  <div><a href="/download/android">Download the APK</a></div>
  <p><code>${url}</code></p>
</main></body></html>`);
});

export default router;
