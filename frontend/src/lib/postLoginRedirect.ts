/**
 * Shareable-URL support for the login → intended-destination flow.
 *
 * When an unauthenticated visit lands on a real app route (e.g.
 * Alice pastes `/roadmap?zoom=1yr&teams=t1,t2` to Bob and Bob isn't
 * signed in yet), the auth guard bounces to `/login` — but the
 * original pathname + search need to survive that hop so we can
 * take Bob back to the exact view Alice deep-linked once he's
 * signed in.
 *
 * We stash the intended destination in `sessionStorage` (not
 * `localStorage`) so it's tab-scoped and self-clears on tab close;
 * two tabs signing in independently won't step on each other. The
 * key is exported so the two writers (the 401 handler + the mount
 * effect in App) and the reader (LoginView / MockLoginScreen) stay
 * in lockstep.
 */

export const POST_LOGIN_REDIRECT_STORAGE_KEY = "waypoint.postLoginRedirect";

/** Paths that ARE the auth flow itself — bouncing to them would loop. */
const AUTH_PATHS = new Set(["/login", "/forgot-password", "/reset-password"]);

/**
 * Persist `pathname + search` for the current window as the target
 * the login screen should return to. No-ops on the auth-flow paths
 * (bouncing Bob to `/login` after signing him in would be a loop),
 * and swallows storage errors (Safari private mode, quota, etc.)
 * so a rare browser quirk never cascades into a failed login.
 */
export function stashPostLoginRedirect(pathname: string, search: string): void {
  if (AUTH_PATHS.has(pathname)) return;
  try {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_STORAGE_KEY, `${pathname}${search}`);
  } catch {
    // sessionStorage disabled — the login flow will fall back to /board.
  }
}

/**
 * Read (and clear) the stashed post-login target. Returns null when
 * nothing is stashed OR when the stashed value doesn't look like a
 * local path (basic open-redirect guard against a poisoned session
 * store — `//evil.example` and full URLs are rejected).
 */
export function consumePostLoginRedirect(): string | null {
  try {
    const raw = sessionStorage.getItem(POST_LOGIN_REDIRECT_STORAGE_KEY);
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_STORAGE_KEY);
    if (!raw) return null;
    // Must be a same-origin path: starts with "/" and NOT "//" (which
    // browsers interpret as protocol-relative and would redirect
    // off-site). Also reject anything with a scheme like `javascript:`.
    if (!raw.startsWith("/")) return null;
    if (raw.startsWith("//")) return null;
    return raw;
  } catch {
    return null;
  }
}
