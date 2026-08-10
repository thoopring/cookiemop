// License minting. Runs ONLY on the server — never in the extension.
//
// Produces the key format that src/lib/license.js verifies:
//   CM1.<base64url(payload JSON)>.<base64url(signature)>
// Signature: ECDSA P-256 / SHA-256, raw IEEE P-1363 (64 bytes), which is the
// encoding WebCrypto expects. Node's default DER encoding would NOT verify.

import { createSign, createPrivateKey } from 'node:crypto';

const KEY_PREFIX = 'CM1';

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mint a signed license key.
 *
 * @param {object}  args
 * @param {string}  args.email      buyer email (shown back to them in the UI)
 * @param {string}  args.orderId    Lemon Squeezy order id
 * @param {string}  args.privateKeyPem  PKCS#8 PEM, from env — never hardcoded
 * @param {number} [args.issuedAt]  epoch seconds; defaults to now
 * @returns {string} license key
 */
export function signLicense({ email, orderId, privateKeyPem, issuedAt }) {
  if (!email || !orderId) throw new Error('email and orderId are required');
  if (!privateKeyPem) throw new Error('missing private key');

  // Short field names keep the key copy-pasteable. Key order is fixed, and
  // the extension verifies the raw bytes, so no canonicalization worries.
  const payload = JSON.stringify({
    v: 1,
    e: String(email).trim().toLowerCase(),
    o: String(orderId),
    i: issuedAt ?? Math.floor(Date.now() / 1000)
  });
  const payloadBytes = Buffer.from(payload, 'utf8');

  const signer = createSign('SHA256');
  signer.update(payloadBytes);
  const signature = signer.sign({
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363'
  });

  if (signature.length !== 64) {
    throw new Error(`unexpected signature length ${signature.length}, expected 64`);
  }

  return `${KEY_PREFIX}.${toBase64Url(payloadBytes)}.${toBase64Url(signature)}`;
}
