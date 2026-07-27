import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useHealth, useMe, useMockRoster } from "../lib/queries";
import { useMockUserStore } from "../lib/mockUser";
import { api } from "../lib/api";
import { NotificationsMenu } from "./NotificationsMenu";
import { ProfileDialog } from "./ProfileDialog";

/**
 * Right-hand navbar chunk.
 *
 * The circular avatar (via `NotificationsMenu`) is the single
 * entry point for identity + mentions:
 *   - hover / click surfaces the latest 10 mentions plus the
 *     unread badge;
 *   - the popover footer carries the Profile link (opens the
 *     self-serve editor dialog) and, in password mode, the
 *     Sign-out button.
 *
 * In mock mode a mock-user select still renders alongside the
 * avatar so devs can hop identities in one click; that's the
 * only affordance that doesn't collapse into the popover.
 */
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

  // Nothing to render until /users/me resolves — the parent shell
  // already gates behind health.data, so this is defense-in-depth
  // for the transient loading window.
  if (!me.data) return null;

  return (
    <>
      <div className="flex items-center gap-3">
        {/* Role chip preserves the existing "at-a-glance
            per-tenant role" affordance. Kept as a separate chip
            beside the avatar so the popover doesn't have to
            duplicate it, and so the mock-mode row stays
            visually parallel to the password/okta rows. */}
        <span className="chip">{me.data.role}</span>
        {/* Mock-mode identity switcher — the only user-facing
            affordance that doesn't collapse into the popover.
            Devs need to hop between mock users regularly and a
            single-click select is the fastest surface for that. */}
        {isMockMode ? (
          <select
            className="input w-48"
            aria-label="Switch mock user"
            value={me.data.id}
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
        ) : null}
        <NotificationsMenu
          onOpenProfile={() => setProfileOpen(true)}
          onSignOut={isPasswordMode ? () => logout.mutate() : null}
          signOutBusy={logout.isPending}
        />
      </div>
      {profileOpen ? <ProfileDialog onClose={() => setProfileOpen(false)} /> : null}
    </>
  );
}
