// Lemon Squeezy order verification. Server-side only.

const API_ROOT = 'https://api.lemonsqueezy.com/v1';

/** Why a lookup was refused. The page maps these to user-facing text. */
export const OrderProblem = {
  NOT_FOUND: 'not-found',
  NOT_PAID: 'not-paid',
  WRONG_STORE: 'wrong-store',
  WRONG_PRODUCT: 'wrong-product',
  TEST_MODE: 'test-mode'
};

/**
 * Look up an order by email + order number and check it really is a paid
 * CookieMop Pro purchase.
 *
 * Both fields are required, so an attacker cannot enumerate customers with
 * an email alone.
 *
 * @returns {{ok: true, email: string, orderNumber: string} | {ok: false, problem: string}}
 */
export async function verifyOrder({
  email,
  orderNumber,
  apiKey,
  storeId,
  variantId,
  allowTestMode = false,
  fetchImpl = fetch
}) {
  const params = new URLSearchParams({
    'filter[user_email]': String(email).trim().toLowerCase(),
    'filter[order_number]': String(orderNumber).trim()
  });

  const response = await fetchImpl(`${API_ROOT}/orders?${params}`, {
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey}`
    }
  });
  if (!response.ok) {
    throw new Error(`Lemon Squeezy API returned ${response.status}`);
  }

  const body = await response.json();
  const orders = Array.isArray(body?.data) ? body.data : [];
  if (!orders.length) return { ok: false, problem: OrderProblem.NOT_FOUND };

  const order = orders[0];
  const attributes = order.attributes || {};

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

  // Sign the values Lemon Squeezy holds, not the raw user input, so casing
  // or spacing differences cannot produce two different keys.
  return {
    ok: true,
    email: String(attributes.user_email).trim().toLowerCase(),
    orderNumber: String(attributes.order_number)
  };
}
