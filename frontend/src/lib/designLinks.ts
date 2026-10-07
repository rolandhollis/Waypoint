import type { DesignItemLink } from "./types";

/** Canonical label for the optional primary work-ticket URL. */
export const WORK_TICKET_LINK_LABEL = "Work ticket";

/** Normalize a pasted URL so zod's `.url()` accepts it. */
export function normalizeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function getWorkTicketUrl(links: DesignItemLink[] | null | undefined): string {
  if (!links?.length) return "";
  const named = links.find((l) => l.label === WORK_TICKET_LINK_LABEL);
  return (named ?? links[0])?.url ?? "";
}

/**
 * Set or clear the Work ticket link while preserving any other links.
 * When clearing and the only link was an unlabeled/legacy first link
 * that we treated as the work ticket, remove that entry too.
 */
export function withWorkTicketUrl(
  links: DesignItemLink[] | null | undefined,
  rawUrl: string,
): DesignItemLink[] {
  const current = links ?? [];
  const url = normalizeHttpUrl(rawUrl);
  const withoutNamed = current.filter((l) => l.label !== WORK_TICKET_LINK_LABEL);
  const hadNamed = withoutNamed.length !== current.length;

  if (!url) {
    if (hadNamed) return withoutNamed;
    // Editing cleared a legacy first link that had no Work ticket label.
    if (current.length === 1 && current[0] && current[0].label !== WORK_TICKET_LINK_LABEL) {
      return [];
    }
    return withoutNamed;
  }

  return [{ label: WORK_TICKET_LINK_LABEL, url }, ...withoutNamed];
}
