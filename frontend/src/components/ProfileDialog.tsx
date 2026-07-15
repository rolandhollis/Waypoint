import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { passwordIsValid } from "../lib/password";
import type { User } from "../lib/types";
import { useHealth, useMe } from "../lib/queries";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { PasswordField } from "./PasswordField";

/**
 * Self-serve profile editor. Any authenticated user can open this
 * from the "Signed in as" strip in the top nav and update the two
 * things they see everywhere: their display name and avatar color.
 * In password mode a second section lets them rotate their own
 * password (current + new + confirm).
 *
 * Keeps the two sections independently submittable — a name-only
 * change shouldn't force retyping the current password, and a
 * password change shouldn't force a name edit. Each section owns
 * its own mutation, error banner, and busy state.
 */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const health = useHealth();
  const isPasswordMode = health.data?.auth === "password";

  if (!me.data) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card-surface w-full max-w-lg overflow-hidden p-0"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-wp-stone px-5 py-3">
          <h3 className="text-base font-semibold text-wp-ink">My profile</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-wp-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[80vh] space-y-6 overflow-y-auto px-5 py-4">
          <ProfileSection user={me.data} />
          {isPasswordMode ? <PasswordSection user={me.data} /> : null}
        </div>

        <div className="flex justify-end border-t border-wp-stone bg-white px-5 py-3">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Profile section (name + color) ----------

/**
 * Palette for the avatar chip. Small, curated set — 12 hues that
 * read well on the white/stone background used across the app.
 * The values are picked from Tailwind's 500/600 range so contrast
 * against the white initials stays readable.
 */
const AVATAR_PALETTE = [
  "#DC2626", "#EA580C", "#D97706", "#CA8A04",
  "#65A30D", "#16A34A", "#0D9488", "#0891B2",
  "#2563EB", "#7C3AED", "#C026D3", "#DB2777",
] as const;

function ProfileSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);

  const dirty = name.trim() !== user.name || color !== user.color;
  const canSave = dirty && name.trim().length > 0;

  const patch = useMutation({
    mutationFn: () =>
      api<User>("/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() !== user.name ? name.trim() : undefined,
          color: color !== user.color ? color : undefined,
        }),
      }),
    onSuccess: () => {
      // Every surface that shows this user's badge or name needs to
      // refresh — the shell nav, roster, project cards, comments,
      // audit trail. Broad invalidation over surgical picks; profile
      // saves are rare.
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <section>
      <h4 className="text-sm font-semibold text-wp-ink">Profile</h4>
      <p className="mt-0.5 text-xs text-wp-slate">
        Your name and avatar color show up on every card you own, comment on, or edit.
      </p>

      <MutationErrorBanner mutation={patch} className="mt-3" />

      <div className="mt-3 flex items-start gap-4">
        <span
          className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white shadow-sm"
          style={{ background: color }}
          aria-label="Avatar preview"
        >
          {initials || "?"}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <label className="block text-xs font-medium text-wp-slate">
            Display name
            <input
              className="input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Your name"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-wp-slate">Avatar color</span>
            <div className="flex flex-wrap gap-2">
              {AVATAR_PALETTE.map((swatch) => {
                const selected = swatch.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={`Pick color ${swatch}`}
                    aria-pressed={selected}
                    onClick={() => setColor(swatch)}
                    className={
                      "h-7 w-7 rounded-full border-2 transition " +
                      (selected
                        ? "border-wp-ink ring-2 ring-wp-ink/20"
                        : "border-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)] hover:border-wp-slate")
                    }
                    style={{ background: swatch }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-primary"
          disabled={!canSave || patch.isPending}
          onClick={() => patch.mutate()}
        >
          {patch.isPending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </section>
  );
}

// ---------- Password section ----------

function PasswordSection({ user }: { user: User }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api<User>("/users/me/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: current,
          new_password: next,
        }),
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setSuccessMsg(
        "Password changed. Other browsers and devices have been signed out; you'll stay signed in here.",
      );
    },
  });

  const mismatched = confirm.length > 0 && next !== confirm;
  const strong = passwordIsValid(next, user.email);
  const canSubmit =
    current.length > 0 &&
    next.length > 0 &&
    strong &&
    !mismatched &&
    next !== current &&
    !change.isPending;

  return (
    <section className="border-t border-wp-stone pt-5">
      <h4 className="text-sm font-semibold text-wp-ink">Change password</h4>
      <p className="mt-0.5 text-xs text-wp-slate">
        You'll stay signed in on this device. Other browsers and phones will be signed out.
      </p>

      <MutationErrorBanner mutation={change} className="mt-3" />
      {successMsg ? (
        <div
          className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
          role="status"
        >
          {successMsg}
        </div>
      ) : null}

      <div className="mt-3 space-y-3">
        <label className="block text-xs font-medium text-wp-slate">
          Current password
          <input
            type="password"
            className="input mt-1 font-mono"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setSuccessMsg(null);
            }}
            autoComplete="current-password"
            placeholder="Enter your current password"
          />
        </label>
        <div>
          <span className="mb-1 block text-xs font-medium text-wp-slate">New password</span>
          <PasswordField
            value={next}
            onChange={(v) => {
              setNext(v);
              setSuccessMsg(null);
            }}
            email={user.email}
            placeholder="Type a new password or generate one"
          />
        </div>
        <label className="block text-xs font-medium text-wp-slate">
          Confirm new password
          <input
            type="password"
            className="input mt-1 font-mono"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setSuccessMsg(null);
            }}
            autoComplete="new-password"
            placeholder="Re-enter the new password"
          />
          {mismatched ? (
            <span className="mt-1 block text-[11px] text-red-600">Passwords don't match.</span>
          ) : null}
          {!mismatched && next.length > 0 && confirm.length > 0 && next === current ? (
            <span className="mt-1 block text-[11px] text-amber-700">
              New password must be different from your current password.
            </span>
          ) : null}
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-primary"
          disabled={!canSubmit}
          onClick={() => change.mutate()}
        >
          {change.isPending ? "Changing…" : "Change password"}
        </button>
      </div>
    </section>
  );
}
