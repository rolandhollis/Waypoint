export type SubtaskStatusUpdateEntry = {
  project_id: string;
  update_text: string;
};

export type SubtaskStatusUpdateDisplay = SubtaskStatusUpdateEntry & {
  project_title: string;
};

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
