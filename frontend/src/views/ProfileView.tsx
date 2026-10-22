import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Copy } from "lucide-react";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { PasswordField } from "../components/PasswordField";
import { api } from "../lib/api";
import { passwordIsValid } from "../lib/password";
import { useHealth, useMe } from "../lib/queries";
import type { User } from "../lib/types";

type ApiToken = {
  id: string;
  group_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
};

type CreatedApiToken = ApiToken & { token: string };

/**
 * Self-serve profile page. Opened from the avatar popover's Profile
 * link. Sections stay independently submittable so a name-only change
 * doesn't force a password retype, etc.
 */
export function ProfileView() {
  const me = useMe();
  const health = useHealth();
  const isPasswordMode = health.data?.auth === "password";

  if (!me.data) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <ProfilePageHeader />
        <div className="p-6 text-sm text-wp-slate">Loading profile…</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ProfilePageHeader />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          <div className="card-surface p-5">
            <ProfileSection user={me.data} />
          </div>
          {isPasswordMode ? (
            <div className="card-surface p-5">
              <PasswordSection user={me.data} />
            </div>
          ) : null}
          <div className="card-surface p-5">
            <ApiTokensSection user={me.data} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfilePageHeader() {
  return (
    <header className="shrink-0 border-b border-wp-stone bg-white px-5 py-3">
      <h1 className="text-xl font-semibold text-wp-ink">My profile</h1>
      <p className="mt-1 text-sm text-wp-slate">
        Display name, password, and Claude / API tokens for this account.
      </p>
    </header>
  );
}

const AVATAR_PALETTE = [
  "#DC2626", "#EA580C", "#D97706", "#CA8A04",
  "#65A30D", "#16A34A", "#0D9488", "#0891B2",
  "#2563EB", "#7C3AED", "#C026D3", "#DB2777",
] as const;

function ProfileSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [remindersEnabled, setRemindersEnabled] = useState(user.email_reminders_enabled);

  const dirty =
    name.trim() !== user.name ||
    color !== user.color ||
    remindersEnabled !== user.email_reminders_enabled;
  const canSave = dirty && name.trim().length > 0;

  const patch = useMutation({
    mutationFn: () =>
      api<User>("/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() !== user.name ? name.trim() : undefined,
          color: color !== user.color ? color : undefined,
          email_reminders_enabled:
            remindersEnabled !== user.email_reminders_enabled ? remindersEnabled : undefined,
        }),
      }),
    onSuccess: () => {
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
      <h2 className="text-sm font-semibold text-wp-ink">Profile</h2>
      <p className="mt-0.5 text-xs text-wp-slate">
        Your name and avatar color show up on every card you own, comment on, or edit.
      </p>

      <MutationErrorBanner mutation={patch} className="mt-3" />

      <div className="mt-4 flex items-start gap-4">
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
          <label className="flex cursor-pointer items-start gap-2 text-sm text-wp-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-wp-red"
              checked={remindersEnabled}
              onChange={(e) => setRemindersEnabled(e.target.checked)}
            />
            <span>
              Email me a Thursday-morning reminder when I have status updates due
              <span className="mt-0.5 block text-[11px] text-wp-slate/80">
                One email per week, only when you actually owe an update.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="mt-5 flex justify-end">
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
    <section>
      <h2 className="text-sm font-semibold text-wp-ink">Change password</h2>
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

      <div className="mt-4 space-y-3">
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

      <div className="mt-5 flex justify-end">
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

function ApiTokensSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Claude connector");
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api<ApiToken[]>("/api-tokens"),
  });

  const create = useMutation({
    mutationFn: () =>
      api<CreatedApiToken>("/api-tokens", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || "Claude connector",
          group_id: user.current_group_id ?? undefined,
        }),
      }),
    onSuccess: (row) => {
      setCreated(row);
      setCopied(false);
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api-tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";
  const groupLabel =
    user.memberships?.find((m) => m.group_id === user.current_group_id)?.name ??
    "current workspace";

  return (
    <section>
      <h2 className="text-sm font-semibold text-wp-ink">Claude / API access</h2>
      <p className="mt-0.5 text-xs text-wp-slate">
        Personal tokens let Claude (or scripts) read this workspace via the MCP
        connector at <code className="text-[11px]">{mcpUrl}</code>. Tokens are
        pinned to <strong>{groupLabel}</strong> and are read-only.
      </p>

      <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-wp-slate">
        <li>Create a token below and copy it once.</li>
        <li>
          In Claude: Settings → Connectors → Add custom connector → URL{" "}
          <code className="text-[11px]">{mcpUrl}</code>
        </li>
        <li>
          Add header <code className="text-[11px]">Authorization</code> ={" "}
          <code className="text-[11px]">Bearer wp_…</code> (or{" "}
          <code className="text-[11px]">X-Api-Key</code>).
        </li>
      </ol>

      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={revoke} className="mt-3" />

      {created ? (
        <div
          className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950"
          role="status"
        >
          <p className="font-medium">Copy this token now — it won’t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white/80 px-2 py-1 font-mono text-[11px]">
              {created.token}
            </code>
            <button
              type="button"
              className="btn-secondary inline-flex shrink-0 items-center gap-1 px-2 py-1 text-xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.token);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              <Copy size={12} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="block min-w-[12rem] flex-1 text-xs font-medium text-wp-slate">
          Token name
          <input
            className="input mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="Claude connector"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={!user.current_group_id || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create token"}
        </button>
      </div>

      <ul className="mt-4 divide-y divide-wp-stone rounded-md border border-wp-stone">
        {(tokens.data ?? []).length === 0 ? (
          <li className="px-3 py-2 text-xs text-wp-slate">No active tokens.</li>
        ) : (
          (tokens.data ?? []).map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-wp-ink">{t.name}</div>
                <div className="text-wp-slate">
                  {t.token_prefix}… · created{" "}
                  {new Date(t.created_at).toLocaleDateString()}
                  {t.last_used_at
                    ? ` · last used ${new Date(t.last_used_at).toLocaleDateString()}`
                    : ""}
                </div>
              </div>
              <button
                type="button"
                className="btn-secondary shrink-0 px-2 py-1 text-xs text-red-700"
                disabled={revoke.isPending}
                onClick={() => {
                  if (window.confirm(`Revoke token “${t.name}”?`)) {
                    revoke.mutate(t.id);
                  }
                }}
              >
                Revoke
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
