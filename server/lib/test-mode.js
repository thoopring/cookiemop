// ALLOW_TEST_MODE handling.
//
// Test-mode orders must never mint real license keys. The founder does need
// them for one end-to-end check after deploying, though, and an env var that
// has to be deleted afterwards is exactly the kind of thing that gets left
// behind — right after a successful purchase test, when attention moves on.
//
// So the variable is not a switch, it is a deadline:
//
//   ALLOW_TEST_MODE=2026-08-25   test orders work until that date, then stop
//   (unset)                      test orders are refused
//
// Forgetting to remove it costs nothing: it closes itself.

export const TestModeProblem = {
  UNSET: 'unset',
  MALFORMED: 'malformed',
  EXPIRED: 'expired'
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a YYYY-MM-DD string into the UTC instant that date begins.
 * Returns null for anything that is not a real calendar date, so that
 * "2026-02-30" or "2026-13-01" are refused rather than silently shifted.
 */
function parseUtcDate(value) {
  if (!DATE_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) return null;
  // Date.parse accepts some rolled-over dates; confirm it round-trips.
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

/**
 * Decide whether test-mode orders may be accepted right now.
 *
 * @param {string|undefined} rawValue  the ALLOW_TEST_MODE env value
 * @param {Date} [now]
 * @returns {{allowed: boolean, expiresAt: string|null, problem: string|null}}
 */
export function evaluateTestMode(rawValue, now = new Date()) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    return { allowed: false, expiresAt: null, problem: TestModeProblem.UNSET };
  }

  const expiresAt = parseUtcDate(value);
  if (expiresAt === null) {
    return { allowed: false, expiresAt: null, problem: TestModeProblem.MALFORMED };
  }

  // Expiry is the start of that day, UTC: on the date itself it is closed.
  if (now.getTime() >= expiresAt) {
    return { allowed: false, expiresAt: value, problem: TestModeProblem.EXPIRED };
  }

  return { allowed: true, expiresAt: value, problem: null };
}

/**
 * One-line operator warning for a test-mode value that is set but not
 * usable. Returns null when there is nothing worth logging (unset is the
 * normal production state, so it stays quiet).
 */
export function testModeWarning(state, rawValue) {
  if (state.problem === TestModeProblem.MALFORMED) {
    return `ALLOW_TEST_MODE is set to "${String(rawValue ?? '').trim()}" which is not a YYYY-MM-DD date. Test orders are being refused. Remove the variable, or set a real expiry date.`;
  }
  if (state.problem === TestModeProblem.EXPIRED) {
    return `ALLOW_TEST_MODE expired on ${state.expiresAt}. Test orders are being refused, as intended. You can delete the variable now.`;
  }
  return null;
}
