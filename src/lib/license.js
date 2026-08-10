// CookieMop Pro license verification.
//
// Licenses are verified ENTIRELY OFFLINE. The extension never contacts a
// server — not at purchase time, not at startup, not ever. A license key is
// a signed payload; this module checks the signature against a public key
// compiled into the extension. That is why the listing can still promise
// zero network requests with Pro enabled.
//
// Key format:  CM1.<base64url(payload JSON)>.<base64url(signature)>
// Signature:   ECDSA P-256 / SHA-256, raw IEEE P-1363 (64 bytes)
//
// The private counterpart lives only in the issuing server's environment.
// A public key cannot mint licenses, so shipping it here is safe.

const KEY_PREFIX = 'CM1';

// Public key: raw uncompressed EC point (65 bytes, 0x04 || X || Y), base64.
const PUBLIC_KEY_B64 =
  'BBE/RsA9HZpdtXc1Av2Mz1pysyAsZUSmz/s7FgJM/Kx/c+aelWYi7nBnYEfpsMrT898A+GLlp5C+0ybUuEp+TUM=';

const ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };
const IMPORT_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' };

/** Verification outcomes. `valid` is the only one that unlocks Pro. */
export const LicenseStatus = {
  VALID: 'valid',
  EMPTY: 'empty',
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad-signature',
  UNSUPPORTED: 'unsupported'
};

function base64UrlToBytes(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64ToBytes(input) {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let publicKeyPromise = null;
function getPublicKey() {
  if (!publicKeyPromise) {
    publicKeyPromise = crypto.subtle.importKey(
      'raw',
      base64ToBytes(PUBLIC_KEY_B64),
      IMPORT_PARAMS,
      false,
      ['verify']
    );
  }
  return publicKeyPromise;
}

/**
 * Strip whitespace users pick up when copying a key out of an email.
 * Keys are copy-pasted by hand, so be forgiving about spaces and newlines.
 */
export function normalizeKey(rawKey) {
  return String(rawKey || '').replace(/\s+/g, '');
}

/**
 * Verify a license key offline.
 * Returns { status, payload } — payload is present only when status is VALID.
 */
export async function verifyLicenseKey(rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) return { status: LicenseStatus.EMPTY };

  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
    return { status: LicenseStatus.MALFORMED };
  }

  let payloadBytes;
  let signatureBytes;
  try {
    payloadBytes = base64UrlToBytes(parts[1]);
    signatureBytes = base64UrlToBytes(parts[2]);
  } catch {
    return { status: LicenseStatus.MALFORMED };
  }
  // P-256 raw signatures are exactly 64 bytes; anything else is not ours.
  if (signatureBytes.length !== 64 || payloadBytes.length === 0) {
    return { status: LicenseStatus.MALFORMED };
  }

  let verified;
  try {
    verified = await crypto.subtle.verify(
      ALGORITHM,
      await getPublicKey(),
      signatureBytes,
      payloadBytes
    );
  } catch {
    // WebCrypto unavailable (non-secure context) — fail closed, never open.
    return { status: LicenseStatus.UNSUPPORTED };
  }
  if (!verified) return { status: LicenseStatus.BAD_SIGNATURE };

  // Signature checked out; only now is it safe to trust the contents.
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { status: LicenseStatus.MALFORMED };
  }
  if (!payload || typeof payload !== 'object' || !payload.e || !payload.o) {
    return { status: LicenseStatus.MALFORMED };
  }

  return {
    status: LicenseStatus.VALID,
    payload: {
      email: String(payload.e),
      orderId: String(payload.o),
      issuedAt: Number(payload.i) || 0,
      version: Number(payload.v) || 1
    }
  };
}

// --- Stored license state -------------------------------------------------
// The key lives in storage.sync so a paid user who signs into Chrome on a
// second machine keeps Pro without digging the email out again.

const LICENSE_DEFAULTS = { license: null };

export async function getStoredLicense() {
  const { license } = await chrome.storage.sync.get(LICENSE_DEFAULTS);
  return license;
}

/**
 * Verify and persist a key. Returns the same shape as verifyLicenseKey.
 * Nothing is stored unless the signature checks out.
 */
export async function activateLicense(rawKey) {
  const result = await verifyLicenseKey(rawKey);
  if (result.status !== LicenseStatus.VALID) return result;
  await chrome.storage.sync.set({
    license: {
      key: normalizeKey(rawKey),
      email: result.payload.email,
      orderId: result.payload.orderId,
      issuedAt: result.payload.issuedAt,
      activatedAt: Date.now()
    }
  });
  return result;
}

export async function deactivateLicense() {
  await chrome.storage.sync.remove('license');
}

/**
 * True when a stored license still verifies.
 *
 * The stored key is re-verified rather than trusted as a boolean flag, so a
 * hand-edited storage entry does not unlock Pro. This is deliberately cheap
 * (one local signature check) and involves no network.
 */
export async function isPro() {
  const license = await getStoredLicense();
  if (!license?.key) return false;
  const result = await verifyLicenseKey(license.key);
  return result.status === LicenseStatus.VALID;
}
