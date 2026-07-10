/**
 * Client-side mirror of the backend password policy in
 * backend/src/auth/password.ts. Keep the two in lock-step — the
 * server is always the source of truth (it re-validates on submit
 * and will reject anything that slipped past the client), but a
 * matching client-side check gives the admin an immediate,
 * per-keystroke green/red signal instead of a form-level error.
 */

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;
export const MIN_CLASSES = 3;

const COMMON_PASSWORDS = new Set(
  [
    "password", "password1", "password123", "passw0rd", "letmein",
    "welcome", "welcome1", "qwerty", "qwerty123", "abc123",
    "iloveyou", "admin", "administrator", "root", "toor",
    "12345678", "123456789", "1234567890", "111111", "000000",
    "monkey", "dragon", "master", "sunshine", "princess",
    "trustno1", "hello", "hello123", "test", "test123",
    "changeme", "changeme1", "default", "guest", "waypoint",
    "waypoint1", "backlog", "roadmap", "product", "productmanager",
  ].map((s) => s.toLowerCase()),
);

export type PasswordCheck = {
  label: string;
  passed: boolean;
};

/**
 * Deterministic checklist for the strength meter. Every rule is
 * evaluated even if an earlier one already failed so the UI can
 * render the full ✓/✗ list.
 */
export function checkPassword(password: string, email?: string | null): PasswordCheck[] {
  const classes = countClasses(password);
  const local = email?.split("@")[0]?.trim().toLowerCase();
  return [
    {
      label: `At least ${MIN_LENGTH} characters`,
      passed: password.length >= MIN_LENGTH && password.length <= MAX_LENGTH,
    },
    {
      label: `Includes ≥ ${MIN_CLASSES} of: uppercase, lowercase, digit, symbol`,
      passed: classes >= MIN_CLASSES,
    },
    { label: "Not a common password", passed: !COMMON_PASSWORDS.has(password.toLowerCase()) },
    {
      label: "Doesn't contain your email username",
      passed: !(local && local.length >= 3 && password.toLowerCase().includes(local)),
    },
  ];
}

export function passwordIsValid(password: string, email?: string | null): boolean {
  return checkPassword(password, email).every((c) => c.passed);
}

function countClasses(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n++;
  if (/[A-Z]/.test(password)) n++;
  if (/[0-9]/.test(password)) n++;
  if (/[^a-zA-Z0-9]/.test(password)) n++;
  return n;
}
