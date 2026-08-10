# CookieMop license lookup

This directory is **not** part of the Chrome extension. It is never included
in the store package — `tools/package.mjs` builds from an explicit file list
(`manifest.json`, `icons`, `src`, `_locales`, `LICENSE`) and refuses to run
if a network primitive ever appears under `src/`.

It exists so a buyer can get a signed license key, while the extension keeps
making zero network requests.

```
Lemon Squeezy checkout
        │  LS emails its own receipt (contains the order number)
        │  LS redirects to /license?email=…&order_id=…  (link variables)
        ▼
   /license page  ──  prefills and looks up automatically;
        │             falls back to a manual form if that fails
        ▼
POST /api/license  ──  verifies the order against the Lemon Squeezy API
        │              signs {e, o, v} with the private key
        │              returns the key (nothing is stored)
        ▼
   buyer copies it
        ▼
CookieMop options page  ──  verifies the signature locally, offline
```

## Two ways in, one key

The redirect hands back Lemon Squeezy's internal **order id**, while the
receipt shows the **order number**. `POST /api/license` accepts either
(`{email, orderId}` or `{email, orderNumber}`) and the email must match on
both routes.

Whichever route is used, the key is signed over the `order_number` that
Lemon Squeezy holds — never over the caller's input. So a buyer who arrives
via the redirect and the same buyer typing their receipt number later get
byte-identical keys. Losing that normalization would silently hand one
customer two different keys.

If the link variables fail to substitute, the page ignores the raw
`===[order_id]===` text and behaves like a plain form. A broken redirect
must never block a sale.

## Why there is no database and no webhook

Signing is deterministic: the same email and order number always produce
byte-identical output. So the key does not need to be stored anywhere — it
can be recomputed on demand. A buyer who loses their key returns to
`/license` and gets the same key back, forever, at no support cost.

That determinism comes from RFC 6979, via `@noble/curves`. Node's built-in
`crypto.sign()` uses a random nonce and would produce a different (still
valid) signature on every lookup. This is the only dependency in the
project, it is server-side only, and the extension continues to verify with
native WebCrypto and ship nothing.

## Deploy (Vercel)

1. Create a Vercel project from this repository with **Root Directory** set
   to `server`. Keep it separate from other projects.
2. Set these environment variables (Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `LICENSE_PRIVATE_KEY` | Contents of `license-private-key.pem`, including the BEGIN/END lines |
   | `LEMONSQUEEZY_API_KEY` | Lemon Squeezy → Settings → API |
   | `LS_STORE_ID` | Your Lemon Squeezy store id |
   | `LS_VARIANT_ID` | Variant id of the CookieMop Pro product |
   | `ALLOW_TEST_MODE` | **A date, not a switch**: `YYYY-MM-DD`. Test-mode orders are accepted until the start of that day (UTC), then refused automatically. Leave it unset in production. |

3. In the Lemon Squeezy product settings, set the post-purchase redirect to
   `https://<your-deployment>/license`.
4. Put that same URL, and the checkout URL, into `src/lib/config.js`.
   `node tools/package.mjs` refuses to build the store package while either
   is still a placeholder.

No webhook is needed. Nothing subscribes to Lemon Squeezy events.

## Generating the signing keypair

Run once, from the repository root:

```
node tools/generate-keypair.mjs
```

It writes the private key **outside** this repository (default:
`../cookiemop-secrets/license-private-key.pem`, mode 600) and prints only the
public key. Paste that public key into `PUBLIC_KEY_B64` in
`src/lib/license.js`, and the private key PEM into `LICENSE_PRIVATE_KEY`.

Back the private key up in a password manager. Losing it means existing
customers keep working — their keys are already signed and verify offline —
but no new keys can be issued. Changing the public key would invalidate
every key already sold.

## Abuse controls

A lookup requires both the email and the order number, so the endpoint
cannot be used to enumerate customers from an email alone. On top of that,
`lib/rate-limit.js` caps each IP at 10 lookups per minute. That cap is per
warm serverless instance rather than global; making it global would require
a datastore, which this design deliberately avoids.

Every refusal returns the same message, so the endpoint does not reveal
which orders or products exist.

## Test mode expires by itself

Test-mode orders would otherwise be a way to mint free keys, and the one
moment you need them — the end-to-end check after deploying — is exactly
when you are least likely to remember to switch them off again. So the
permission is a deadline rather than a flag:

```
ALLOW_TEST_MODE=2026-08-25   test orders work until 2026-08-25 (UTC), then stop
(unset)                      test orders are refused
```

Anything that is not a real `YYYY-MM-DD` date — including the old `1` — is
refused, and logs a warning. An expired value is refused and logs a note
that it can now be deleted. Forgetting to remove the variable is harmless.

While test mode is live, the `/license` page shows a red banner reading
`TEST MODE ACTIVE — expires <date>`, so the state is visible on the site
itself rather than only in the dashboard. `GET /api/license` returns that
status (and nothing else) for the banner to read.

## Testing

`tests/license-lookup.spec.js` drives the handler with a stubbed Lemon
Squeezy API — no network, no real orders — and covers order verification,
determinism, the generic-refusal behaviour and rate limiting.
`tests/license.spec.js` then takes a key minted by `lib/sign-license.js` and
verifies it inside a real extension page, so a signing change that would
break activation fails the suite instead of a customer's purchase.
