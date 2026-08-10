// License verification tests.
//
// Fixtures are minted at run time — a valid CookieMop Pro key is never
// committed to this repository, because a committed key would be a working
// key for anyone who reads the repo. The real signing key lives outside the
// repo; tests that need it skip cleanly when it is absent.

import { test, expect } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { launchWithExtension } from './helpers.js';
import { signLicense } from '../server/lib/sign-license.js';

const PRIVATE_KEY_PATH =
  process.env.COOKIEMOP_PRIVATE_KEY_PATH ||
  'E:/prj/cookiemop-secrets/license-private-key.pem';

const hasSigningKey = existsSync(PRIVATE_KEY_PATH);
const realPrivateKeyPem = hasSigningKey ? readFileSync(PRIVATE_KEY_PATH, 'utf8') : null;

// An attacker's keypair: structurally identical, wrong signer.
const forgedKeyPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

const BUYER = { email: 'buyer@example.com', orderNumber: '1001' };

let context, extensionId, page;

test.beforeEach(async () => {
  ({ context, extensionId } = await launchWithExtension());
  page = await context.newPage();
  // Any extension page is a secure context, which WebCrypto requires.
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
});

test.afterEach(async () => {
  await context.close();
});

/** Run verifyLicenseKey inside the extension, where the real public key lives. */
function verifyInExtension(key) {
  return page.evaluate(async (licenseKey) => {
    const mod = await import('/src/lib/license.js');
    return mod.verifyLicenseKey(licenseKey);
  }, key);
}

test('accepts a genuine key and exposes the buyer details', async () => {
  test.skip(!hasSigningKey, `signing key not found at ${PRIVATE_KEY_PATH}`);
  const key = signLicense({ ...BUYER, privateKeyPem: realPrivateKeyPem });

  const result = await verifyInExtension(key);
  expect(result.status).toBe('valid');
  expect(result.payload.email).toBe(BUYER.email);
  expect(result.payload.orderNumber).toBe(BUYER.orderNumber);
});

test('rejects a key forged with a different private key', async () => {
  const forged = signLicense({ ...BUYER, privateKeyPem: forgedKeyPem });
  const result = await verifyInExtension(forged);
  expect(result.status).toBe('bad-signature');
  expect(result.payload).toBeUndefined();
});

test('rejects a genuine key whose payload was edited', async () => {
  test.skip(!hasSigningKey, `signing key not found at ${PRIVATE_KEY_PATH}`);
  const key = signLicense({ ...BUYER, privateKeyPem: realPrivateKeyPem });
  const [prefix, payload, signature] = key.split('.');

  // Re-encode the payload with a different email, keeping the real signature.
  const tamperedPayload = Buffer.from(
    JSON.stringify({ v: 1, e: 'attacker@example.com', o: BUYER.orderNumber })
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const result = await verifyInExtension(`${prefix}.${tamperedPayload}.${signature}`);
  expect(result.status).toBe('bad-signature');
});

test('rejects a key whose signature bytes were flipped', async () => {
  test.skip(!hasSigningKey, `signing key not found at ${PRIVATE_KEY_PATH}`);
  const key = signLicense({ ...BUYER, privateKeyPem: realPrivateKeyPem });
  const [prefix, payload, signature] = key.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);

  const result = await verifyInExtension(`${prefix}.${payload}.${flipped}`);
  expect(['bad-signature', 'malformed']).toContain(result.status);
});

test('handles empty and malformed input without unlocking anything', async () => {
  for (const input of ['', '   ', null, undefined]) {
    expect((await verifyInExtension(input)).status).toBe('empty');
  }
  for (const input of [
    'not-a-key',
    'CM1.only-two-parts',
    'CM2.abc.def',
    'CM1..',
    'CM1.###.###',
    'CM1.eyJhIjoxfQ.tooshort'
  ]) {
    const result = await verifyInExtension(input);
    expect(result.status).not.toBe('valid');
    expect(result.payload).toBeUndefined();
  }
});

test('tolerates whitespace and line breaks from copy-pasting an email', async () => {
  test.skip(!hasSigningKey, `signing key not found at ${PRIVATE_KEY_PATH}`);
  const key = signLicense({ ...BUYER, privateKeyPem: realPrivateKeyPem });
  const mangled = `  ${key.slice(0, 20)}\n${key.slice(20)}  `;

  const result = await verifyInExtension(mangled);
  expect(result.status).toBe('valid');
});

test('activate stores the license and isPro reports true; deactivate reverses it', async () => {
  test.skip(!hasSigningKey, `signing key not found at ${PRIVATE_KEY_PATH}`);
  const key = signLicense({ ...BUYER, privateKeyPem: realPrivateKeyPem });

  expect(await page.evaluate(async () => (await import('/src/lib/license.js')).isPro())).toBe(false);

  const activated = await page.evaluate(async (k) => {
    const mod = await import('/src/lib/license.js');
    const result = await mod.activateLicense(k);
    return { status: result.status, isPro: await mod.isPro(), stored: await mod.getStoredLicense() };
  }, key);
  expect(activated.status).toBe('valid');
  expect(activated.isPro).toBe(true);
  expect(activated.stored.email).toBe(BUYER.email);
  expect(activated.stored.orderNumber).toBe(BUYER.orderNumber);

  const after = await page.evaluate(async () => {
    const mod = await import('/src/lib/license.js');
    await mod.deactivateLicense();
    return { isPro: await mod.isPro(), stored: await mod.getStoredLicense() };
  });
  expect(after.isPro).toBe(false);
  expect(after.stored).toBeNull();
});

test('a forged key is not stored and does not unlock Pro', async () => {
  const forged = signLicense({ ...BUYER, privateKeyPem: forgedKeyPem });
  const result = await page.evaluate(async (k) => {
    const mod = await import('/src/lib/license.js');
    const activation = await mod.activateLicense(k);
    return { status: activation.status, isPro: await mod.isPro(), stored: await mod.getStoredLicense() };
  }, forged);

  expect(result.status).toBe('bad-signature');
  expect(result.isPro).toBe(false);
  expect(result.stored).toBeNull();
});

test('a hand-edited storage entry does not unlock Pro', async () => {
  // Someone editing storage directly cannot fake their way in, because
  // isPro() re-verifies the signature instead of trusting a flag.
  const result = await page.evaluate(async () => {
    await chrome.storage.sync.set({
      license: { key: 'CM1.fake.fake', email: 'me@example.com', orderId: 'x' }
    });
    const mod = await import('/src/lib/license.js');
    return mod.isPro();
  });
  expect(result).toBe(false);
});
