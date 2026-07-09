import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { ancestors, indexById } from "../lib/hierarchy";
import type { Project } from "../lib/types";

/**
 * Single-select picker for choosing a project — used when picking a
 * parent for a subtask. Shows a searchable list of eligible candidates
 * with their type badge and the parent chain (so two items with the
 * same title are still distinguishable). Any project can serve as a
 * parent; the picker's caller passes `excludeIds` to exclude the item
 * itself and its own descendants (avoiding cycles) when editing.
 */
export function ProjectPicker({
  value,
  onChange,
  projects,
  excludeIds,
  disabled,
  placeholder = "— Pick a parent —",
  className,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  /** All candidate projects. Deleted projects should already be filtered out. */
  projects: Project[];
  /** Ids to exclude from the pickable list (self + descendants on edit). */
  excludeIds?: Set<string>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const byId = useMemo(() => indexById(projects), [projects]);

  const eligible = useMemo(() => {
    const skip = excludeIds ?? new Set<string>();
    return projects
      .filter((p) => !p.deleted_at && !skip.has(p.id))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [projects, excludeIds]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return eligible;
    return eligible.filter((p) => p.title.toLowerCase().includes(q));
  }, [eligible, q]);

  const selected = value ? byId.get(value) : undefined;

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setQuery(""); }}>
      <Popover.Trigger
        disabled={disabled}
        className={cn(
          "input relative flex min-h-[2.25rem] w-full items-center gap-2 pr-8 text-left",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
      >
        {selected ? (
          <>
            <TypeChip type={selected.type} />
            <span className="min-w-0 flex-1 truncate text-wp-ink">{selected.title}</span>
            {!disabled ? (
              <span
                role="button"
                aria-label="Clear parent"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(null); }}
                className="rounded p-0.5 text-wp-slate hover:bg-wp-stone hover:text-wp-ink"
              >
                <X size={12} />
              </span>
            ) : null}
          </>
        ) : value ? (
          // The parent id was set but we didn't find it in the project
          // list — could be an admin-only lane hiding the parent from a
          // non-admin viewer. Fall back to a neutral chip.
          <span className="text-wp-slate">Parent not visible</span>
        ) : (
          <span className="text-wp-slate">{placeholder}</span>
        )}
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-wp-slate" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const el = document.getElementById("project-picker-search") as HTMLInputElement | null;
            el?.focus();
          }}
          className="z-50 flex max-h-96 w-96 flex-col overflow-hidden rounded-md border border-wp-stone bg-white shadow-lg"
        >
          <div className="border-b border-wp-stone p-1.5">
            <input
              id="project-picker-search"
              className="input h-8 w-full text-sm"
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-xs text-wp-slate">
                No matching projects.
              </p>
            ) : null}
            {filtered.map((p) => {
              const chain = ancestors(p.id, byId).map((a) => a.title).reverse();
              const isSelected = p.id === value;
              // Wrapping in Popover.Close so the popover closes as soon
              // as a parent is picked — matches the "pick and go" feel
              // the user asked for. `asChild` lets our button keep its
              // styling and handlers.
              return (
                <Popover.Close asChild key={p.id}>
                  <button
                    type="button"
                    onClick={() => onChange(p.id)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col rounded px-2 py-1.5 text-left text-sm outline-none",
                      isSelected ? "bg-wp-red/5 text-wp-ink" : "text-wp-ink hover:bg-wp-stone/40",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <TypeChip type={p.type} />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    </span>
                    {chain.length ? (
                      <span className="mt-0.5 truncate pl-6 text-[11px] text-wp-slate">
                        {chain.join(" › ")}
                      </span>
                    ) : null}
                  </button>
                </Popover.Close>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TypeChip({ type }: { type: "epic" | "subtask" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        type === "epic"
          ? "bg-wp-red/10 text-wp-red"
          : "bg-wp-stone/60 text-wp-slate",
      )}
    >
      {type}
    </span>
  );
}
