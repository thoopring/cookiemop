// Server-side license lookup tests.
//
// These exercise the /api/license handler with a stubbed Lemon Squeezy API,
// so no network and no real orders are involved. The signing key is the real
// one when present (it never leaves the machine and no key is committed).

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import handler from '../server/api/license.js';
import { verifyOrder, OrderProblem } from '../server/lib/lemonsqueezy.js';
import { signLicense } from '../server/lib/sign-license.js';
import { resetRateLimit, RATE_LIMIT } from '../server/lib/rate-limit.js';
import { evaluateTestMode, testModeWarning, TestModeProblem } from '../server/lib/test-mode.js';

const PRIVATE_KEY_PATH =
  process.env.COOKIEMOP_PRIVATE_KEY_PATH ||
  'E:/prj/cookiemop-secrets/license-private-key.pem';
const hasSigningKey = existsSync(PRIVATE_KEY_PATH);
const privateKeyPem = hasSigningKey ? readFileSync(PRIVATE_KEY_PATH, 'utf8') : null;

const STORE_ID = '55555';
const VARIANT_ID = '99999';
const BUYER_EMAIL = 'buyer@example.com';
const ORDER_NUMBER = '1042';

/** A Lemon Squeezy order payload, overridable per test. */
function orderFixture(overrides = {}) {
  return {
    data: [
      {
        id: 'order-1',
        attributes: {
          store_id: Number(STORE_ID),
          user_email: BUYER_EMAIL,
          order_number: Number(ORDER_NUMBER),
          status: 'paid',
          test_mode: false,
          first_order_item: { variant_id: Number(VARIANT_ID) },
          ...overrides
        }
      }
    ]
  };
}

/** Stub the LS API. `respond` receives the request URL. */
function stubFetch(respond) {
  return async (url) => {
    const body = respond(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => body
    };
  };
}

/** Minimal req/res doubles for the Vercel-style handler. */
function makeReq({ body, ip = '203.0.113.7', method = 'POST' } = {}) {
  return { method, body, headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } };
}
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

let originalFetch;
test.beforeEach(() => {
  resetRateLimit();
  originalFetch = globalThis.fetch;
  process.env.LICENSE_PRIVATE_KEY = privateKeyPem || 'unset';
  process.env.LEMONSQUEEZY_API_KEY = 'test-api-key';
  process.env.LS_STORE_ID = STORE_ID;
  process.env.LS_VARIANT_ID = VARIANT_ID;
  delete process.env.ALLOW_TEST_MODE;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- verifyOrder ---------------------------------------------------------

test('a paid order for the right product and store is accepted', async () => {
  const result = await verifyOrder({
    email: BUYER_EMAIL,
    orderNumber: ORDER_NUMBER,
    apiKey: 'k',
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    fetchImpl: stubFetch(() => orderFixture())
  });
  expect(result.ok).toBe(true);
  expect(result.email).toBe(BUYER_EMAIL);
  expect(result.orderNumber).toBe(ORDER_NUMBER);
});

test('an unknown order number is refused', async () => {
  const result = await verifyOrder({
    email: BUYER_EMAIL,
    orderNumber: '404404',
    apiKey: 'k',
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    fetchImpl: stubFetch(() => ({ data: [] }))
  });
  expect(result).toEqual({ ok: false, problem: OrderProblem.NOT_FOUND });
});

test('an email that does not match the order is refused', async () => {
  // Lemon Squeezy filters on both fields, so a mismatch returns nothing.
  let requestedUrl = '';
  const result = await verifyOrder({
    email: 'someone-else@example.com',
    orderNumber: ORDER_NUMBER,
    apiKey: 'k',
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    fetchImpl: stubFetch((url) => {
      requestedUrl = url;
      const email = new URL(url).searchParams.get('filter[user_email]');
      return email === BUYER_EMAIL ? orderFixture() : { data: [] };
    })
  });
  expect(result).toEqual({ ok: false, problem: OrderProblem.NOT_FOUND });
  // Both filters must be sent, or the endpoint would leak orders by email.
  expect(requestedUrl).toContain('filter%5Buser_email%5D=someone-else%40example.com');
  expect(requestedUrl).toContain('filter%5Border_number%5D=1042');
});

test('an unpaid order is refused', async () => {
  const result = await verifyOrder({
    email: BUYER_EMAIL,
    orderNumber: ORDER_NUMBER,
    apiKey: 'k',
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    fetchImpl: stubFetch(() => orderFixture({ status: 'pending' }))
  });
  expect(result).toEqual({ ok: false, problem: OrderProblem.NOT_PAID });
});

test('an order from another store or product is refused', async () => {
  const wrongStore = await verifyOrder({
    email: BUYER_EMAIL, orderNumber: ORDER_NUMBER, apiKey: 'k',
    storeId: STORE_ID, variantId: VARIANT_ID,
    fetchImpl: stubFetch(() => orderFixture({ store_id: 12345 }))
  });
  expect(wrongStore).toEqual({ ok: false, problem: OrderProblem.WRONG_STORE });

  const wrongProduct = await verifyOrder({
    email: BUYER_EMAIL, orderNumber: ORDER_NUMBER, apiKey: 'k',
    storeId: STORE_ID, variantId: VARIANT_ID,
    fetchImpl: stubFetch(() => orderFixture({ first_order_item: { variant_id: 1 } }))
  });
  expect(wrongProduct).toEqual({ ok: false, problem: OrderProblem.WRONG_PRODUCT });
});

test('a test-mode order is refused unless test mode is explicitly allowed', async () => {
  const args = {
    email: BUYER_EMAIL, orderNumber: ORDER_NUMBER, apiKey: 'k',
    storeId: STORE_ID, variantId: VARIANT_ID,
    fetchImpl: stubFetch(() => orderFixture({ test_mode: true }))
  };
  expect(await verifyOrder(args)).toEqual({ ok: false, problem: OrderProblem.TEST_MODE });
  expect((await verifyOrder({ ...args, allowTestMode: true })).ok).toBe(true);
});

// --- determinism ---------------------------------------------------------

test('the same purchase always produces byte-identical keys', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  const a = signLicense({ email: BUYER_EMAIL, orderNumber: ORDER_NUMBER, privateKeyPem });
  const b = signLicense({ email: BUYER_EMAIL, orderNumber: ORDER_NUMBER, privateKeyPem });
  expect(a).toBe(b);

  // Casing and padding in the buyer's input must not fork the key.
  const messy = signLicense({
    email: '  BUYER@Example.COM ',
    orderNumber: ' 1042 ',
    privateKeyPem
  });
  expect(messy).toBe(a);

  // A different purchase must produce a different key.
  expect(signLicense({ email: BUYER_EMAIL, orderNumber: '1043', privateKeyPem })).not.toBe(a);
});

test('two lookups of the same order return the same key through the handler', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  globalThis.fetch = stubFetch(() => orderFixture());

  const call = async () => {
    const res = makeRes();
    await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), res);
    return res;
  };
  const first = await call();
  const second = await call();

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(first.body.licenseKey).toBe(second.body.licenseKey);
  expect(first.body.licenseKey.startsWith('CM1.')).toBe(true);
});

// --- handler behaviour ---------------------------------------------------

test('handler rejects methods other than GET and POST', async () => {
  // GET is the test-mode status probe; POST is the lookup. Nothing else.
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const res = makeRes();
    await handler(makeReq({ method }), res);
    expect(res.statusCode, `${method} must be rejected`).toBe(405);
    expect(res.headers.Allow).toBe('GET, POST');
  }
});

test('handler requires both fields', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL } }), res);
  expect(res.statusCode).toBe(400);
  expect(res.body.message).toContain('order number');
});

test('handler returns one generic message for every no-match case', async () => {
  const messages = new Set();
  for (const fixture of [
    () => ({ data: [] }),
    () => orderFixture({ store_id: 1 }),
    () => orderFixture({ first_order_item: { variant_id: 1 } }),
    () => orderFixture({ test_mode: true })
  ]) {
    resetRateLimit();
    globalThis.fetch = stubFetch(fixture);
    const res = makeRes();
    await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), res);
    expect(res.statusCode).toBe(404);
    messages.add(res.body.message);
  }
  // A single wording, so the endpoint cannot be used to probe which orders
  // or products exist.
  expect(messages.size).toBe(1);
});

test('handler surfaces an upstream failure as 502 rather than a fake refusal', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const res = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), res);
  expect(res.statusCode).toBe(502);
});

test('handler fails closed when environment variables are missing', async () => {
  delete process.env.LEMONSQUEEZY_API_KEY;
  const res = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), res);
  expect(res.statusCode).toBe(500);
  expect(res.body.licenseKey).toBeUndefined();
});

// --- rate limiting -------------------------------------------------------

test('an IP is limited to 10 lookups per minute', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  globalThis.fetch = stubFetch(() => orderFixture());

  const statuses = [];
  for (let i = 0; i < RATE_LIMIT.MAX_REQUESTS + 3; i++) {
    const res = makeRes();
    await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER }, ip: '198.51.100.9' }), res);
    statuses.push(res.statusCode);
  }
  expect(statuses.slice(0, RATE_LIMIT.MAX_REQUESTS)).toEqual(
    Array(RATE_LIMIT.MAX_REQUESTS).fill(200)
  );
  expect(statuses.slice(RATE_LIMIT.MAX_REQUESTS)).toEqual([429, 429, 429]);
});

test('the limit is per IP, so one abuser does not block everyone', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  globalThis.fetch = stubFetch(() => orderFixture());

  for (let i = 0; i < RATE_LIMIT.MAX_REQUESTS + 1; i++) {
    const res = makeRes();
    await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER }, ip: '198.51.100.1' }), res);
  }
  const other = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER }, ip: '198.51.100.2' }), other);
  expect(other.statusCode).toBe(200);
});

test('a rate-limited response tells the caller when to retry', async () => {
  globalThis.fetch = stubFetch(() => orderFixture());
  let res;
  for (let i = 0; i < RATE_LIMIT.MAX_REQUESTS + 1; i++) {
    res = makeRes();
    await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER }, ip: '192.0.2.44' }), res);
  }
  expect(res.statusCode).toBe(429);
  expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
});

// --- ALLOW_TEST_MODE expiry ----------------------------------------------
// The variable is a deadline, not a switch, so leaving it behind cannot keep
// minting free keys forever.

test('test mode is refused when the variable is unset', () => {
  expect(evaluateTestMode(undefined)).toEqual({
    allowed: false, expiresAt: null, problem: TestModeProblem.UNSET
  });
  expect(evaluateTestMode('').allowed).toBe(false);
  expect(evaluateTestMode('   ').allowed).toBe(false);
});

test('test mode is allowed while the expiry date is still ahead', () => {
  const state = evaluateTestMode('2026-08-25', new Date('2026-08-22T09:00:00Z'));
  expect(state).toEqual({ allowed: true, expiresAt: '2026-08-25', problem: null });
});

test('test mode closes itself once the expiry date arrives', () => {
  // Expiry is the start of that day, UTC — on the date itself it is shut.
  const onTheDay = evaluateTestMode('2026-08-25', new Date('2026-08-25T00:00:00Z'));
  expect(onTheDay).toEqual({
    allowed: false, expiresAt: '2026-08-25', problem: TestModeProblem.EXPIRED
  });

  const later = evaluateTestMode('2026-08-25', new Date('2026-09-30T12:00:00Z'));
  expect(later.allowed).toBe(false);
  expect(later.problem).toBe(TestModeProblem.EXPIRED);
});

test('a malformed value is refused rather than treated as permission', () => {
  for (const value of ['1', 'true', 'yes', '2026/08/25', '25-08-2026', '2026-8-5', 'tomorrow', '2026-13-01', '2026-02-30']) {
    const state = evaluateTestMode(value, new Date('2026-08-22T09:00:00Z'));
    expect(state.allowed, `"${value}" must not enable test mode`).toBe(false);
    expect(state.problem).toBe(TestModeProblem.MALFORMED);
  }
});

test('the old boolean value no longer enables test mode', async () => {
  // Anyone upgrading from the previous format must not silently stay open.
  process.env.ALLOW_TEST_MODE = '1';
  globalThis.fetch = stubFetch(() => orderFixture({ test_mode: true }));
  const res = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), res);
  expect(res.statusCode).toBe(404);
  expect(res.body.licenseKey).toBeUndefined();
});

test('a malformed or expired value produces an operator warning', () => {
  const malformed = evaluateTestMode('1');
  expect(testModeWarning(malformed, '1')).toContain('not a YYYY-MM-DD date');

  const expired = evaluateTestMode('2026-08-25', new Date('2026-09-01T00:00:00Z'));
  expect(testModeWarning(expired, '2026-08-25')).toContain('expired on 2026-08-25');

  // Unset is the normal production state and should stay quiet.
  expect(testModeWarning(evaluateTestMode(undefined), undefined)).toBeNull();
});

test('a test-mode order mints a key only while the deadline holds', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  globalThis.fetch = stubFetch(() => orderFixture({ test_mode: true }));

  // Far-future deadline: allowed.
  process.env.ALLOW_TEST_MODE = '2099-01-01';
  const open = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), open);
  expect(open.statusCode).toBe(200);
  expect(open.body.licenseKey.startsWith('CM1.')).toBe(true);

  // Past deadline: refused, with the same generic message as any other miss.
  resetRateLimit();
  process.env.ALLOW_TEST_MODE = '2020-01-01';
  const shut = makeRes();
  await handler(makeReq({ body: { email: BUYER_EMAIL, orderNumber: ORDER_NUMBER } }), shut);
  expect(shut.statusCode).toBe(404);
  expect(shut.body.licenseKey).toBeUndefined();
});

test('GET reports test-mode status for the banner, and hides an expired one', async () => {
  process.env.ALLOW_TEST_MODE = '2099-01-01';
  const active = makeRes();
  await handler(makeReq({ method: 'GET' }), active);
  expect(active.statusCode).toBe(200);
  expect(active.body.testMode).toEqual({ active: true, expiresAt: '2099-01-01' });

  process.env.ALLOW_TEST_MODE = '2020-01-01';
  const expired = makeRes();
  await handler(makeReq({ method: 'GET' }), expired);
  expect(expired.body.testMode).toEqual({ active: false, expiresAt: null });

  delete process.env.ALLOW_TEST_MODE;
  const unset = makeRes();
  await handler(makeReq({ method: 'GET' }), unset);
  expect(unset.body.testMode).toEqual({ active: false, expiresAt: null });
});

test('GET never leaks anything beyond the test-mode flag', async () => {
  process.env.ALLOW_TEST_MODE = '2099-01-01';
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  expect(Object.keys(res.body)).toEqual(['testMode']);
  expect(JSON.stringify(res.body)).not.toContain('BEGIN');
});
