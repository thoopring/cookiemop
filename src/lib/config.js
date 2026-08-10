// Build-time constants.
//
// Both URLs are opened in a new tab when the user clicks them. The extension
// never requests either one, so these stay links, not network calls.
//
// PLACEHOLDER — replace both before submitting v1.5:
//   CHECKOUT_URL     the Lemon Squeezy hosted checkout for CookieMop Pro
//   LICENSE_LOOKUP_URL  the deployed /license page (buyers look their key up
//                       there; it is also the post-purchase redirect target)
//
// tools/package.mjs refuses to build a store package while either value
// still matches PLACEHOLDER_PATTERN, so a placeholder cannot reach the store.
export const CHECKOUT_URL =
  'https://cookiemop.lemonsqueezy.com/checkout/buy/24524b91-03b3-4aab-89c2-4dda2ef0d11e';
export const LICENSE_LOOKUP_URL = 'https://cookiemop.vercel.app/license';

/** Any URL matching this is not a real, deployed endpoint. */
export const PLACEHOLDER_PATTERN = /REPLACE-ME|example\.lemonsqueezy|github\.com\/thoopring\/cookiemop#/;

export const PRO_PRICE_USD = '$9.99';
