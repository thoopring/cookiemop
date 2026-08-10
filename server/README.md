# CookieMop license issuer

This directory is **not** part of the Chrome extension. It is never included
in the store package (`dist/cookiemop-*.zip` is built from an explicit file
list: `manifest.json`, `icons`, `src`, `_locales`, `LICENSE`).

It exists so that buying Pro produces a signed license key by email, while
the extension itself keeps making zero network requests.

```
Lemon Squeezy checkout
        │  order_created webhook
        ▼
api/license-webhook.js  ── verifies the webhook HMAC
        │                  signs {email, orderId} with the private key
        │                  emails the key to the buyer (Resend)
        ▼
   buyer's inbox
        │  copy & paste
        ▼
CookieMop options page ── verifies the signature locally, offline
```

## Deploy (Vercel)

1. Create a new Vercel project from this repository, with **Root Directory**
   set to `server`. Keep it separate from other projects.
2. Set these environment variables (Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `LICENSE_PRIVATE_KEY` | Contents of `license-private-key.pem` (the whole PEM, including the BEGIN/END lines) |
   | `LS_WEBHOOK_SECRET` | The signing secret from the Lemon Squeezy webhook screen |
   | `RESEND_API_KEY` | A Resend API key |
   | `LICENSE_FROM_EMAIL` | e.g. `CookieMop <keys@yourdomain.com>` (must be a verified Resend sender) |

3. In Lemon Squeezy, add a webhook pointing at
   `https://<your-deployment>/api/license-webhook`, subscribed to
   **`order_created`** only.

## Generating the signing keypair

Run once, from the repository root:

```
node tools/generate-keypair.mjs
```

It writes the private key **outside** this repository (default:
`../cookiemop-secrets/license-private-key.pem`, mode 600) and prints only the
public key. Paste that public key into `PUBLIC_KEY_B64` in
`src/lib/license.js`, and the private key PEM into `LICENSE_PRIVATE_KEY`.

Back the private key up offline. Losing it means existing customers keep
working (their keys are already signed) but no new keys can be issued, and
rotating the public key would invalidate every key already sold.

## Testing the round trip

`tests/license.spec.js` mints keys with `server/lib/sign-license.js` and
verifies them inside a real extension page, so a signing change that would
break verification fails the test suite rather than a customer's activation.
