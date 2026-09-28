import type { Assignment } from "@ziffsplit/sdk";

/** Reserved API/container code keys (must match ziffsplit-admin variantDraft). */
export const API_ORIGINAL_KEY = "original";
export const API_BLANK_KEY = "blank";

export type ApiSlotRender =
  | { kind: "original" }
  | { kind: "blank" }
  | { kind: "html"; html: string };

/**
 * Resolve how a host container slot should render for an API (or mixed) assignment.
 * - original → keep CMS / React default
 * - blank → hide the slot
 * - html → render authored HTML
 */
export function resolveApiSlotAssignment(
  assignment: Assignment | null | undefined,
): ApiSlotRender {
  if (!assignment) return { kind: "original" };

  if (assignment.contentSource === "authored") {
    const html = assignment.authoredContent?.trim() ?? "";
    if (!html) return { kind: "blank" };
    return { kind: "html", html };
  }

  const key = assignment.codeVariantKey?.trim() ?? "";
  if (key === API_BLANK_KEY) return { kind: "blank" };
  return { kind: "original" };
}
