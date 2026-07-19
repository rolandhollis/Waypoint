import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * AI phase-size estimator for the EZEstimates flow.
 *
 * Given a proposed project's title + description, ask Claude to size
 * each of the three delivery phases (Discovery / Development /
 * Post-Development) using the tenant's own T-shirt catalog plus a
 * handful of recently-completed local projects as few-shot examples.
 *
 * The module is deliberately isolated from Express so it can be
 * unit-tested / eyeballed in isolation. The route layer
 * (backend/src/routes/projects.ts) is in charge of loading the
 * inputs (target project, T-shirt catalog, few-shot rows), rate
 * limiting, auth, and persisting the response.
 */

/** Phases returned by the estimator. Keys mirror the frontend's
 *  PhaseKey enum so the UI can dispatch by name without a lookup. */
export const PHASE_KEYS = ["discovery", "development", "post_dev"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export type TshirtBucket = {
  /** Human label (e.g. "S", "M", "Large"). The admin can rename
   *  these — never hard-code S/M/L/XL/XXL when validating. */
  label: string;
  /** Nominal working-day count this bucket represents. */
  days: number;
};

export type FewShotExample = {
  title: string;
  description: string;
  /**
   * Actual measured length per phase for the completed project,
   * matched to the nearest bucket on the days axis. Any phase left
   * unmeasured (dates missing on the historical row) is omitted so
   * we never feed Claude a made-up figure.
   */
  phases: Partial<
    Record<
      PhaseKey,
      { actual_days: number; nearest_size: string }
    >
  >;
  /**
   * Optional curator commentary — only populated for
   * ai_reference_estimates rows. Rendered inline in the prompt as
   * a `# Notes:` hint so Claude weighs the curator's reasoning
   * ("high confidence", "typical for this workspace", etc.).
   * Historical rows never carry this.
   */
  notes?: string | null;
};

export type EstimatorRequest = {
  tenantName: string;
  tshirts: TshirtBucket[];
  /**
   * Hand-curated reference estimates — highest-priority examples,
   * seeded by admins via CSV upload / manual add. Rendered first
   * in the prompt under a `## Curated reference estimates` header
   * so Claude weighs them above the historical block.
   */
  curated: FewShotExample[];
  /**
   * Historical projects filtered to those where an engineer
   * signed off on the dev estimate (dev_estimate_sourced_by_dev
   * = TRUE). Rendered second in the prompt under a `## Historical
   * confirmed estimates` header.
   */
  historical: FewShotExample[];
  target: { title: string; description: string };
};

/** One phase of the LLM's answer. */
export type AiPhaseSuggestion = {
  size: string; // one of tshirts[].label
  confidence: Confidence;
  reasoning: string;
};

/** Full row we persist to `projects.ai_suggestion`. */
export type AiSuggestion = {
  discovery: AiPhaseSuggestion;
  development: AiPhaseSuggestion;
  post_dev: AiPhaseSuggestion;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
};

/** Thrown by generateSuggestion when the SDK returned successfully
 *  but the payload didn't parse as a valid AiSuggestion (wrong shape,
 *  unknown size label, missing phase, etc.). The route layer maps
 *  this to a 502 without persisting anything. */
export class AiEstimatorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiEstimatorParseError";
  }
}

/** Human-readable phase label used in the prompt so Claude's
 *  reasoning field reads naturally back to the user. */
const PHASE_PROMPT_LABELS: Record<PhaseKey, string> = {
  discovery: "Discovery",
  development: "Development",
  post_dev: "Post-Development",
};

/**
 * Snap an actual day count to the nearest T-shirt label. Ties break
 * toward the SMALLER bucket — matches the "don't over-promise" bias
 * a PM has when rounding an estimate.
 */
export function nearestSizeLabel(days: number, tshirts: TshirtBucket[]): string {
  if (!tshirts.length) return "?";
  const sorted = [...tshirts].sort((a, b) => a.days - b.days);
  let bestLabel = sorted[0]!.label;
  let bestDelta = Math.abs(days - sorted[0]!.days);
  for (let i = 1; i < sorted.length; i++) {
    const delta = Math.abs(days - sorted[i]!.days);
    if (delta < bestDelta) {
      bestLabel = sorted[i]!.label;
      bestDelta = delta;
    }
  }
  return bestLabel;
}

/**
 * Truncate a free-form description so we don't blow the token
 * window on a single row. The estimator only needs enough context
 * to see the project's shape — the first ~600 chars carry that
 * signal for the vast majority of well-written descriptions. Falls
 * back to "(no description provided)" when the field is empty so
 * the prompt stays uniformly structured.
 */
export function truncateDescription(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "(no description provided)";
  if (t.length <= 600) return t;
  return t.slice(0, 600).trimEnd() + "…";
}

/**
 * Render one few-shot row as three prompt lines: the title +
 * per-phase summary, the description, and (for curated rows) an
 * inline `# Notes:` hint carrying the curator's commentary.
 */
function renderExampleRow(row: FewShotExample, i: number, lines: string[]) {
  const phaseBits: string[] = [];
  for (const key of PHASE_KEYS) {
    const p = row.phases[key];
    if (!p) continue;
    phaseBits.push(
      `${PHASE_PROMPT_LABELS[key]}=${p.actual_days}d (${p.nearest_size})`,
    );
  }
  const summary = phaseBits.length ? phaseBits.join(", ") : "(no phase data)";
  lines.push(`${i + 1}. "${row.title}" — ${summary}`);
  lines.push(`   Description: ${truncateDescription(row.description)}`);
  const notes = (row.notes ?? "").trim();
  if (notes) {
    lines.push(`   # Notes: ${notes}`);
  }
}

/**
 * Build the user-facing prompt block: T-shirt catalog, curated
 * reference estimates, historical confirmed estimates, target
 * project. Kept pure + returning a string so it can be inspected by
 * hand during local dev and unit-tested without a network round-trip.
 *
 * Curated reference estimates come first because admins have vetted
 * them by hand; historical examples are still-good signal but
 * lower-priority. If BOTH sources are empty we still call Claude,
 * warning the model in the prompt that it's a best-effort guess.
 */
export function buildUserPrompt(req: EstimatorRequest): string {
  const lines: string[] = [];

  lines.push("T-SHIRT CATALOG (allowed size labels):");
  const sortedShirts = [...req.tshirts].sort((a, b) => a.days - b.days);
  for (const t of sortedShirts) {
    lines.push(`- ${t.label}: ${t.days} day${t.days === 1 ? "" : "s"}`);
  }
  lines.push("");

  const bothEmpty = req.curated.length === 0 && req.historical.length === 0;
  if (bothEmpty) {
    lines.push(
      "NO HISTORICAL OR CURATED DATA AVAILABLE — the workspace has neither curated reference estimates nor engineer-confirmed historical projects yet. Reason with the T-shirt catalog and the target's description alone; drop confidence to `low` unless the description makes the sizing trivially obvious.",
    );
    lines.push("");
  } else {
    lines.push(`## Curated reference estimates (highest priority) — ${req.curated.length}`);
    if (req.curated.length === 0) {
      lines.push("(No curated reference estimates configured for this workspace yet.)");
    } else {
      req.curated.forEach((row, i) => renderExampleRow(row, i, lines));
    }
    lines.push("");

    lines.push(`## Historical confirmed estimates — ${req.historical.length}`);
    if (req.historical.length === 0) {
      lines.push("(No historical projects with an engineer-confirmed dev estimate and full phase-date coverage.)");
    } else {
      req.historical.forEach((row, i) => renderExampleRow(row, i, lines));
    }
    lines.push("");
  }

  lines.push("ESTIMATE THIS PROJECT:");
  lines.push(`Title: ${req.target.title}`);
  lines.push(`Description: ${truncateDescription(req.target.description)}`);

  return lines.join("\n");
}

/**
 * System prompt. Explicit about (a) which labels are legal, (b)
 * that reasoning MUST cite historical evidence, and (c) that the
 * response is delivered exclusively through the `submit_estimate`
 * tool — no free-form prose.
 */
export function buildSystemPrompt(tenantName: string, tshirts: TshirtBucket[]): string {
  const labels = tshirts.map((t) => `"${t.label}"`).join(", ");
  return [
    `You are a project-estimation assistant embedded in the ${tenantName} team's roadmap tool.`,
    "Given a proposed project's title + description, estimate the size of each of the three delivery phases (Discovery, Development, Post-Development) using ONLY the T-shirt buckets in this workspace.",
    `The ONLY allowed values for the "size" field are: ${labels}. Never invent a bucket that isn't in the catalog.`,
    `Confidence rules: "high" only when the project resembles multiple historical examples; "medium" when it resembles one or the description is clear but analogs are weak; "low" when no analog exists or the description is vague.`,
    "Reasoning fields should be one or two sentences citing the specific historical evidence you weighed. Keep it concrete — reference titles and phase lengths from the examples when relevant.",
    "You MUST respond by calling the submit_estimate tool exactly once. Do not emit any free-form prose.",
  ].join(" ");
}

/**
 * JSON Schema fed to Claude as the `submit_estimate` tool input.
 * Dynamically restricts `size` to the tenant's actual label set so
 * the model literally cannot hand back a bucket the admin hasn't
 * defined. The route layer re-validates on receipt as belt-and-
 * suspenders.
 */
export function buildToolSchema(tshirts: TshirtBucket[]): Record<string, unknown> {
  const allowedSizes = tshirts.map((t) => t.label);
  const phaseSchema = {
    type: "object",
    properties: {
      size: { type: "string", enum: allowedSizes },
      confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
      reasoning: { type: "string", minLength: 1, maxLength: 500 },
    },
    required: ["size", "confidence", "reasoning"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      discovery: phaseSchema,
      development: phaseSchema,
      post_dev: phaseSchema,
    },
    required: ["discovery", "development", "post_dev"],
    additionalProperties: false,
  };
}

/** Runtime assertion that a raw payload from Claude matches the
 *  expected AiSuggestion phase shape. Throws AiEstimatorParseError
 *  on any deviation so the route can convert to a 502. */
function assertPhase(
  value: unknown,
  phase: PhaseKey,
  allowedSizes: Set<string>,
): AiPhaseSuggestion {
  if (!value || typeof value !== "object") {
    throw new AiEstimatorParseError(`missing "${phase}" object`);
  }
  const obj = value as Record<string, unknown>;
  const size = obj.size;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;
  if (typeof size !== "string" || !allowedSizes.has(size)) {
    throw new AiEstimatorParseError(
      `"${phase}.size" (${JSON.stringify(size)}) is not one of the allowed T-shirt labels`,
    );
  }
  if (typeof confidence !== "string" || !CONFIDENCE_LEVELS.includes(confidence as Confidence)) {
    throw new AiEstimatorParseError(
      `"${phase}.confidence" (${JSON.stringify(confidence)}) is not low/medium/high`,
    );
  }
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    throw new AiEstimatorParseError(`"${phase}.reasoning" is empty or not a string`);
  }
  return {
    size,
    confidence: confidence as Confidence,
    reasoning: reasoning.trim(),
  };
}

/**
 * Call Claude and return a validated AiSuggestion. Throws
 * AiEstimatorParseError if the response was successful but the
 * payload was malformed; propagates SDK errors otherwise (rate
 * limit, upstream 5xx, timeout, etc.) for the route to translate.
 *
 * Not exposed via the router directly — routes/projects.ts owns
 * the transaction, cache-write, and rate-limit bookkeeping around it.
 */
export async function generateSuggestion(
  req: EstimatorRequest,
  opts: { client?: Anthropic } = {},
): Promise<AiSuggestion> {
  if (!config.anthropic.apiKey) {
    // Guarded by the route layer normally; belt-and-suspenders here
    // so a stray internal caller can't ship an unconfigured request.
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const client = opts.client ?? new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = config.anthropic.model;

  const system = buildSystemPrompt(req.tenantName, req.tshirts);
  const user = buildUserPrompt(req);
  const inputSchema = buildToolSchema(req.tshirts);

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system,
    tools: [
      {
        name: "submit_estimate",
        description:
          "Submit the per-phase T-shirt size estimate with confidence and reasoning.",
        input_schema: inputSchema as never,
      },
    ],
    tool_choice: { type: "tool", name: "submit_estimate" },
    messages: [{ role: "user", content: user }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new AiEstimatorParseError("model did not return a tool_use block");
  }
  const raw = toolUse.input;
  if (!raw || typeof raw !== "object") {
    throw new AiEstimatorParseError("tool_use.input was not an object");
  }
  const allowed = new Set(req.tshirts.map((t) => t.label));
  const rawObj = raw as Record<string, unknown>;
  const discovery = assertPhase(rawObj.discovery, "discovery", allowed);
  const development = assertPhase(rawObj.development, "development", allowed);
  const post_dev = assertPhase(rawObj.post_dev, "post_dev", allowed);

  return {
    discovery,
    development,
    post_dev,
    model,
    prompt_tokens: response.usage?.input_tokens ?? 0,
    completion_tokens: response.usage?.output_tokens ?? 0,
  };
}
