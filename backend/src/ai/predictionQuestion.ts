import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { KalshiMarketCandidate } from "../lib/kalshiMarkets.js";
import { formatKalshiCloseHint } from "../lib/kalshiMarkets.js";

/**
 * Daily prediction-game question generator.
 *
 * Sports-first: evening games and props with ~50/50 stakes, phrased with
 * dry, irreverent wit.
 */

export type PredictionQuestionRequest = {
  tenantName: string;
  gameDate: string;
  gameDateLabel: string;
};

export type PredictionQuestionDraft = {
  question_text: string;
  event_summary: string;
  event_time_hint: string;
  vote_yes_hint: string;
  vote_no_hint: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
};

export class PredictionQuestionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredictionQuestionParseError";
  }
}

export function buildPredictionQuestionSystemPrompt(): string {
  return [
    "You write daily yes/no sports prediction questions for a product team's internal game.",
    "Voice: funny, irreverent, and sharp — think a sports desk that watched too much John Oliver.",
    "Dry wit and skeptical curiosity are welcome; cruelty, slurs, and mean-spirited personal attacks are not.",
    "",
    "CRITICAL — this game is sports only:",
    "- Pick a MAJOR sporting event that tips off / starts / finishes in the EVENING (after ~5:00pm US Central) or overnight.",
    "- Prefer big leagues and tournaments teammates actually recognize: NFL, NBA, MLB, NHL, MLS, NCAA, soccer (EPL/UCL), tennis majors, golf majors, UFC, boxing title fights, Olympics, World Cup, etc.",
    "- Avoid obscure lower leagues, micro props nobody tracks, and esports unless it's a widely known championship final.",
    "- DO NOT use politics, entertainment premieres, hearings, launches, weather, or astronomy.",
    "",
    "CRITICAL — pick a crisp binary stake:",
    "- Simple win/loss is great: \"Will the [favorite underdog] win tonight?\"",
    "- Prop bets are also great when they're easy to verify: first team to score, over/under a round number, player to score, fight goes the distance, etc.",
    "- YES and NO must map to clear, publicly checkable sports outcomes (box score, official result).",
    "- Avoid parlays, multi-leg parlays, and nested conditionals.",
    "",
    "CRITICAL — pick outcomes with genuine ~50/50 uncertainty:",
    "- Teammates vote between 9:00am and 5:00pm Central — both sides should feel plausible before polls close.",
    "- Aim for roughly 40–60% either way, not a slam dunk.",
    "- Prefer toss-up matchups, road dogs with a chance, competitive props near the line.",
    "- Avoid heavy favorites, blowout locks, and \"will this game even be played\" cancellation questions unless the postponement risk is genuinely ~50/50.",
    "",
    "Event rules:",
    "- Outcome should not be knowable during voting hours (9:00am–5:00pm US Central).",
    "- Prefer events that resolve after 5:00pm CT or overnight (by 9:00am CT the next morning).",
    "- Publicly verifiable by next morning via box scores / official league results.",
    "- Do NOT invent fictional games or teams.",
    "",
    "Output rules:",
    "- question_text: witty setup ending in a clear yes/no — include approximate tip-off / start time when known.",
    "- vote_yes_hint / vote_no_hint: short subtitles (max ~12 words) explaining what each button means FOR THIS question (e.g. team names, prop sides).",
    "- event_summary: factual one-liner for admins resolving the outcome.",
    "- event_time_hint: scheduled tip-off / start / resolution window when known.",
    "",
    "You MUST respond by calling the submit_prediction_question tool exactly once.",
  ].join("\n");
}

export function buildPredictionQuestionUserPrompt(req: PredictionQuestionRequest): string {
  return [
    `Calendar date: ${req.gameDateLabel} (${req.gameDate})`,
    `Workspace: ${req.tenantName}`,
    "",
    "Pick one major sporting event tonight (or overnight) where the outcome is genuinely uncertain (~50/50) during the 9am–5pm Central voting window.",
    "Outcome should resolve after voting closes (evening or by 9am CT next morning).",
    "Sports only — win/loss or a simple prop. No politics, entertainment, or weather.",
    "Write a witty sports-desk prediction question with a clear yes/no stake.",
    "Include vote_yes_hint and vote_no_hint that name the sides (teams, over/under, player prop).",
    "",
    "Good picks: evening NBA/NFL/MLB tip with a near coin-flip moneyline; UFC main event goes the distance; player scores / doesn't; O/U near the consensus number.",
    "Bad picks: -14 favorites, obscure lower-league fixtures, multi-leg parlays, \"will it rain and cancel\".",
    "",
    "Example tone for question_text (do not copy): \"The Celtics host the Knicks at 7:30 CT — will New York actually leave Boston with a W, or is this another night the Garden eats visitors for dinner?\"",
    "Example vote hints for that example: yes=\"Knicks win\" no=\"Celtics win\"",
  ].join("\n");
}

function assertDraft(value: unknown): Omit<
  PredictionQuestionDraft,
  "model" | "prompt_tokens" | "completion_tokens"
> {
  if (!value || typeof value !== "object") {
    throw new PredictionQuestionParseError("tool input missing");
  }
  const obj = value as Record<string, unknown>;
  const question_text = obj.question_text;
  const event_summary = obj.event_summary;
  const event_time_hint = obj.event_time_hint;
  const vote_yes_hint = obj.vote_yes_hint;
  const vote_no_hint = obj.vote_no_hint;
  if (typeof question_text !== "string" || !question_text.trim()) {
    throw new PredictionQuestionParseError("question_text must be a non-empty string");
  }
  if (typeof event_summary !== "string" || !event_summary.trim()) {
    throw new PredictionQuestionParseError("event_summary must be a non-empty string");
  }
  if (typeof event_time_hint !== "string" || !event_time_hint.trim()) {
    throw new PredictionQuestionParseError("event_time_hint must be a non-empty string");
  }
  if (typeof vote_yes_hint !== "string" || !vote_yes_hint.trim()) {
    throw new PredictionQuestionParseError("vote_yes_hint must be a non-empty string");
  }
  if (typeof vote_no_hint !== "string" || !vote_no_hint.trim()) {
    throw new PredictionQuestionParseError("vote_no_hint must be a non-empty string");
  }
  if (question_text.length > 500) {
    throw new PredictionQuestionParseError("question_text too long");
  }
  if (event_summary.length > 800) {
    throw new PredictionQuestionParseError("event_summary too long");
  }
  if (event_time_hint.length > 120) {
    throw new PredictionQuestionParseError("event_time_hint too long");
  }
  if (vote_yes_hint.length > 120) {
    throw new PredictionQuestionParseError("vote_yes_hint too long");
  }
  if (vote_no_hint.length > 120) {
    throw new PredictionQuestionParseError("vote_no_hint too long");
  }
  return {
    question_text: question_text.trim(),
    event_summary: event_summary.trim(),
    event_time_hint: event_time_hint.trim(),
    vote_yes_hint: vote_yes_hint.trim(),
    vote_no_hint: vote_no_hint.trim(),
  };
}

const PREDICTION_QUESTION_TOOL = {
  name: "submit_prediction_question",
  description: "Submit the daily sports prediction question.",
  input_schema: {
    type: "object",
    properties: {
      question_text: {
        type: "string",
        description: "Witty sports yes/no question with a clear binary stake.",
      },
      event_summary: {
        type: "string",
        description: "Factual one sentence for admins resolving yes/no.",
      },
      event_time_hint: {
        type: "string",
        description: "When the game/prop resolves, e.g. '7:30pm CT tip'.",
      },
      vote_yes_hint: {
        type: "string",
        description: "Short subtitle for the Yes button for THIS question.",
      },
      vote_no_hint: {
        type: "string",
        description: "Short subtitle for the No button for THIS question.",
      },
    },
    required: [
      "question_text",
      "event_summary",
      "event_time_hint",
      "vote_yes_hint",
      "vote_no_hint",
    ],
    additionalProperties: false,
  },
} as const;

async function callPredictionQuestionTool(
  system: string,
  user: string,
  opts: { client?: Anthropic } = {},
): Promise<PredictionQuestionDraft> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const client = opts.client ?? new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = config.anthropic.model;

  const response = await client.messages.create({
    model,
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: user }],
    tools: [PREDICTION_QUESTION_TOOL as never],
    tool_choice: { type: "tool", name: "submit_prediction_question" },
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new PredictionQuestionParseError("model did not call submit_prediction_question");
  }
  const parsed = assertDraft(toolBlock.input);
  return {
    ...parsed,
    model,
    prompt_tokens: response.usage.input_tokens,
    completion_tokens: response.usage.output_tokens,
  };
}

export function buildKalshiRephraseSystemPrompt(): string {
  return [
    "You rephrase Kalshi sports prediction-market contracts into daily game questions.",
    "Voice: funny, irreverent, sharp — think a sports desk that watched too much John Oliver.",
    "CRITICAL: Preserve the EXACT yes/no resolution from the Kalshi contract.",
    "Do not change what counts as yes vs no — admins resolve against Kalshi's settlement.",
    "vote_yes_hint and vote_no_hint must match the Kalshi YES/NO subtitles (lightly edited for clarity) — prefer team names / prop sides over generic Yes/No.",
    "event_summary: plain factual sentence for admins; mention the Kalshi ticker.",
    "You MUST respond by calling the submit_prediction_question tool exactly once.",
  ].join("\n");
}

export function buildKalshiRephraseUserPrompt(
  market: KalshiMarketCandidate,
  tenantName: string,
): string {
  return [
    `Workspace: ${tenantName}`,
    `Kalshi ticker: ${market.ticker}`,
    `Event: ${market.event_title}`,
    `Contract title: ${market.title}`,
    `Category: ${market.category || "Sports"}`,
    `Kalshi URL: ${market.kalshi_url}`,
    `Kalshi YES means: ${market.yes_sub_title}`,
    `Kalshi NO means: ${market.no_sub_title}`,
    `Market-implied yes probability: ~${market.yes_price_pct}% (prefer markets near 50/50).`,
    `Market close time: ${market.close_time} (${formatKalshiCloseHint(market.close_time)}).`,
    "",
    "Rephrase into one witty sports-desk question that ends in a clear yes/no.",
    "Do not invent a different event — this is the Kalshi contract teammates will resolve against.",
  ].join("\n");
}

/** Rephrase a Kalshi market contract into our game question format. */
export async function rephraseKalshiMarket(
  market: KalshiMarketCandidate,
  tenantName: string,
  opts: { client?: Anthropic } = {},
): Promise<PredictionQuestionDraft> {
  return callPredictionQuestionTool(
    buildKalshiRephraseSystemPrompt(),
    buildKalshiRephraseUserPrompt(market, tenantName),
    opts,
  );
}

export async function generatePredictionQuestion(
  req: PredictionQuestionRequest,
  opts: { client?: Anthropic } = {},
): Promise<PredictionQuestionDraft> {
  return callPredictionQuestionTool(
    buildPredictionQuestionSystemPrompt(),
    buildPredictionQuestionUserPrompt(req),
    opts,
  );
}
