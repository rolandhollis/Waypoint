import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useHealth, useMe, useMockRoster } from "./lib/queries";
import { useMockUserStore } from "./lib/mockUser";
import { cn } from "./lib/cn";
import { BoardView } from "./views/BoardView";
import { RoadmapView } from "./views/RoadmapView";
import { StatusReportView } from "./views/StatusReportView";
import { AdminSettingsView } from "./views/AdminSettingsView";
import { PhasesView } from "./views/PhasesView";
import { ReminderBanner } from "./components/ReminderBanner";
import { UserSwitcher } from "./components/UserSwitcher";

export function App() {
  const health = useHealth();
  const mockUserId = useMockUserStore((s) => s.mockUserId);
  const me = useMe();
  const isMockMode = health.data?.auth === "mock";

  if (health.isLoading || !health.data) {
    return <FullscreenMessage title="Loading…" />;
  }

  // Mock mode: pick a mock user before entering the app.
  if (isMockMode && (!mockUserId || !me.data)) {
    return (
      <>
        <MockAuthBanner />
        <LoginScreen />
      </>
    );
  }

  // Prod modes (Okta / Cloudflare Access): the IdP has already
  // authenticated the browser session; /users/me is the source of
  // truth. Loading = wait; error = show a helpful failure page.
  if (!isMockMode && me.isLoading) {
    return <FullscreenMessage title="Signing in…" />;
  }
  if (!isMockMode && !me.data) {
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
      <ReminderBanner />
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/board" replace />} />
          <Route path="/board" element={<BoardView />} />
          <Route path="/roadmap" element={<RoadmapView />} />
          <Route path="/status-report" element={<StatusReportView />} />
          <Route path="/phases" element={<PhasesView />} />
          <Route path="/admin" element={<AdminSettingsView />} />
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

function LoginScreen() {
  const roster = useMockRoster();
  const setMockUserId = useMockUserStore((s) => s.setMockUserId);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function pick(id: string) {
    setMockUserId(id);
    // Bust every cached response — including any prior 401 on /users/me —
    // so React Query refetches with the new x-mock-user-id header.
    await qc.invalidateQueries();
    navigate("/board", { replace: true });
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
  const me = useMe();
  const location = useLocation();
  const isAdmin = me.data?.role === "admin";
  return (
    <header className="flex items-center justify-between border-b border-wp-stone bg-white px-5 py-2.5">
      <div className="flex items-center gap-6">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold text-wp-red">Waypoint</span>
          <span className="text-sm font-medium text-wp-slate">Backlog &amp; Roadmap</span>
        </div>
        <nav className="flex items-center gap-1">
          <NavItem to="/board" active={location.pathname.startsWith("/board")}>Board</NavItem>
          <NavItem to="/roadmap" active={location.pathname.startsWith("/roadmap")}>Roadmap</NavItem>
          <NavItem to="/status-report" active={location.pathname.startsWith("/status-report")}>Status Report</NavItem>
          <NavItem to="/phases" active={location.pathname.startsWith("/phases")}>Phases</NavItem>
          {isAdmin ? (
            <NavItem to="/admin" active={location.pathname.startsWith("/admin")}>Admin</NavItem>
          ) : null}
        </nav>
      </div>
      <UserSwitcher />
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
