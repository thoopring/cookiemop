// Lemon Squeezy order verification. Server-side only.

const API_ROOT = 'https://api.lemonsqueezy.com/v1';

/**
 * Why a lookup was refused. These are for the operator log only — every one
 * of them produces the same message for the caller, so the endpoint cannot
 * be used to work out which orders exist.
 */
export const OrderProblem = {
  NOT_FOUND: 'not-found',
  EMAIL_MISMATCH: 'email-mismatch',
  NOT_PAID: 'not-paid',
  WRONG_STORE: 'wrong-store',
  WRONG_PRODUCT: 'wrong-product',
  TEST_MODE: 'test-mode'
};

function authHeaders(apiKey) {
  return {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    Authorization: `Bearer ${apiKey}`
  };
}

/** Look up by Lemon Squeezy's internal order id. Returns attributes or null. */
async function fetchOrderById({ orderId, apiKey, fetchImpl }) {
  const response = await fetchImpl(`${API_ROOT}/orders/${encodeURIComponent(orderId)}`, {
    headers: authHeaders(apiKey)
  });
  // A bad id is a miss, not an outage.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Lemon Squeezy API returned ${response.status}`);

  const body = await response.json();
  return body?.data?.attributes || null;
}

/** Look up by the human-facing order number. Returns attributes or null. */
async function fetchOrderByNumber({ email, orderNumber, apiKey, fetchImpl }) {
  const params = new URLSearchParams({
    'filter[user_email]': email,
    'filter[order_number]': String(orderNumber).trim()
  });
  const response = await fetchImpl(`${API_ROOT}/orders?${params}`, {
    headers: authHeaders(apiKey)
  });
  if (!response.ok) throw new Error(`Lemon Squeezy API returned ${response.status}`);

  const body = await response.json();
  const orders = Array.isArray(body?.data) ? body.data : [];
  return orders.length ? orders[0].attributes || null : null;
}

/**
 * Look up an order and check it really is a paid CookieMop Pro purchase.
 *
 * Accepts either identifier:
 *   orderNumber — the human-facing number printed on the receipt
 *   orderId     — Lemon Squeezy's internal id, which is what its checkout
 *                 link variables hand back on the post-purchase redirect
 *
 * The email must match either way, so neither identifier alone is enough to
 * fetch somebody else's key.
 *
 * Whatever the caller passed in, the result carries the order_number Lemon
 * Squeezy holds. Signing that single canonical value is what makes both
 * routes produce the same license key.
 *
 * @returns {{ok: true, email: string, orderNumber: string} | {ok: false, problem: string}}
 */
export async function verifyOrder({
  email,
  orderNumber,
  orderId,
  apiKey,
  storeId,
  variantId,
  allowTestMode = false,
  fetchImpl = fetch
}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const id = String(orderId || '').trim();
  const number = String(orderNumber || '').trim();
  if (!normalizedEmail || (!id && !number)) {
    return { ok: false, problem: OrderProblem.NOT_FOUND };
  }

  // Prefer the id when both arrive: it addresses one order exactly.
  const attributes = id
    ? await fetchOrderById({ orderId: id, apiKey, fetchImpl })
    : await fetchOrderByNumber({ email: normalizedEmail, orderNumber: number, apiKey, fetchImpl });

  if (!attributes) return { ok: false, problem: OrderProblem.NOT_FOUND };

  // The id route is not filtered by email, so check it here. Doing it on
  // both routes keeps one rule instead of two.
  if (String(attributes.user_email || '').trim().toLowerCase() !== normalizedEmail) {
    return { ok: false, problem: OrderProblem.EMAIL_MISMATCH };
  }

  if (attributes.status !== 'paid') return { ok: false, problem: OrderProblem.NOT_PAID };
  if (String(attributes.store_id) !== String(storeId)) {
    return { ok: false, problem: OrderProblem.WRONG_STORE };
  }
  const variant = attributes.first_order_item?.variant_id;
  if (String(variant) !== String(variantId)) {
    return { ok: false, problem: OrderProblem.WRONG_PRODUCT };
  }
  // Test orders must not mint real keys, except while the founder is
  // verifying the flow end to end (ALLOW_TEST_MODE=1).
  if (attributes.test_mode && !allowTestMode) {
    return { ok: false, problem: OrderProblem.TEST_MODE };
  }

  // Sign the values Lemon Squeezy holds, not the raw user input. This is
  // what normalizes the two lookup routes onto one key: an id lookup and a
  // number lookup for the same order both end up signing this order_number.
  return {
    ok: true,
    email: String(attributes.user_email).trim().toLowerCase(),
    orderNumber: String(attributes.order_number)
  };
}
