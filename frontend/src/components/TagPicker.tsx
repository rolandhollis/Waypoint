import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../lib/cn";

/**
 * Free-form multi-select for project tags. Unlike TeamMultiSelect, tags
 * are plain strings that live in project rows (no separate table), so
 * the "options" list is just the union of everything already used
 * across projects. Users can:
 *   - pick from the existing list one at a time
 *   - type to filter that list
 *   - create a brand-new tag inline when no existing tag matches
 *
 * Selected tags render as removable chips on the trigger. Tag names
 * are normalized to lowercase / trimmed so "UI", "ui ", and " ui"
 * don't create three separate tags for the same concept.
 */
export function TagPicker({
  value,
  onChange,
  suggestions,
  disabled,
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Union of tags already used across projects — used to build the
   *  suggestion list. Order-insensitive; the picker sorts alphabetically. */
  suggestions: string[];
  disabled?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState("");

  const selectedSet = useMemo(() => new Set(value.map(normalize)), [value]);

  // Suggestion list = union of `suggestions` and any already-selected
  // tag not present in suggestions (rare, but possible if a project
  // still carries a tag no other project uses). De-duped, sorted.
  const options = useMemo(() => {
    const set = new Set<string>();
    for (const t of suggestions) set.add(normalize(t));
    for (const t of value) set.add(normalize(t));
    return Array.from(set).sort();
  }, [suggestions, value]);

  const normalizedQuery = normalize(query);
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((t) => t.includes(normalizedQuery));
  }, [options, normalizedQuery]);

  const canCreate =
    normalizedQuery.length > 0 && !options.includes(normalizedQuery);

  function toggle(tag: string) {
    const n = normalize(tag);
    if (!n) return;
    if (selectedSet.has(n)) onChange(value.filter((v) => normalize(v) !== n));
    else onChange([...value, n]);
  }

  function remove(tag: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onChange(value.filter((v) => normalize(v) !== normalize(tag)));
  }

  function commitNew() {
    if (!canCreate) return;
    onChange([...value, normalizedQuery]);
    setQuery("");
  }

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setQuery(""); }}>
      <Popover.Trigger
        disabled={disabled}
        className={cn(
          "input relative flex min-h-[2.25rem] w-full flex-wrap items-center gap-1 pr-8 text-left",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
      >
        {value.length ? (
          value.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-wp-stone bg-wp-stone/30 px-1.5 py-0.5 text-xs text-wp-ink"
            >
              #{t}
              {!disabled ? (
                <span
                  role="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={(e) => remove(t, e)}
                  className="ml-0.5 rounded p-0.5 text-wp-slate hover:bg-wp-stone hover:text-wp-ink"
                >
                  <X size={10} />
                </span>
              ) : null}
            </span>
          ))
        ) : (
          <span className="text-wp-slate">— No tags —</span>
        )}
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-wp-slate" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          // Trap focus in the search input so typing is captured
          // immediately when the popover opens.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const input = document.getElementById("tag-picker-search") as HTMLInputElement | null;
            input?.focus();
          }}
          className="z-50 flex max-h-80 w-64 flex-col overflow-hidden rounded-md border border-wp-stone bg-white shadow-lg"
        >
          <div className="border-b border-wp-stone p-1.5">
            <input
              id="tag-picker-search"
              className="input h-8 w-full text-sm"
              placeholder="Search or add a tag…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (canCreate) {
                    commitNew();
                  } else if (filteredOptions.length === 1) {
                    toggle(filteredOptions[0]!);
                    setQuery("");
                  }
                }
              }}
            />
          </div>

          <div className="flex-1 overflow-y-auto p-1">
            {filteredOptions.length === 0 && !canCreate ? (
              <p className="px-2 py-3 text-xs text-wp-slate">No tags yet — type a new one to create it.</p>
            ) : null}

            {filteredOptions.map((t) => {
              const checked = selectedSet.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggle(t)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-wp-ink outline-none hover:bg-wp-stone/40"
                >
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 items-center justify-center rounded border",
                      checked
                        ? "border-wp-red bg-wp-red text-white"
                        : "border-wp-stone text-transparent",
                    )}
                  >
                    <Check size={12} />
                  </span>
                  <span className="flex-1">#{t}</span>
                </button>
              );
            })}

            {canCreate ? (
              <button
                type="button"
                onClick={commitNew}
                className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded border-t border-wp-stone/60 px-2 py-1.5 text-left text-sm text-wp-red outline-none hover:bg-wp-red/5"
              >
                <Plus size={14} />
                <span className="flex-1">
                  Create <span className="font-semibold">#{normalizedQuery}</span>
                </span>
              </button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Normalize tag text — lowercased, trimmed. Keeps the tag pool tidy. */
function normalize(s: string): string {
  return s.trim().toLowerCase();
}
