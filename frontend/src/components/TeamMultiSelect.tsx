import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, X } from "lucide-react";
import { useMemo } from "react";
import type { Team } from "../lib/types";
import { cn } from "../lib/cn";

/**
 * Multi-select for team memberships. Trigger shows the picked teams as
 * color-tagged chips; the popover has a checkbox list. Users can also
 * remove a team by clicking the × on its chip.
 */
export function TeamMultiSelect({
  value,
  onChange,
  teams,
  disabled,
  emptyText = "— No teams —",
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  teams: Team[];
  disabled?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const selectedTeams = useMemo(
    () => teams.filter((t) => value.includes(t.id)),
    [teams, value],
  );

  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  }

  function remove(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onChange(value.filter((v) => v !== id));
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={disabled}
        className={cn(
          "input flex min-h-[2.25rem] w-full flex-wrap items-center gap-1 pr-8 text-left",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
      >
        {selectedTeams.length ? (
          selectedTeams.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
              style={{ borderColor: t.color, background: `${t.color}18`, color: t.color }}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: t.color }}
              />
              <span className="text-wp-ink">{t.name}</span>
              {!disabled ? (
                <span
                  role="button"
                  aria-label={`Remove ${t.name}`}
                  onClick={(e) => remove(t.id, e)}
                  className="ml-0.5 rounded p-0.5 text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink"
                >
                  <X size={10} />
                </span>
              ) : null}
            </span>
          ))
        ) : (
          <span className="text-wp-slate">{emptyText}</span>
        )}
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-wp-slate" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-72 w-64 overflow-y-auto rounded-md border border-wp-stone bg-white p-1 shadow-lg"
        >
          {teams.length === 0 ? (
            <p className="px-2 py-3 text-xs text-wp-slate">No teams defined yet.</p>
          ) : (
            teams.map((t) => {
              const checked = value.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggle(t.id)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-wp-ink outline-none hover:bg-wp-stone/40"
                >
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 items-center justify-center rounded border",
                      checked ? "text-white" : "text-transparent",
                    )}
                    style={{
                      borderColor: t.color,
                      background: checked ? t.color : "transparent",
                    }}
                  >
                    <Check size={12} />
                  </span>
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: t.color }} aria-hidden />
                  <span className="flex-1">{t.name}</span>
                </button>
              );
            })
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
