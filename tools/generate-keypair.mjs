// One-time license signing keypair generator (ECDSA P-256).
//
// SECURITY: the private key is written to a file OUTSIDE this repository and
// is never printed to stdout, so it cannot end up in a repo, a terminal
// scrollback, or an agent transcript. Only the public key is printed — that
// one is safe to embed in the extension.
//
// Usage:
//   node tools/generate-keypair.mjs [outDir]
//
// Default outDir: ../cookiemop-secrets (a sibling of the repo)

import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';

const outDir = resolve(process.argv[2] || join(process.cwd(), '..', 'cookiemop-secrets'));
const privPath = join(outDir, 'license-private-key.pem');
const pubPath = join(outDir, 'license-public-key.pem');

if (existsSync(privPath)) {
  console.error(`Refusing to overwrite an existing private key at:\n  ${privPath}`);
  console.error('Delete it deliberately first if you really mean to rotate the key.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
// Raw uncompressed point (65 bytes, 0x04 || X || Y) — the form WebCrypto
// imports with format 'raw' in the extension.
const pubRawB64 = Buffer.from(
  publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)
).toString('base64');

// Self-check: a signature made with this private key must verify with this
// public key before we hand either of them over.
const probe = Buffer.from('cookiemop-keypair-selftest');
const signer = createSign('SHA256');
signer.update(probe);
const sig = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
const verifier = createVerify('SHA256');
verifier.update(probe);
const ok = verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
if (!ok || sig.length !== 64) {
  console.error('Self-check failed — refusing to write an unusable keypair.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(privPath, privPem, { mode: 0o600 });
writeFileSync(pubPath, pubPem);
try {
  chmodSync(privPath, 0o600);
} catch { /* best effort on Windows */ }

console.log('Keypair generated. Self-check passed (64-byte P-1363 signature verified).\n');
console.log('PRIVATE KEY written to (never commit, never paste into chat):');
console.log('  ' + privPath + '\n');
console.log('PUBLIC KEY (safe to embed in the extension) — raw base64, 65 bytes:');
console.log('  ' + pubRawB64 + '\n');
console.log('Next steps:');
console.log('  1. Paste the public key above into src/lib/license.js (PUBLIC_KEY_B64).');
console.log('  2. Copy the PEM contents of the private key file into the Vercel');
console.log('     environment variable LICENSE_PRIVATE_KEY (Settings > Environment Variables).');
console.log('  3. Keep a backup of the private key somewhere safe and offline.');
console.log('     Losing it means you cannot issue licenses for existing customers.');
