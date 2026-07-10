import { useMockUserStore } from "./mockUser";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Global 401 sink. Set once by App.tsx during mount so any 401 from
 * the server (session expired, admin revoked, etc.) can flip the
 * shell back to the login screen without every hook having to handle
 * it. Kept as a plain function ref so we don't force a re-render on
 * subscription.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  onUnauthorized = fn;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // Mock-mode identity header. Ignored server-side in password mode
  // but sent unconditionally so mock ↔ password mode transitions in
  // dev don't require a client rebuild.
  const mockId = useMockUserStore.getState().mockUserId;
  if (mockId) headers.set("x-mock-user-id", mockId);

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    // Send the session cookie on same-origin, and on the dev
    // cross-origin case where CORS is configured to allow creds.
    credentials: "include",
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText || "request failed";
    // 401 is special: fire the global handler so the shell can bounce
    // to /login. Ignore for the health check + explicit login/logout
    // requests (they surface their own error state).
    const isAuthProbe = path === "/auth/login" || path === "/auth/logout";
    if (res.status === 401 && !isAuthProbe) {
      onUnauthorized?.();
    }
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}
