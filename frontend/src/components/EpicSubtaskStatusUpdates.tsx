import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import { childrenByParent, descendants } from "../lib/hierarchy";
import { cn } from "../lib/cn";
import { useProjects } from "../lib/queries";
import type { Project, SubtaskStatusUpdateEntry } from "../lib/types";

/** Normalize saved subtask rows (drops empty text for display). */
export function parseSubtaskStatusUpdates(raw: unknown): SubtaskStatusUpdateEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SubtaskStatusUpdateEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const bag = item as Record<string, unknown>;
    const project_id = bag.project_id;
    const update_text = bag.update_text;
    if (typeof project_id !== "string" || typeof update_text !== "string") continue;
    const trimmed = update_text.trim();
    if (!trimmed) continue;
    out.push({ project_id, update_text: trimmed });
  }
  return out;
}

/** Hydrate form state — keeps selected subtasks even before text is entered. */
export function parseSubtaskStatusUpdatesForForm(raw: unknown): SubtaskStatusUpdateEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SubtaskStatusUpdateEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const bag = item as Record<string, unknown>;
    const project_id = bag.project_id;
    const update_text = bag.update_text;
    if (typeof project_id !== "string" || typeof update_text !== "string") continue;
    out.push({ project_id, update_text });
  }
  return out;
}

function epicSubtasks(epicId: string, projects: Project[] | undefined) {
  const list = projects ?? [];
  const kids = childrenByParent(list);
  return descendants(epicId, kids)
    .filter((p) => p.type === "subtask" && !p.deleted_at)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

export function EpicSubtaskStatusUpdates({
  epicId,
  subtaskUpdates,
  onChange,
}: {
  epicId: string;
  subtaskUpdates: SubtaskStatusUpdateEntry[];
  onChange: (next: SubtaskStatusUpdateEntry[]) => void;
}) {
  const projects = useProjects();
  const allSubtasks = useMemo(
    () => epicSubtasks(epicId, projects.data),
    [epicId, projects.data],
  );
  const selectedById = useMemo(
    () => new Map(subtaskUpdates.map((s) => [s.project_id, s])),
    [subtaskUpdates],
  );

  const setSelected = (childId: string, selected: boolean) => {
    if (selected) {
      if (selectedById.has(childId)) return;
      onChange([...subtaskUpdates, { project_id: childId, update_text: "" }]);
      return;
    }
    onChange(subtaskUpdates.filter((s) => s.project_id !== childId));
  };

  const setUpdateText = (childId: string, update_text: string) => {
    onChange(
      subtaskUpdates.map((s) =>
        s.project_id === childId ? { ...s, update_text } : s,
      ),
    );
  };

  if (!allSubtasks.length) {
    return (
      <p className="text-xs text-wp-slate">This epic has no subtasks to include in the update.</p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-wp-slate">
        Check the subtasks you want in this update. You can remove a mistaken pick anytime.
      </p>
      <ul className="space-y-2">
        {allSubtasks.map((child) => {
          const selected = selectedById.has(child.id);
          const entry = selectedById.get(child.id);
          return (
            <li
              key={child.id}
              className={cn(
                "rounded-md border p-3 transition-colors",
                selected ? "border-wp-stone bg-white" : "border-wp-stone/60 bg-wp-stone/10",
              )}
            >
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected}
                  onChange={(e) => setSelected(child.id, e.target.checked)}
                />
                <span className="min-w-0 flex-1 text-sm font-medium text-wp-ink">{child.title}</span>
              </label>

              {selected ? (
                <div className="mt-3 space-y-2 pl-6">
                  <label className="block text-xs font-medium text-wp-slate">
                    Update for this subtask
                    <textarea
                      className="input mt-1 min-h-[4rem] text-sm"
                      placeholder="What happened on this subtask this week?"
                      value={entry?.update_text ?? ""}
                      maxLength={2000}
                      onChange={(e) => setUpdateText(child.id, e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-ghost inline-flex items-center gap-1.5 text-xs text-wp-slate"
                    onClick={() => setSelected(child.id, false)}
                  >
                    <Trash2 size={13} />
                    Remove from update
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SubtaskStatusUpdatesDisplay({
  subtaskUpdates,
  projectTitleById,
}: {
  subtaskUpdates: SubtaskStatusUpdateEntry[];
  projectTitleById?: Map<string, string>;
}) {
  const visible = parseSubtaskStatusUpdates(subtaskUpdates);
  if (!visible.length) return null;
  return (
    <div className="mt-3 space-y-2 border-l-2 border-wp-stone pl-3">
      {visible.map((entry) => (
        <div key={entry.project_id} className="text-sm">
          <div className="font-medium text-wp-ink">
            {projectTitleById?.get(entry.project_id) ?? "Subtask"}
          </div>
          <p className="mt-0.5 text-wp-slate">{entry.update_text}</p>
        </div>
      ))}
    </div>
  );
}
