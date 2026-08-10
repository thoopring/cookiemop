// Build-time constants.
//
// CHECKOUT_URL is the Lemon Squeezy hosted checkout for CookieMop Pro. It is
// opened in a new tab when the user clicks "Get Pro"; the extension itself
// never requests it, so this remains a link, not a network call.
//
// TODO(founder): replace with the real Lemon Squeezy checkout URL before
// submitting v1.5. Until then the button points at the repo's Pro section.
export const CHECKOUT_URL = 'https://github.com/thoopring/cookiemop#cookiemop-pro';

export const PRO_PRICE_USD = '$9.99';
