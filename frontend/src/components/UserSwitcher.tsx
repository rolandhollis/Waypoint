import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { useHealth, useMe, useMockRoster } from "../lib/queries";
import { useMockUserStore } from "../lib/mockUser";
import { api } from "../lib/api";

export function UserSwitcher() {
  const health = useHealth();
  const me = useMe();
  const isMockModeReady = health.data?.auth === "mock";
  const roster = useMockRoster(isMockModeReady);
  const setMockUserId = useMockUserStore((s) => s.setMockUserId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isMockMode = isMockModeReady;
  const isPasswordMode = health.data?.auth === "password";

  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: async () => {
      // Nuke every cached response so a subsequent login flushes any
      // stale data belonging to the previous account.
      qc.clear();
      navigate("/login", { replace: true });
    },
  });

  // Password mode: identity display + sign-out.
  if (isPasswordMode) {
    if (!me.data) return null;
    return (
      <div className="flex items-center gap-3">
        <div className="hidden text-right text-xs text-wp-slate sm:block">
          Signed in as
          <div className="font-medium text-wp-ink">{me.data.name}</div>
        </div>
        <span className="chip">{me.data.role}</span>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={logout.isPending}
          title="Sign out"
        >
          <LogOut size={13} />
          {logout.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    );
  }

  // Okta / Cloudflare Access: no impersonation, no client-side logout
  // (IdP owns the session), just show who's here.
  if (!isMockMode) {
    if (!me.data) return null;
    return (
      <div className="flex items-center gap-2 text-xs text-wp-slate">
        <span>Signed in as</span>
        <span className="font-medium text-wp-ink">{me.data.name}</span>
        <span className="chip">{me.data.role}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right text-xs text-wp-slate sm:block">
        Signed in as
        <div className="font-medium text-wp-ink">{me.data?.name}</div>
      </div>
      <select
        className="input w-48"
        aria-label="Switch mock user"
        value={me.data?.id ?? ""}
        onChange={(e) => {
          setMockUserId(e.target.value || null);
          qc.invalidateQueries();
        }}
      >
        {roster.data?.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({u.role})
          </option>
        ))}
      </select>
    </div>
  );
}
