import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MultiSelect } from "../components/MultiSelect";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { api } from "../lib/api";
import { pillTextColor, tint } from "../lib/colors";
import {
  useIsAdmin,
  useKpis,
  useProductManagers,
  useSystems,
  useTeams,
} from "../lib/queries";
import type { ProductManager, ProductManagerArea } from "../lib/types";

/**
 * Plan → Team: one card per product manager. Each assigned product
 * area stretches full-width with title + description; KPIs and
 * systems for that area sit in two columns underneath.
 */
export function TeamView() {
  const isAdmin = useIsAdmin();
  const pms = useProductManagers();
  const teams = useTeams();
  const kpis = useKpis();
  const systems = useSystems();

  if (pms.isLoading || teams.isLoading || kpis.isLoading || systems.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading team…</div>;
  }

  const list = pms.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader tabKey="team" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-6">
          {list.length === 0 ? (
            <div className="card-surface p-6 text-sm text-wp-slate">
              No product managers yet.
              {isAdmin ? (
                <>
                  {" "}
                  Mark people under{" "}
                  <Link to="/admin?tab=users" className="font-medium text-wp-ink underline">
                    Admin → Users
                  </Link>
                  , then assign product areas here. KPIs and systems attach to each area.
                </>
              ) : (
                <> Ask an admin to designate product managers.</>
              )}
            </div>
          ) : (
            list.map((pm) => (
              <PmCard
                key={pm.user.id}
                pm={pm}
                isAdmin={isAdmin}
                teamOptions={(teams.data ?? []).map((t) => ({ id: t.id, label: t.name }))}
                kpiOptions={(kpis.data ?? []).map((k) => ({ id: k.id, label: k.name }))}
                systemOptions={(systems.data ?? []).map((s) => ({
                  id: s.id,
                  label: s.name,
                  team_id: s.team_id,
                }))}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

type AreaDraft = {
  team_id: string;
  kpi_ids: string[];
  system_ids: string[];
};

function PmCard(props: {
  pm: ProductManager;
  isAdmin: boolean;
  teamOptions: Array<{ id: string; label: string }>;
  kpiOptions: Array<{ id: string; label: string }>;
  systemOptions: Array<{ id: string; label: string; team_id: string | null }>;
}) {
  const { pm, isAdmin, teamOptions, kpiOptions, systemOptions } = props;
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [teamIds, setTeamIds] = useState(pm.areas.map((a) => a.id));
  const [areaDrafts, setAreaDrafts] = useState<AreaDraft[]>(() =>
    pm.areas.map((a) => ({
      team_id: a.id,
      kpi_ids: a.kpis.map((k) => k.id),
      system_ids: a.systems.map((s) => s.id),
    })),
  );

  useEffect(() => {
    if (editing) return;
    setTeamIds(pm.areas.map((a) => a.id));
    setAreaDrafts(
      pm.areas.map((a) => ({
        team_id: a.id,
        kpi_ids: a.kpis.map((k) => k.id),
        system_ids: a.systems.map((s) => s.id),
      })),
    );
  }, [pm, editing]);

  const save = useMutation({
    mutationFn: () =>
      api<ProductManager>(`/product-managers/${pm.user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          team_ids: teamIds,
          areas: areaDrafts.filter((a) => teamIds.includes(a.team_id)),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["productManagers"] });
      qc.invalidateQueries({ queryKey: ["systems"] });
      setEditing(false);
    },
  });

  function startEdit() {
    setTeamIds(pm.areas.map((a) => a.id));
    setAreaDrafts(
      pm.areas.map((a) => ({
        team_id: a.id,
        kpi_ids: a.kpis.map((k) => k.id),
        system_ids: a.systems.map((s) => s.id),
      })),
    );
    setEditing(true);
  }

  function onTeamIdsChange(next: string[]) {
    setTeamIds(next);
    setAreaDrafts((prev) => {
      const byId = new Map(prev.map((a) => [a.team_id, a]));
      return next.map(
        (id) =>
          byId.get(id) ?? {
            team_id: id,
            kpi_ids: [],
            system_ids: [],
          },
      );
    });
  }

  function patchArea(teamId: string, patch: Partial<Omit<AreaDraft, "team_id">>) {
    setAreaDrafts((prev) =>
      prev.map((a) => (a.team_id === teamId ? { ...a, ...patch } : a)),
    );
  }

  const initials = pm.user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <section className="card-surface overflow-hidden">
      <header className="flex items-start gap-3 border-b border-wp-stone/60 px-4 py-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ background: pm.user.color }}
        >
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-wp-ink">{pm.user.name}</h2>
          <p className="text-xs text-wp-slate">{pm.user.email}</p>
        </div>
        {isAdmin ? (
          editing ? (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setEditing(false)}
                disabled={save.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={() => save.mutate()}
                disabled={save.isPending}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          ) : (
            <button type="button" className="btn-secondary text-xs" onClick={startEdit}>
              Edit assignments
            </button>
          )
        ) : null}
      </header>

      <MutationErrorBanner mutation={save} className="mx-4 mt-3" />

      {editing ? (
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-1 text-xs font-medium text-wp-slate">Product areas</div>
            <MultiSelect
              label="Areas"
              options={teamOptions}
              value={teamIds}
              onChange={onTeamIdsChange}
              emptyMessage="No teams in Admin → Teams"
            />
          </div>
          {teamIds.length === 0 ? (
            <p className="text-xs text-wp-slate">Select one or more product areas above.</p>
          ) : (
            teamIds.map((teamId) => {
              const label = teamOptions.find((t) => t.id === teamId)?.label ?? "Area";
              const draft = areaDrafts.find((a) => a.team_id === teamId) ?? {
                team_id: teamId,
                kpi_ids: [],
                system_ids: [],
              };
              const systemOpts = systemOptions.map((s) => ({
                id: s.id,
                label:
                  s.team_id && s.team_id !== teamId && !draft.system_ids.includes(s.id)
                    ? `${s.label} (reassign)`
                    : s.label,
              }));
              return (
                <div
                  key={teamId}
                  className="rounded-md border border-wp-stone bg-wp-stone/10 p-3"
                >
                  <div className="text-sm font-semibold text-wp-ink">{label}</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs font-medium text-wp-slate">KPIs</div>
                      <MultiSelect
                        label="KPIs"
                        options={kpiOptions}
                        value={draft.kpi_ids}
                        onChange={(kpi_ids) => patchArea(teamId, { kpi_ids })}
                        emptyMessage="No KPIs in Admin → KPIs"
                      />
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-medium text-wp-slate">
                        Systems{" "}
                        <span className="font-normal text-wp-slate/70">(one area each)</span>
                      </div>
                      <MultiSelect
                        label="Systems"
                        options={systemOpts}
                        value={draft.system_ids}
                        onChange={(system_ids) => patchArea(teamId, { system_ids })}
                        emptyMessage="No systems in Admin → Systems"
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : pm.areas.length === 0 ? (
        <p className="px-4 py-6 text-xs text-wp-slate">No product areas assigned.</p>
      ) : (
        <div className="divide-y divide-wp-stone">
          {pm.areas.map((area) => (
            <AreaBlock key={area.id} area={area} />
          ))}
        </div>
      )}
    </section>
  );
}

function AreaBlock({ area }: { area: ProductManagerArea }) {
  return (
    <div className="px-4 py-4">
      <div
        className="rounded-md border-l-4 px-3 py-2"
        style={{ borderLeftColor: area.color, background: `${area.color}12` }}
      >
        <h3 className="text-sm font-semibold text-wp-ink">{area.name}</h3>
        {area.description?.trim() ? (
          <p className="mt-0.5 text-xs text-wp-slate whitespace-pre-wrap">{area.description}</p>
        ) : (
          <p className="mt-0.5 text-xs italic text-wp-slate/70">No description yet.</p>
        )}
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <ChipColumn title="KPIs" empty="No KPIs for this area." items={area.kpis} />
        <ChipColumn title="Systems" empty="No systems for this area." items={area.systems} />
      </div>
    </div>
  );
}

function ChipColumn(props: {
  title: string;
  empty: string;
  items: Array<{ id: string; name: string; color: string }>;
}) {
  const { title, empty, items } = props;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-wp-slate">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-wp-slate">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-full px-2.5 py-0.5 text-xs font-medium"
              style={{
                background: tint(item.color, 0.18),
                color: pillTextColor(item.color),
              }}
            >
              {item.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
