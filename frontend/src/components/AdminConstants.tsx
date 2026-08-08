import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import {
  DEFAULT_TAB_LABELS,
  TAB_LABEL_KEYS,
  tabLabelOverridesToDraft,
  type TabLabelKey,
  type TabLabels,
} from "../lib/navTabs";
import { DEFAULT_APP_NAME, DEFAULT_EMAIL_TITLE, useCurrentGroup, useGroupConstants, useMe } from "../lib/queries";
import type { AppConstants } from "../lib/types";
import { useAppDialog } from "./AppDialogProvider";
import { MutationErrorBanner } from "./MutationErrorBanner";

/**
 * Admin panel for per-tenant runtime "constants" — values that
 * used to be hardcoded in the frontend (starting with the app name
 * shown in the top navbar) and are now editable per group without
 * a redeploy.
 *
 * Scope:
 *   * Reads/writes `/api/groups/:currentGroupId/constants`.
 *   * Admin-only for the caller's current group — the
 *     AdminSettingsView tab-nav already gates on `useIsAdmin()`, so
 *     this component doesn't re-check role; a viewer landing here
 *     would have been blocked at the outer view.
 *   * Only surfaces recognized keys (`app_name`, `email_title`, …).
 *     When new constants ship, add a new field-row here.
 *
 * Save UX mirrors the compact card-form idiom used by
 * `TshirtSizesAdmin` and `KpisAdmin`: explicit Save button per
 * field (rather than blur-to-commit) because a rebrand is a
 * higher-consequence write than relabeling a size — worth an
 * intentional click.
 */
export function AdminConstants() {
  const me = useMe();
  const currentGroup = useCurrentGroup();
  const groupId = me.data?.current_group_id ?? null;

  if (!groupId) {
    return (
      <section className="card-surface p-4">
        <h2 className="text-base font-semibold text-wp-ink">Constants</h2>
        <p className="mt-2 text-xs text-wp-slate">
          No active group selected — pick one from the workspace switcher
          in the top navbar to edit its constants.
        </p>
      </section>
    );
  }

  return (
    <section className="card-surface p-4">
      <div>
        <h2 className="text-base font-semibold text-wp-ink">Constants</h2>
        <p className="mt-1 text-xs text-wp-slate">
          These values control tenant-visible strings for{" "}
          <span className="font-medium text-wp-ink">
            {currentGroup?.name ?? "this workspace"}
          </span>
          . Changes apply immediately for everyone in this group. Nothing
          here is deployed with the app — it's stored per-workspace so each
          group can rebrand independently.
        </p>
      </div>

      <div className="mt-4 space-y-6">
        <AppNameField groupId={groupId} />
        <EmailTitleField groupId={groupId} />
        <TabLabelsField groupId={groupId} />
        <PredictionGameRegenerateField groupId={groupId} />
      </div>
    </section>
  );
}

/**
 * Single-field editor for `constants.app_name`. Kept as its own
 * component so future constant fields can each carry their own
 * dirty/save state without sharing a giant form model.
 */
function AppNameField({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const { confirm } = useAppDialog();
  const constantsQ = useGroupConstants(groupId);
  const persisted = (constantsQ.data?.app_name ?? "") as string;

  const [draft, setDraft] = useState<string>(persisted);
  // Keep the draft in sync with whatever the server most recently
  // returned when the user isn't actively editing — covers the
  // first-render hydration and any invalidation from another tab.
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const patch = useMutation({
    mutationFn: (body: Pick<AppConstants, "app_name">) =>
      api<AppConstants>(`/groups/${groupId}/constants`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      // Invalidate both keys the app reads from:
      //   * ["groups"]           — feeds useCurrentGroup → useAppName
      //                            (drives the navbar / document title)
      //   * ["groupConstants"]   — feeds this form on next render
      // The order doesn't matter; both refetches run in parallel.
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["groupConstants", groupId] });
    },
  });

  const trimmed = draft.trim();
  const isDirty = trimmed !== persisted.trim();
  const canSave = isDirty && trimmed.length > 0 && trimmed.length <= 60 && !patch.isPending;
  const isCleared = persisted.trim().length === 0;

  return (
    <div className="space-y-2">
      <MutationErrorBanner mutation={patch} />
      <label className="block text-xs font-medium text-wp-slate">
        App name
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[16rem] flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={DEFAULT_APP_NAME}
            maxLength={60}
            disabled={constantsQ.isLoading || patch.isPending}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!canSave}
            onClick={() => patch.mutate({ app_name: trimmed })}
          >
            {patch.isPending && patch.variables?.app_name !== null ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5"
            disabled={isCleared || patch.isPending}
            title={
              isCleared
                ? `Already using the built-in default ("${DEFAULT_APP_NAME}")`
                : `Clear override; UI falls back to "${DEFAULT_APP_NAME}"`
            }
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Reset app name?",
                  description: `Reset the app name to the built-in default ("${DEFAULT_APP_NAME}")?`,
                }))
              ) return;
              patch.mutate({ app_name: null });
            }}
          >
            <RotateCcw size={13} />
            {patch.isPending && patch.variables?.app_name === null
              ? "Resetting…"
              : "Reset to default"}
          </button>
        </div>
      </label>
      <p className="text-[11px] text-wp-slate/80">
        Shown in the top navbar (and the browser tab title) for everyone in
        this group. Max 60 characters. Leave blank and reset to fall back to
        the platform default (
        <span className="font-mono">{DEFAULT_APP_NAME}</span>).
      </p>
    </div>
  );
}

function EmailTitleField({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const { confirm } = useAppDialog();
  const constantsQ = useGroupConstants(groupId);
  const persisted = (constantsQ.data?.email_title ?? "") as string;

  const [draft, setDraft] = useState<string>(persisted);
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const patch = useMutation({
    mutationFn: (body: Pick<AppConstants, "email_title">) =>
      api<AppConstants>(`/groups/${groupId}/constants`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["groupConstants", groupId] });
    },
  });

  const trimmed = draft.trim();
  const isDirty = trimmed !== persisted.trim();
  const canSave = isDirty && trimmed.length > 0 && trimmed.length <= 80 && !patch.isPending;
  const isCleared = persisted.trim().length === 0;

  return (
    <div className="space-y-2">
      <MutationErrorBanner mutation={patch} />
      <label className="block text-xs font-medium text-wp-slate">
        Email title
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[16rem] flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={DEFAULT_EMAIL_TITLE}
            maxLength={80}
            disabled={constantsQ.isLoading || patch.isPending}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!canSave}
            onClick={() => patch.mutate({ email_title: trimmed })}
          >
            {patch.isPending && patch.variables?.email_title !== null ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5"
            disabled={isCleared || patch.isPending}
            title={
              isCleared
                ? `Already using the platform default ("${DEFAULT_EMAIL_TITLE}")`
                : `Clear override; emails use "${DEFAULT_EMAIL_TITLE}"`
            }
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Reset email title?",
                  description: `Reset the email sender name to the platform default ("${DEFAULT_EMAIL_TITLE}")?`,
                }))
              )
                return;
              patch.mutate({ email_title: null });
            }}
          >
            <RotateCcw size={13} />
            {patch.isPending && patch.variables?.email_title === null
              ? "Resetting…"
              : "Reset to default"}
          </button>
        </div>
      </label>
      <p className="text-[11px] text-wp-slate/80">
        Sender name shown in the inbox for digest and reminder emails from this
        workspace. Max 80 characters. Reset to use the platform default (
        <span className="font-mono">{DEFAULT_EMAIL_TITLE}</span>).
      </p>
    </div>
  );
}

function TabLabelsField({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const { confirm } = useAppDialog();
  const constantsQ = useGroupConstants(groupId);
  const persistedOverrides = constantsQ.data?.tab_labels ?? {};

  const [draft, setDraft] = useState<Record<TabLabelKey, string>>(() =>
    tabLabelOverridesToDraft(persistedOverrides),
  );

  useEffect(() => {
    setDraft(tabLabelOverridesToDraft(persistedOverrides));
  }, [constantsQ.data?.tab_labels]);

  const patch = useMutation({
    mutationFn: (body: Pick<AppConstants, "tab_labels">) =>
      api<AppConstants>(`/groups/${groupId}/constants`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["groupConstants", groupId] });
    },
  });

  const persistedDraft = tabLabelOverridesToDraft(persistedOverrides);
  const isDirty = TAB_LABEL_KEYS.some(
    (key) => draft[key].trim() !== persistedDraft[key].trim(),
  );

  const hasOverrides = TAB_LABEL_KEYS.some((key) => {
    const v = persistedOverrides[key];
    return typeof v === "string" && v.trim().length > 0;
  });

  function buildPatch(): TabLabels {
    const out: TabLabels = {};
    for (const key of TAB_LABEL_KEYS) {
      const d = draft[key].trim();
      const p = persistedDraft[key].trim();
      if (d !== p) {
        out[key] = d.length > 0 ? d : null;
      }
    }
    return out;
  }

  function canSaveKey(key: TabLabelKey): boolean {
    const trimmed = draft[key].trim();
    return trimmed.length === 0 || (trimmed.length >= 1 && trimmed.length <= 40);
  }

  const canSave =
    isDirty &&
    TAB_LABEL_KEYS.every((key) => canSaveKey(key)) &&
    !patch.isPending;

  return (
    <div className="space-y-3">
      <MutationErrorBanner mutation={patch} />
      <div>
        <h3 className="text-xs font-medium text-wp-slate">Navigation tab names</h3>
        <p className="mt-1 text-[11px] text-wp-slate/80">
          Labels shown in the top navigation bar for this workspace. Leave a field
          blank and save to restore the built-in default for that tab. Max 40
          characters per tab.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TAB_LABEL_KEYS.map((key) => (
          <label key={key} className="block text-xs font-medium text-wp-slate">
            {DEFAULT_TAB_LABELS[key]}
            <input
              className="input mt-1 w-full"
              value={draft[key]}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, [key]: e.target.value }))
              }
              placeholder={DEFAULT_TAB_LABELS[key]}
              maxLength={40}
              disabled={constantsQ.isLoading || patch.isPending}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!canSave}
          onClick={() => patch.mutate({ tab_labels: buildPatch() })}
        >
          {patch.isPending && patch.variables?.tab_labels !== null ? "Saving…" : "Save tab names"}
        </button>
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={!hasOverrides || patch.isPending}
          title={
            hasOverrides
              ? "Clear all custom tab names"
              : "Already using built-in defaults"
          }
          onClick={async () => {
            if (
              !(await confirm({
                title: "Reset all tab names?",
                description: "Restore every navigation tab to its built-in default label?",
              }))
            ) {
              return;
            }
            patch.mutate({ tab_labels: null });
          }}
        >
          <RotateCcw size={13} />
          {patch.isPending && patch.variables?.tab_labels === null
            ? "Resetting…"
            : "Reset all to defaults"}
        </button>
      </div>
    </div>
  );
}

function PredictionGameRegenerateField({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const constantsQ = useGroupConstants(groupId);
  const enabled = constantsQ.data?.prediction_game_regenerate_enabled === true;

  const patch = useMutation({
    mutationFn: (prediction_game_regenerate_enabled: boolean) =>
      api<AppConstants>(`/groups/${groupId}/constants`, {
        method: "PATCH",
        body: JSON.stringify({ prediction_game_regenerate_enabled }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["groupConstants", groupId] });
    },
  });

  return (
    <div className="space-y-2 rounded-md border border-wp-stone/80 bg-wp-stone/5 p-4">
      <div>
        <h3 className="text-sm font-semibold text-wp-ink">Prediction game</h3>
        <p className="mt-1 text-xs text-wp-slate">
          Controls whether admins can manually generate or regenerate the daily
          yes/no question on the Game tab. The morning cron job still runs
          regardless.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm text-wp-ink">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          disabled={patch.isPending || constantsQ.isLoading}
          onChange={(e) => patch.mutate(e.target.checked)}
        />
        <span>
          Allow admins to regenerate the daily question
          {patch.isPending ? <span className="text-wp-slate"> (saving…)</span> : null}
        </span>
      </label>
      <MutationErrorBanner mutation={patch} />
    </div>
  );
}
