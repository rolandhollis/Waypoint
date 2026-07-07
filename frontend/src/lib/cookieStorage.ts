import type { StateStorage } from "zustand/middleware";

/**
 * Minimal `document.cookie`-backed StateStorage adapter for zustand's
 * `persist` middleware. Cookies are readable/writable client-side (no
 * HttpOnly), scoped to the site root, and default to a 1-year TTL so the
 * chosen mock user survives browser restarts.
 */
const DEFAULT_MAX_AGE_DAYS = 365;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const target = `${encodeURIComponent(name)}=`;
  const parts = document.cookie ? document.cookie.split("; ") : [];
  for (const raw of parts) {
    if (raw.startsWith(target)) {
      return decodeURIComponent(raw.slice(target.length));
    }
  }
  return null;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  const attrs = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "path=/",
    `max-age=${maxAgeSeconds}`,
    "SameSite=Lax",
  ];
  document.cookie = attrs.join("; ");
}

export function createCookieStorage(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): StateStorage {
  const maxAgeSeconds = Math.max(0, Math.floor(maxAgeDays * 24 * 60 * 60));
  return {
    getItem: (name) => readCookie(name),
    setItem: (name, value) => writeCookie(name, value, maxAgeSeconds),
    removeItem: (name) => writeCookie(name, "", 0),
  };
}
