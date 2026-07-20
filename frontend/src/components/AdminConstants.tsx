import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { DEFAULT_APP_NAME, useCurrentGroup, useGroupConstants, useMe } from "../lib/queries";
import type { AppConstants } from "../lib/types";
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
 *   * Only surfaces recognized keys. Today that's just `app_name`;
 *     when new constants ship, add a new field-row here.
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

      <div className="mt-4">
        <AppNameField groupId={groupId} />
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
            onClick={() => {
              if (
                !confirm(
                  `Reset the app name to the built-in default ("${DEFAULT_APP_NAME}")?`,
                )
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
