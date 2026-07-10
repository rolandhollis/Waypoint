import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMe } from "../lib/queries";
import { cn } from "../lib/cn";
import type { User } from "../lib/types";

/**
 * Navbar dropdown that lets a multi-group user pick which tenant
 * they're operating in. Deliberately hidden entirely when there's
 * only one membership — that user's group is fixed for the session
 * and the extra chrome would just add visual noise.
 *
 * Switching:
 *   1. Optimistic-updates useMe().data.current_group_id so the
 *      badge flips immediately.
 *   2. Fires PATCH /users/me/current-group.
 *   3. On success, calls qc.invalidateQueries() — every scoped
 *      list (projects, swim lanes, teams, KPIs, comments, ...)
 *      refetches automatically because their group filter is
 *      applied server-side.
 */
export function GroupSwitcher() {
  const me = useMe();
  const memberships = me.data?.memberships ?? [];
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const switchGroup = useMutation({
    mutationFn: (groupId: string) =>
      api<User>("/users/me/current-group", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId }),
      }),
    onMutate: (groupId: string) => {
      // Optimistic: flip the badge before the round-trip completes.
      // Roll back in onError if the PATCH is rejected (usually only
      // if the membership was revoked mid-session).
      const previous = qc.getQueryData<User>(["me"]);
      if (previous) {
        qc.setQueryData<User>(["me"], { ...previous, current_group_id: groupId });
      }
      return { previous };
    },
    onError: (_err, _groupId, ctx) => {
      if (ctx?.previous) qc.setQueryData<User>(["me"], ctx.previous);
    },
    onSuccess: async () => {
      // Nuke every scoped cache so nothing from the old tenant
      // survives the switch. `me` is refetched too so memberships +
      // role stay accurate. Invalidate rather than reset so any
      // in-flight optimistic mutations aren't torn down.
      await qc.invalidateQueries();
    },
    onSettled: () => setOpen(false),
  });

  // Close the popover on outside click. Uses `mousedown` (not
  // `click`) so a click starting inside another popover — which
  // might close it on mouseup — doesn't accidentally re-open this
  // one on the second event.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (memberships.length < 2) return null;

  const current = memberships.find((m) => m.group_id === me.data?.current_group_id);
  const displayColor = current?.color ?? "#64748B";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-wp-stone bg-white px-2.5 py-1.5 text-sm font-medium text-wp-ink hover:bg-wp-stone/30"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: displayColor }}
          aria-hidden
        />
        <span className="max-w-[140px] truncate">{current?.name ?? "Select group"}</span>
        <svg
          viewBox="0 0 12 12"
          className={cn("h-3 w-3 text-wp-slate transition", open && "rotate-180")}
          aria-hidden
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-64 rounded-md border border-wp-stone bg-white shadow-lg"
        >
          <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-wp-slate">
            Switch workspace
          </div>
          <ul className="max-h-[280px] overflow-y-auto pb-1">
            {memberships.map((m) => {
              const isCurrent = m.group_id === me.data?.current_group_id;
              return (
                <li key={m.group_id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isCurrent) {
                        setOpen(false);
                        return;
                      }
                      switchGroup.mutate(m.group_id);
                    }}
                    disabled={switchGroup.isPending}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-wp-stone/40",
                      isCurrent && "bg-wp-stone/30",
                    )}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: m.color ?? "#64748B" }}
                        aria-hidden
                      />
                      <span className="truncate text-wp-ink">{m.name}</span>
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-wp-slate">
                      {m.role}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
