// POST /api/license — the only endpoint CookieMop has.
//
// Body: { email, orderNumber }
// Verifies the purchase against the Lemon Squeezy API, then signs and
// returns a license key. Nothing is stored: signing is deterministic, so
// the same purchase always yields the same key and a buyer can look it up
// again forever.
//
// The extension never calls this. A buyer copies the key into the options
// page, where it is verified offline.
//
// Environment variables (Vercel > Settings > Environment Variables):
//   LICENSE_PRIVATE_KEY    PKCS#8 PEM of the ECDSA P-256 signing key
//   LEMONSQUEEZY_API_KEY   Lemon Squeezy API key
//   LS_STORE_ID            Lemon Squeezy store id
//   LS_VARIANT_ID          Variant id of the CookieMop Pro product
//   ALLOW_TEST_MODE        Set to "1" only while testing the flow end to end

import { signLicense } from '../lib/sign-license.js';
import { verifyOrder, OrderProblem } from '../lib/lemonsqueezy.js';
import { checkRateLimit, pruneRateLimit } from '../lib/rate-limit.js';

const REQUIRED_ENV = ['LICENSE_PRIVATE_KEY', 'LEMONSQUEEZY_API_KEY', 'LS_STORE_ID', 'LS_VARIANT_ID'];

// One message for every "we could not match this purchase" case. Telling a
// stranger *why* a lookup failed would leak which orders exist.
const NOT_FOUND_MESSAGE =
  "We couldn't find that purchase. Check the order number in your receipt email and the address you paid with. / 해당 주문을 찾을 수 없습니다. 영수증 메일의 주문번호와 결제에 사용한 이메일을 확인해주세요.";

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error('missing environment variables:', missing.join(', '));
    return res.status(500).json({ error: 'server misconfigured' });
  }

  pruneRateLimit();
  const limit = checkRateLimit(clientIp(req));
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({
      error: 'rate limited',
      message: 'Too many lookups. Please wait a minute and try again. / 조회가 너무 잦습니다. 1분 후 다시 시도해주세요.'
    });
  }

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'invalid json' });

  const email = String(body.email || '').trim();
  const orderNumber = String(body.orderNumber || '').trim();
  if (!email || !orderNumber) {
    return res.status(400).json({
      error: 'missing fields',
      message: 'Enter both your email and your order number. / 이메일과 주문번호를 모두 입력해주세요.'
    });
  }

  let order;
  try {
    order = await verifyOrder({
      email,
      orderNumber,
      apiKey: process.env.LEMONSQUEEZY_API_KEY,
      storeId: process.env.LS_STORE_ID,
      variantId: process.env.LS_VARIANT_ID,
      allowTestMode: process.env.ALLOW_TEST_MODE === '1'
    });
  } catch (error) {
    console.error('order lookup failed:', error.message);
    return res.status(502).json({
      error: 'upstream',
      message: 'Could not reach the payment provider. Please try again shortly. / 결제 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.'
    });
  }

  if (!order.ok) {
    // Log the specific reason for the operator; return the generic one.
    console.warn('lookup refused:', order.problem);
    const status = order.problem === OrderProblem.NOT_PAID ? 402 : 404;
    return res.status(status).json({ error: order.problem, message: NOT_FOUND_MESSAGE });
  }

  let licenseKey;
  try {
    licenseKey = signLicense({
      email: order.email,
      orderNumber: order.orderNumber,
      privateKeyPem: process.env.LICENSE_PRIVATE_KEY
    });
  } catch (error) {
    console.error('signing failed:', error.message);
    return res.status(500).json({ error: 'signing failed' });
  }

  // Never log the key itself.
  console.log('license issued for order', order.orderNumber);
  return res.status(200).json({ licenseKey, email: order.email });
}
