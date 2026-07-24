import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAppName, useHealth, useIsAdmin, useMe, useMockRoster } from "./lib/queries";
import { useMockUserStore } from "./lib/mockUser";
import { setUnauthorizedHandler } from "./lib/api";
import { cn } from "./lib/cn";
import { BoardView } from "./views/BoardView";
import { PrioritizationView } from "./views/PrioritizationView";
import { RoadmapView } from "./views/RoadmapView";
import { StatusReportView } from "./views/StatusReportView";
import { KpiReportView } from "./views/KpiReportView";
import { EZEstimatesView } from "./views/EZEstimatesView";
import { AdminSettingsView } from "./views/AdminSettingsView";
import { PhasesView } from "./views/PhasesView";
import { ProjectDetailPage } from "./views/ProjectDetailPage";
import { LoginView } from "./views/LoginView";
import { ForgotPasswordView } from "./views/ForgotPasswordView";
import { ResetPasswordView } from "./views/ResetPasswordView";
import { ReminderBanner } from "./components/ReminderBanner";
import { UserSwitcher } from "./components/UserSwitcher";
import { GroupSwitcher } from "./components/GroupSwitcher";
import {
  consumePostLoginRedirect,
  stashPostLoginRedirect,
} from "./lib/postLoginRedirect";

export function App() {
  const health = useHealth();
  const mockUserId = useMockUserStore((s) => s.mockUserId);
  const isMockMode = health.data?.auth === "mock";
  const isPasswordMode = health.data?.auth === "password";
  // In password mode we haven't proven authentication yet, so skip
  // the /users/me probe until either health resolves to mock (where
  // the mock user id gates it) or password mode is confirmed and
  // the login screen owns the auth flow.
  const me = useMe(!!health.data);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  // Wire a single global 401 handler that flips the shell back to
  // /login (password mode) or the mock picker (mock mode). Runs once
  // per mount because the handler ref is deps-invariant.
  //
  // IMPORTANT: don't force-navigate away from routes that are
  // explicitly meaningful while unauthenticated. /reset-password
  // carries a one-time token in the URL that IS the authorization
  // — bouncing to /login would throw the token away and land the
  // user on a screen that can't help them. /forgot-password is the
  // same story (no token, but it's the entry point of the recovery
  // flow). The unauthenticated Routes block below already renders
  // the correct view for both paths, so we just clear the me cache
  // and let the tree re-render.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(["me"], null);
      if (!isPasswordMode) return;
      const path = window.location.pathname;
      if (path === "/reset-password" || path === "/forgot-password") return;
      // Stash the URL the user was on (pathname + search) so the
      // post-login redirect can take them straight back to the same
      // filtered view — critical for shareable roadmap links, but
      // helpful on every deep-linked route. `stashPostLoginRedirect`
      // itself no-ops on the auth-flow paths so a stray 401 fired
      // while already on `/login` can't overwrite an earlier stash.
      stashPostLoginRedirect(window.location.pathname, window.location.search);
      navigate("/login", { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc, navigate, isPasswordMode]);

  // Deep-link preservation for the "no session yet" initial-visit
  // case. When password mode is confirmed but `/users/me` has
  // resolved to null (the wildcard `<Navigate to="/login" />` below
  // is about to render), snapshot the current path + search so
  // LoginView can restore it on success. Kept as an effect (not
  // inline in the redirect element) so a full-page reload on
  // `/roadmap?zoom=1yr` still stashes the intended destination
  // before react-router replaces the URL with `/login`. Runs at
  // most once per navigation because the auth-flow guard short-
  // circuits `stashPostLoginRedirect`.
  useEffect(() => {
    if (!isPasswordMode) return;
    if (me.isLoading) return;
    if (me.data) return;
    stashPostLoginRedirect(location.pathname, location.search);
  }, [isPasswordMode, me.isLoading, me.data, location.pathname, location.search]);

  if (health.isLoading || !health.data) {
    return <FullscreenMessage title="Loading…" />;
  }

  // Password mode: dedicated /login route. Everything else redirects
  // to it until /users/me returns a user.
  if (isPasswordMode) {
    if (me.isLoading) {
      return <FullscreenMessage title="Signing in…" />;
    }
    if (!me.data) {
      return (
        <Routes>
          <Route path="/login" element={<LoginView />} />
          <Route path="/forgot-password" element={<ForgotPasswordView />} />
          <Route path="/reset-password" element={<ResetPasswordView />} />
          <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
        </Routes>
      );
    }
  }

  // Mock mode: pick a mock user before entering the app.
  if (isMockMode && (!mockUserId || !me.data)) {
    return (
      <>
        <MockAuthBanner />
        <MockLoginScreen />
      </>
    );
  }

  // Legacy prod modes (Okta / Cloudflare Access): IdP has already
  // authenticated the browser session; /users/me is the source of
  // truth.
  if (!isMockMode && !isPasswordMode && me.isLoading) {
    return <FullscreenMessage title="Signing in…" />;
  }
  if (!isMockMode && !isPasswordMode && !me.data) {
    return (
      <FullscreenMessage
        title="You're not authorized"
        body={
          <>
            You're signed in via <code>{health.data.auth}</code> but your account
            is not provisioned in this app. Ask an admin to add you, then reload.
          </>
        }
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {isMockMode ? <MockAuthBanner /> : null}
      <TopBar />
      <DocumentTitleSync />
      <ReminderBanner />
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/board" replace />} />
          <Route path="/board" element={<BoardView />} />
          <Route path="/prioritization" element={<PrioritizationView />} />
          <Route path="/roadmap" element={<RoadmapView />} />
          <Route path="/status-report" element={<StatusReportView />} />
          <Route path="/ezestimates" element={<EZEstimatesView />} />
          <Route path="/kpis" element={<KpiReportView />} />
          <Route path="/phases" element={<PhasesView />} />
          <Route path="/admin" element={<AdminSettingsView />} />
          {/* Standalone `/projects/:id` — bookmarkable / shareable
              item detail page. Renders the same shared body the
              right-side modal uses (`ProjectDetailBody`), so any
              affordance available in one is available in the
              other. Unauthenticated visits get caught by the
              `<Route path="*" ... />` unauthenticated catch-all
              above, which stashes the target URL through
              `stashPostLoginRedirect` and bounces to `/login`;
              LoginView / MockLoginScreen call
              `consumePostLoginRedirect` after auth and drop the
              user back here. */}
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          {/* /login and /forgot-password only make sense while
              unauthenticated — bounce signed-in users home so they
              don't see the picker copy for a state they aren't in.
              /reset-password is different: the token in the URL is
              the authorization, and users legitimately click these
              links from an email while still holding a valid session
              on a different device (or the same one, if they signed
              in and *then* remembered they wanted to change their
              password). Always render the view; the reset action
              itself revokes every session on success, which cleanly
              signs them out at the end of the flow. */}
          <Route path="/login" element={<Navigate to="/board" replace />} />
          <Route path="/forgot-password" element={<Navigate to="/board" replace />} />
          <Route path="/reset-password" element={<ResetPasswordView />} />
          <Route path="*" element={<Navigate to="/board" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function MockAuthBanner() {
  return (
    <div className="bg-amber-400 text-amber-950 px-4 py-1.5 text-center text-xs font-medium border-b border-amber-600">
      <strong className="mr-1">Demo mode.</strong>
      Auth is <code className="rounded bg-amber-100/60 px-1 py-0.5">mock</code> — anyone can sign in as anyone. Do not use with real data.
    </div>
  );
}

function FullscreenMessage({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="card-surface max-w-sm p-6 text-center">
        <h1 className="text-lg font-semibold text-wp-ink">{title}</h1>
        {body ? <div className="mt-2 text-sm text-wp-slate">{body}</div> : null}
      </div>
    </div>
  );
}

function MockLoginScreen() {
  const roster = useMockRoster();
  const setMockUserId = useMockUserStore((s) => s.setMockUserId);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function pick(id: string) {
    setMockUserId(id);
    // Bust every cached response — including any prior 401 on /users/me —
    // so React Query refetches with the new x-mock-user-id header.
    await qc.invalidateQueries();
    // Mirror the password-mode redirect: if the user landed here
    // from a deep link that stashed its destination, take them
    // straight back to it instead of the /board default. Keeps
    // shareable-URL behavior consistent between mock and password
    // auth modes for local development.
    const target = consumePostLoginRedirect() ?? "/board";
    navigate(target, { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="card-surface w-96 p-6">
        <h1 className="text-lg font-semibold text-wp-ink">Waypoint</h1>
        <p className="mt-1 text-sm text-wp-slate">
          Pick a mock user to sign in (dev mode).
        </p>
        <div className="mt-4 space-y-2">
          {roster.data?.map((u) => (
            <button
              key={u.id}
              onClick={() => pick(u.id)}
              className="btn-secondary w-full justify-between"
            >
              <span>{u.name}</span>
              <span className="text-xs uppercase tracking-wide text-wp-slate">{u.role}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  const location = useLocation();
  // Admin nav item follows PER-GROUP role: a user who's admin in
  // RMN but only owner in VC sees the Admin tab appear/disappear
  // as they switch tenants via the group dropdown.
  const isAdmin = useIsAdmin();
  // Per-tenant app name — an admin can rebrand their group via
  // Admin → Constants without a redeploy. Falls back to the built-in
  // default ("Waypoint") when no override is set.
  const appName = useAppName();
  return (
    <header className="flex items-center justify-between border-b border-wp-stone bg-white px-5 py-2.5">
      <div className="flex items-center gap-6">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold text-wp-red">{appName}</span>
        </div>
        <nav className="flex items-center gap-1">
          <NavItem to="/board" active={location.pathname.startsWith("/board")}>Board</NavItem>
          <NavItem to="/prioritization" active={location.pathname.startsWith("/prioritization")}>Prioritization</NavItem>
          <NavItem to="/roadmap" active={location.pathname.startsWith("/roadmap")}>Roadmap</NavItem>
          <NavItem to="/status-report" active={location.pathname.startsWith("/status-report")}>Status Report</NavItem>
          <NavItem to="/ezestimates" active={location.pathname.startsWith("/ezestimates")}>EZEstimates</NavItem>
          <NavItem to="/kpis" active={location.pathname.startsWith("/kpis")}>KPIs</NavItem>
          <NavItem to="/phases" active={location.pathname.startsWith("/phases")}>Phases</NavItem>
          {isAdmin ? (
            <NavItem to="/admin" active={location.pathname.startsWith("/admin")}>Admin</NavItem>
          ) : null}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <GroupSwitcher />
        <UserSwitcher />
      </div>
    </header>
  );
}

function NavItem({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition",
        active ? "bg-wp-red text-white" : "text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink",
      )}
    >
      {children}
    </NavLink>
  );
}

/**
 * Zero-DOM sync helper: keeps the browser tab / bookmark title in
 * lock-step with the current group's `app_name` constant. Rendered
 * inside the authenticated shell so we never touch the pre-auth
 * title (the static one from index.html is the correct fallback
 * for the login screen — it has no group context to key off of).
 *
 * Original suffix ("— Product Backlog & Roadmap") is preserved so
 * a rebrand only swaps the leading brand slug, not the descriptive
 * subtitle that helps returning users identify the pinned tab.
 */
function DocumentTitleSync() {
  const appName = useAppName();
  useEffect(() => {
    document.title = `${appName} — Product Backlog & Roadmap`;
  }, [appName]);
  return null;
}
