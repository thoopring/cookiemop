// License minting. Runs ONLY on the server — never in the extension.
//
// Produces the key format that src/lib/license.js verifies:
//   CM1.<base64url(payload JSON)>.<base64url(signature)>
// Signature: ECDSA P-256 / SHA-256, raw IEEE P-1363 (64 bytes), the encoding
// WebCrypto expects. Node's default DER encoding would NOT verify.
//
// Signing is DETERMINISTIC (RFC 6979): the same email + order number always
// produces byte-identical output. That is what makes the lookup page work
// with no database — a buyer who loses their key just looks it up again and
// gets the same string back.
//
// Node's own crypto.sign() uses a random nonce, so identical input would
// yield different (still valid) signatures. @noble/curves is used here for
// its RFC 6979 nonce derivation. It is a server-only dependency; the
// extension keeps verifying with native WebCrypto and ships no dependencies.

import { p256 } from '@noble/curves/nist.js';
import { createPrivateKey } from 'node:crypto';

const KEY_PREFIX = 'CM1';

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Extract the raw 32-byte private scalar from a PKCS#8 PEM. */
function privateScalarFromPem(pem) {
  const jwk = createPrivateKey(pem).export({ format: 'jwk' });
  if (!jwk.d) throw new Error('private key PEM did not yield a scalar');
  return Buffer.from(jwk.d, 'base64url');
}

/** Normalize an email the same way on every call, so signing is stable. */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Mint a signed license key. Deterministic for a given (email, orderNumber).
 *
 * @param {object} args
 * @param {string} args.email        buyer email, as recorded by Lemon Squeezy
 * @param {string} args.orderNumber  Lemon Squeezy order number
 * @param {string} args.privateKeyPem  PKCS#8 PEM, from env — never hardcoded
 * @returns {string} license key
 */
export function signLicense({ email, orderNumber, privateKeyPem }) {
  const e = normalizeEmail(email);
  const o = String(orderNumber || '').trim();
  if (!e || !o) throw new Error('email and orderNumber are required');
  if (!privateKeyPem) throw new Error('missing private key');

  // Field order is fixed by this literal, so the bytes are reproducible.
  // No timestamp: a timestamp would make every lookup return a different key.
  const payloadBytes = Buffer.from(JSON.stringify({ e, o, v: 1 }), 'utf8');

  // prehash: true makes noble hash the message with the curve's hash
  // (SHA-256) before signing, matching createVerify('SHA256').
  const signature = p256.sign(payloadBytes, privateScalarFromPem(privateKeyPem), {
    prehash: true
  });
  const signatureBytes = Buffer.from(
    typeof signature.toBytes === 'function' ? signature.toBytes('compact') : signature
  );

  if (signatureBytes.length !== 64) {
    throw new Error(`unexpected signature length ${signatureBytes.length}, expected 64`);
  }

  return `${KEY_PREFIX}.${toBase64Url(payloadBytes)}.${toBase64Url(signatureBytes)}`;
}
