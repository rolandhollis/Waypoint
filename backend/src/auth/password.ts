import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

/**
 * Password policy + hashing helpers.
 *
 * Policy is intentionally modern-NIST-ish: length first, then a
 * character-class *floor* (not a ceiling) so users can pick a long
 * passphrase without being forced to add symbols they'll forget.
 * The common-password blocklist catches the "Password123!" class of
 * technically-compliant-but-easily-cracked choices.
 */

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;
/** Minimum number of {upper, lower, digit, symbol} classes required. */
export const MIN_CLASSES = 3;
export const BCRYPT_COST = 12;

/**
 * Bundled short-list of egregiously common passwords. This isn't a
 * substitute for a real blocklist (haveibeenpwned or similar), but it
 * catches the ~50 most-guessed strings essentially for free. Match is
 * case-insensitive.
 */
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

export type PasswordError =
  | { kind: "too_short"; min: number }
  | { kind: "too_long"; max: number }
  | { kind: "insufficient_variety"; need: number; got: number }
  | { kind: "common" }
  | { kind: "contains_email" };

/**
 * Validate a plaintext password against the policy. Returns an empty
 * array when the password is acceptable. `email` is optional; when
 * provided, we forbid the local-part appearing as a substring of the
 * password (Roland → "roland@x", password "Roland!s super" would be
 * rejected).
 */
export function validatePassword(password: string, email?: string | null): PasswordError[] {
  const errs: PasswordError[] = [];
  if (password.length < MIN_LENGTH) errs.push({ kind: "too_short", min: MIN_LENGTH });
  if (password.length > MAX_LENGTH) errs.push({ kind: "too_long", max: MAX_LENGTH });
  const classes = countClasses(password);
  if (classes < MIN_CLASSES) errs.push({ kind: "insufficient_variety", need: MIN_CLASSES, got: classes });
  if (COMMON_PASSWORDS.has(password.toLowerCase())) errs.push({ kind: "common" });
  if (email) {
    const local = email.split("@")[0]?.trim().toLowerCase();
    if (local && local.length >= 3 && password.toLowerCase().includes(local)) {
      errs.push({ kind: "contains_email" });
    }
  }
  return errs;
}

/** Human-readable rendering of policy errors — safe to surface to
 *  users; leaks no secrets. */
export function formatPasswordErrors(errs: PasswordError[]): string[] {
  return errs.map((e) => {
    switch (e.kind) {
      case "too_short":
        return `must be at least ${e.min} characters`;
      case "too_long":
        return `must be at most ${e.max} characters`;
      case "insufficient_variety":
        return `must include at least ${e.need} of: uppercase, lowercase, digit, symbol (got ${e.got})`;
      case "common":
        return "must not be a common password";
      case "contains_email":
        return "must not contain your email username";
    }
  });
}

function countClasses(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n++;
  if (/[A-Z]/.test(password)) n++;
  if (/[0-9]/.test(password)) n++;
  if (/[^a-zA-Z0-9]/.test(password)) n++;
  return n;
}

// -----------------------------------------------------------------
// Password generator
// -----------------------------------------------------------------

// Deliberately drop chars that read ambiguously in most fonts so a
// generated password can be dictated over the phone or copied out of
// a screenshot without transcription errors.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";       // no I, O
const LOWER = "abcdefghijkmnopqrstuvwxyz";       // no l
const DIGIT = "23456789";                        // no 0, 1
const SYMBOL = "!@#$%^&*+-=?";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/**
 * Generate a policy-compliant random password. Cryptographically
 * random source (node:crypto), guaranteed to contain at least one
 * character from every class, and shuffled so the class chars aren't
 * always at the front.
 */
export function generatePassword(length = 20): string {
  if (length < 8) throw new Error("password length must be >= 8");
  const out: string[] = [
    pick(UPPER),
    pick(LOWER),
    pick(DIGIT),
    pick(SYMBOL),
  ];
  while (out.length < length) out.push(pick(ALL));
  return shuffle(out).join("");
}

function pick(alphabet: string): string {
  const idx = randomByte() % alphabet.length;
  return alphabet[idx]!;
}

function shuffle<T>(arr: T[]): T[] {
  // Fisher-Yates using crypto-quality randomness for each index. Cheap
  // for password-sized arrays; not something to worry about at scale.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomByte() % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function randomByte(): number {
  const b = randomBytes(1);
  return b[0]!;
}

// -----------------------------------------------------------------
// Hashing
// -----------------------------------------------------------------

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Constant-time password check via bcrypt. Returns false if either
 * the hash or the password is missing so the caller can treat "no
 * password on file" as a plain failed login without leaking a
 * different error path.
 */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}
