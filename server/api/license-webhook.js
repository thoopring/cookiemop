// Vercel serverless function: Lemon Squeezy purchase -> signed license -> email.
//
// This is the ONLY networked piece of CookieMop, and it is deliberately not
// part of the extension. The extension never calls this endpoint; the buyer
// receives a key by email and pastes it into the options page, where it is
// verified locally.
//
// Required environment variables (Vercel > Settings > Environment Variables):
//   LICENSE_PRIVATE_KEY   PKCS#8 PEM of the ECDSA P-256 signing key
//   LS_WEBHOOK_SECRET     Lemon Squeezy webhook signing secret
//   RESEND_API_KEY        Resend API key used to send the license email
//   LICENSE_FROM_EMAIL    From address, e.g. "CookieMop <keys@yourdomain.com>"
//
// Lemon Squeezy webhook setup: point it at https://<deployment>/api/license-webhook
// and subscribe to the `order_created` event.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { signLicense } from '../lib/sign-license.js';

// Vercel parses JSON bodies by default, but HMAC must be computed over the
// exact bytes that were sent, so raw body access is required.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function signatureMatches(rawBody, headerSignature, secret) {
  if (!headerSignature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided;
  try {
    provided = Buffer.from(headerSignature, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

async function sendLicenseEmail({ to, licenseKey, orderId }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.LICENSE_FROM_EMAIL,
      to: [to],
      subject: 'Your CookieMop Pro license key',
      text: [
        'Thanks for buying CookieMop Pro.',
        '',
        'Your license key:',
        '',
        licenseKey,
        '',
        'To activate it:',
        '  1. Open the CookieMop options page (extension icon > gear).',
        '  2. Scroll to "CookieMop Pro".',
        '  3. Paste the key and press Activate.',
        '',
        'The key is checked on your own device. CookieMop makes no network',
        'requests, so activation works offline and keeps working even if this',
        'service ever goes away.',
        '',
        'Keep this email — it is your proof of purchase.',
        `Order: ${orderId}`,
        '',
        'Questions: https://github.com/thoopring/cookiemop/issues'
      ].join('\n')
    })
  });
  if (!response.ok) {
    throw new Error(`email send failed: ${response.status} ${await response.text()}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const requiredEnv = [
    'LICENSE_PRIVATE_KEY',
    'LS_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'LICENSE_FROM_EMAIL'
  ].filter((name) => !process.env[name]);
  if (requiredEnv.length) {
    console.error('missing environment variables:', requiredEnv.join(', '));
    return res.status(500).json({ error: 'server misconfigured' });
  }

  const rawBody = await readRawBody(req);

  // Verify the webhook before trusting anything in it. Without this check,
  // anyone who knows the URL could mint themselves a free license.
  if (!signatureMatches(rawBody, req.headers['x-signature'], process.env.LS_WEBHOOK_SECRET)) {
    console.warn('rejected webhook with an invalid signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  const eventName = event?.meta?.event_name;
  if (eventName !== 'order_created') {
    // Acknowledge everything else so Lemon Squeezy stops retrying.
    return res.status(200).json({ ignored: eventName || 'unknown' });
  }

  const attributes = event?.data?.attributes || {};
  const email = attributes.user_email;
  const orderId = event?.data?.id || attributes.identifier;
  if (!email || !orderId) {
    console.error('order_created without email or order id');
    return res.status(400).json({ error: 'missing order fields' });
  }
  // A refunded or failed order must not produce a key.
  if (attributes.status && attributes.status !== 'paid') {
    return res.status(200).json({ ignored: `status ${attributes.status}` });
  }

  let licenseKey;
  try {
    licenseKey = signLicense({
      email,
      orderId,
      privateKeyPem: process.env.LICENSE_PRIVATE_KEY
    });
  } catch (error) {
    console.error('signing failed:', error.message);
    return res.status(500).json({ error: 'signing failed' });
  }

  try {
    await sendLicenseEmail({ to: email, licenseKey, orderId });
  } catch (error) {
    // The key is deterministic for a given order, so a resend can recover
    // this. Return 500 so Lemon Squeezy retries the webhook.
    console.error('email failed for order', orderId, error.message);
    return res.status(500).json({ error: 'email failed' });
  }

  // Never log the key itself — logs are not a safe place for it.
  console.log('license issued for order', orderId);
  return res.status(200).json({ ok: true });
}
