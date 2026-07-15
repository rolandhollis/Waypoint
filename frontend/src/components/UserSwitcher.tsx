import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { useHealth, useMe, useMockRoster } from "../lib/queries";
import { useMockUserStore } from "../lib/mockUser";
import { api } from "../lib/api";
import { ProfileDialog } from "./ProfileDialog";

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
  const [profileOpen, setProfileOpen] = useState(false);

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
      <>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="hidden rounded px-2 py-1 text-right text-xs text-wp-slate transition hover:bg-wp-stone/40 focus:bg-wp-stone/40 focus:outline-none sm:block"
            title="Edit your profile"
          >
            Signed in as
            <div className="font-medium text-wp-ink">{me.data.name}</div>
          </button>
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
        {profileOpen ? <ProfileDialog onClose={() => setProfileOpen(false)} /> : null}
      </>
    );
  }

  // Okta / Cloudflare Access: no impersonation, no client-side logout
  // (IdP owns the session), just show who's here.
  if (!isMockMode) {
    if (!me.data) return null;
    return (
      <>
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          className="flex items-center gap-2 rounded px-2 py-1 text-xs text-wp-slate transition hover:bg-wp-stone/40 focus:bg-wp-stone/40 focus:outline-none"
          title="Edit your profile"
        >
          <span>Signed in as</span>
          <span className="font-medium text-wp-ink">{me.data.name}</span>
          <span className="chip">{me.data.role}</span>
        </button>
        {profileOpen ? <ProfileDialog onClose={() => setProfileOpen(false)} /> : null}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          disabled={!me.data}
          className="hidden rounded px-2 py-1 text-right text-xs text-wp-slate transition hover:bg-wp-stone/40 focus:bg-wp-stone/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:block"
          title="Edit your profile"
        >
          Signed in as
          <div className="font-medium text-wp-ink">{me.data?.name}</div>
        </button>
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
      {profileOpen ? <ProfileDialog onClose={() => setProfileOpen(false)} /> : null}
    </>
  );
}
