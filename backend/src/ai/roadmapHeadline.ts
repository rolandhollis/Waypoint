import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * Roadmap Headline generator.
 *
 * Given a slice of the currently-visible roadmap — pre-grouped by
 * whatever the user is looking at (team / owner / KPI / lane / …)
 * — ask Claude to write an executive-voice narrative summary of
 * what's coming up. The output is markdown with `## <label>`
 * headers per group; each section is two to four sentences of
 * prose.
 *
 * Deliberately isolated from Express so the prompt shape can be
 * unit-tested / eyeballed in dev. The route layer
 * (backend/src/routes/aiHeadline.ts) owns rate limiting, auth,
 * body validation, and the 503/502 error surface.
 */

/** Max characters of a project description we forward to Claude.
 *  Roadmaps can contain 30+ items; without a cap a workspace with
 *  a couple of huge descriptions could blow the token window on
 *  a single request. 400 chars is enough to convey the shape of
 *  the work without swamping the prompt. */
export const HEADLINE_DESCRIPTION_MAX_CHARS = 400;

/** Ceiling on the number of grouped areas we forward in one
 *  request. The Roadmap UI can (in theory) create many small
 *  buckets under the "team" grouping in a large tenant; capping
 *  keeps the prompt bounded. Extra groups are dropped from the
 *  tail — the caller's ordering places the most important
 *  labels first. */
export const HEADLINE_MAX_GROUPS = 40;

/** Per-group cap on projects forwarded. Extra items are dropped
 *  from the tail and a short `(+N more)` count is passed through
 *  as a hint so Claude can still mention the scale. */
export const HEADLINE_MAX_PROJECTS_PER_GROUP = 25;

export type HeadlineGroupBy =
  | "none"
  | "lane"
  | "team"
  | "owner"
  | "kpi"
  | "tag";

export type HeadlineProject = {
  title: string;
  description: string;
  start: string | null;
  end: string | null;
  phase: string;
  teamNames: string[];
  ownerName: string | null;
  kpiNames: string[];
};

export type HeadlineGroup = {
  label: string;
  projects: HeadlineProject[];
};

export type HeadlineRequest = {
  tenantName: string;
  groupBy: HeadlineGroupBy;
  timeframeLabel: string;
  groups: HeadlineGroup[];
};

export type HeadlineResult = {
  headline: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

/** Thrown when Claude returned a successful response but the
 *  payload didn't carry any usable narrative text (empty content,
 *  wrong shape, blocked completion, …). The route layer maps this
 *  to a 502. */
export class HeadlineParseError extends Error {
    constructor(message: string) {
    super(message);
    this.name = "HeadlineParseError";
  }
}

/**
 * Truncate a free-form description down to
 * HEADLINE_DESCRIPTION_MAX_CHARS. Roadmaps are prose-heavy and
 * we're happy to leak enough context for Claude to write a
 * sentence about each item, but nothing more.
 */
export function truncateHeadlineDescription(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "(no description)";
  if (t.length <= HEADLINE_DESCRIPTION_MAX_CHARS) return t;
  return t.slice(0, HEADLINE_DESCRIPTION_MAX_CHARS).trimEnd() + "…";
}

/**
 * Human-readable label for the grouping axis, injected into the
 * system prompt so Claude phrases the summary in the caller's
 * frame ("by team" / "by owner" / …).
 */
function groupingAxisLabel(groupBy: HeadlineGroupBy): string {
  switch (groupBy) {
    case "team": return "team";
    case "owner": return "owner";
    case "lane": return "swim lane / stage";
    case "kpi": return "KPI";
    case "tag": return "tag";
    case "none":
    default: return "top-level lane";
  }
}

/**
 * Compose the user-facing block Claude sees. Kept pure so a dev
 * can dump the string and eyeball it. Every group renders as its
 * own `### <label>` sub-block (the OUTER prompt is markdown; the
 * inner list is compact key-value lines so the token budget stays
 * flat as project count grows).
 */
export function buildHeadlineUserPrompt(req: HeadlineRequest): string {
  const lines: string[] = [];
  lines.push(`TIMEFRAME: ${req.timeframeLabel}`);
  lines.push(`GROUPING AXIS: ${groupingAxisLabel(req.groupBy)}`);
  lines.push(`TENANT: ${req.tenantName}`);
  lines.push("");
  if (req.groups.length === 0) {
    lines.push("(No scheduled projects match the current filters. Say so plainly in one sentence.)");
    return lines.join("\n");
  }
  for (const g of req.groups) {
    lines.push(`### ${g.label} (${g.projects.length} project${g.projects.length === 1 ? "" : "s"})`);
    if (g.projects.length === 0) {
      lines.push("- (no scheduled items in this group)");
      lines.push("");
      continue;
    }
    for (const p of g.projects) {
      const dateBits: string[] = [];
      if (p.start) dateBits.push(`starts ${p.start}`);
      if (p.end) dateBits.push(`ends ${p.end}`);
      const dateStr = dateBits.length ? ` [${dateBits.join(", ")}]` : "";
      lines.push(`- "${p.title}" — phase: ${p.phase}${dateStr}`);
      if (p.ownerName) lines.push(`  owner: ${p.ownerName}`);
      if (p.teamNames.length) lines.push(`  teams: ${p.teamNames.join(", ")}`);
      if (p.kpiNames.length) lines.push(`  KPIs: ${p.kpiNames.join(", ")}`);
      lines.push(`  description: ${truncateHeadlineDescription(p.description)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * System prompt. Tight instructions on voice, format, and length
 * so we don't accidentally get a bullet-list back. The `## <label>`
 * markdown convention is preserved verbatim in the response so the
 * frontend's tiny inline renderer can split on it cheaply.
 */
export function buildHeadlineSystemPrompt(): string {
    return [
    "You are writing an executive summary of an in-flight product roadmap for a Retail-focused PM audience.",
    "Group your summary by the group labels provided.",
    "Two to four sentences per group.",
    "Highlight the biggest / soonest / most strategic items.",
    "Mention concrete dates where useful.",
    "Do not repeat raw item lists — write narrative prose.",
    "If a group has just one item, still write about it naturally.",
    "Output plain paragraphs separated by blank lines.",
    "Use `## <group label>` markdown headers for each section, matching the group labels exactly.",
    "Do not add a top-level title, preamble, or closing paragraph — start with the first `## <group label>` header.",
  ].join(" ");
}

/**
 * Cap the group / project counts so a runaway request can't dwarf
 * the token budget. Extra groups are dropped from the tail; extra
 * projects inside a kept group are truncated and a synthetic
 * `(+N more)` project is inserted so Claude can still mention the
 * volume without seeing the individual titles.
 */
export function capHeadlineGroups(groups: HeadlineGroup[]): HeadlineGroup[] {
  const capped = groups.slice(0, HEADLINE_MAX_GROUPS);
  return capped.map((g) => {
    if (g.projects.length <= HEADLINE_MAX_PROJECTS_PER_GROUP) return g;
    const kept = g.projects.slice(0, HEADLINE_MAX_PROJECTS_PER_GROUP);
    const extras = g.projects.length - kept.length;
    kept.push({
      title: `(+${extras} more projects not shown)`,
      description: "",
      start: null,
      end: null,
      phase: "n/a",
      teamNames: [],
      ownerName: null,
      kpiNames: [],
    });
    return { ...g, projects: kept };
  });
}

/**
 * Call Claude and return the raw headline string plus token counts.
 * Throws HeadlineParseError if the response was successful but had
 * no usable text; propagates SDK errors (rate limit / upstream 5xx
 * / timeout) so the route can translate to a 502.
 */
export async function generateHeadline(
  req: HeadlineRequest,
  opts: { client?: Anthropic } = {},
): Promise<HeadlineResult> {
  if (!config.anthropic.apiKey) {
    // Belt-and-suspenders — the route layer 503s before we ever
    // reach this point in a well-formed deploy.
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const client = opts.client ?? new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = config.anthropic.model;

  const system = buildHeadlineSystemPrompt();
  const user = buildHeadlineUserPrompt({ ...req, groups: capHeadlineGroups(req.groups) });

  const response = await client.messages.create({
    model,
    // Headlines are prose. Give Claude enough room for four
    // sentences per group at HEADLINE_MAX_GROUPS groups — ~3.5k
    // output tokens is plenty for the practical ceiling.
    max_tokens: 3500,
    system,
    messages: [{ role: "user", content: user }],
  });

  // Walk the returned content blocks and concatenate any text
  // spans. Claude occasionally emits multiple text blocks when
  // reasoning across a longer prompt; combining them into a
  // single string keeps the downstream renderer trivial.
  const textBlocks: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      textBlocks.push(block.text);
    }
  }
  const combined = textBlocks.join("\n").trim();
  if (!combined) {
    throw new HeadlineParseError("model returned no text content");
  }

  return {
    headline: combined,
    model,
    promptTokens: response.usage?.input_tokens ?? 0,
    completionTokens: response.usage?.output_tokens ?? 0,
  };
}
