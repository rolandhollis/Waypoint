import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { KalshiMarketCandidate } from "../lib/kalshiMarkets.js";
import { formatKalshiCloseHint } from "../lib/kalshiMarkets.js";

/**
 * Daily prediction-game question generator.
 *
 * Picks human-scheduled evening events with a crisp yes/no stake and
 * phrases them in a witty, John Oliver–adjacent voice.
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
    "You write daily yes/no prediction questions for a product team's internal game.",
    "Voice: funny, irreverent, and sharp — think John Oliver on Last Week Tonight.",
    "Dry wit and skeptical curiosity are welcome; cruelty, slurs, and mean-spirited personal attacks are not.",
    "",
    "CRITICAL — pick events that fit a clean yes/no vote:",
    "- The event must be a HUMAN-SCHEDULED activity: a broadcast, vote, hearing, launch, premiere, press conference, award show, court ruling window, product drop, etc.",
    "- Something an organizer can cancel, postpone, delay, or fail to hold — NOT a natural phenomenon.",
    "- DO NOT use: meteor showers, eclipses, tides, weather, astronomical peaks, or \"will visibility be good\" questions.",
    "- Sports are OK when the outcome is a real ~50/50 — avoid making every day a game preview.",
    "- YES means the scheduled thing occurs as planned (airs, starts, passes, is held, releases, etc.).",
    "- NO means it is cancelled, postponed, delayed past that evening, or clearly does not occur.",
    "- The question must be phrased so both outcomes are sensible — never ask voters to pick \"cancelled\" for something that cannot be cancelled.",
    "",
    "CRITICAL — pick events with genuine ~50/50 uncertainty:",
    "- Teammates vote between 9:00am and 5:00pm Central — both sides should feel plausible before polls close.",
    "- Aim for roughly 40–60% either way, not a slam dunk.",
    "- Prefer outcomes that are actively in doubt: cliffhanger votes, launch windows that often slip, \"will they actually announce tonight\", delayed hearings, surprise cancellations in flux.",
    "- Avoid near-certainties: routine broadcasts that always air, holidays, events already confirmed hours ahead with no credible doubt.",
    "- Avoid long-shot stunts unlikely to happen unless the scheduled event itself is the long shot (e.g. a bill that might pass tonight).",
    "- If the base event is certain, do NOT use it — find a uncertain sub-question (timing, completion, announcement) or pick a different event.",
    "",
    "Event rules:",
    "- Outcome should not be knowable during voting hours (9:00am–5:00pm US Central).",
    "- Prefer events that resolve after 5:00pm CT or overnight (by 9:00am CT the next morning).",
    "- Prefer weird news, politics, entertainment, awards, launches, hearings, corporate stunts, and culture moments.",
    "- Sports are fine when genuinely uncertain (~50/50) — do not let sports dominate; prefer entertainment, politics, and general news when available.",
    "- Economics and financial dailies are great when the contract is a crisp yes/no.",
    "- Publicly verifiable by next morning (official schedules, news, government calendars, network listings).",
    "- Do NOT invent fictional events.",
    "",
    "Output rules:",
    "- question_text: witty setup ending in a clear yes/no — include approximate time when known.",
    "- vote_yes_hint / vote_no_hint: short subtitles (max ~12 words) explaining what each button means FOR THIS question.",
    "- event_summary: factual one-liner for admins resolving the outcome.",
    "- event_time_hint: scheduled time or resolution window when known.",
    "",
    "You MUST respond by calling the submit_prediction_question tool exactly once.",
  ].join("\n");
}

export function buildPredictionQuestionUserPrompt(req: PredictionQuestionRequest): string {
  return [
    `Calendar date: ${req.gameDateLabel} (${req.gameDate})`,
    `Workspace: ${req.tenantName}`,
    "",
    "Pick one human-scheduled event where the outcome is genuinely uncertain (~50/50) during the 9am–5pm Central voting window.",
    "Outcome should resolve after voting closes (evening or by 9am CT next morning).",
    "Skew toward entertainment, politics, general news, and economics — sports are OK but should not dominate.",
    "Never a natural phenomenon.",
    "Write a John Oliver–style prediction question where YES = it happens as scheduled and NO = cancelled/postponed/doesn't occur.",
    "Include vote_yes_hint and vote_no_hint that match this specific question — not generic \"cancelled\" text unless cancellation is actually the NO case.",
    "",
    "Good uncertain picks: cliffhanger floor vote, launch that might slip, earnings call where guidance is a coin flip, \"will they drop the news tonight vs. tomorrow\".",
    "Bad picks: routine nightly news, sure-thing premieres, events with no credible chance of cancellation.",
    "Bad event types: meteor shower visibility, \"will it rain\", sunrise/sunset, planetary alignment.",
    "",
    "Example tone for question_text (do not copy): \"Will the Senate actually gavel out before midnight, or will we get another 'historic evening of democracy' that eats everyone's dinner?\"",
    "Example vote hints for that example: yes=\"They wrap before midnight\" no=\"Session drags on or gets postponed\"",
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
  description: "Submit the daily prediction question.",
  input_schema: {
    type: "object",
    properties: {
      question_text: {
        type: "string",
        description: "Witty yes/no question with a clear binary stake.",
      },
      event_summary: {
        type: "string",
        description: "Factual one sentence for admins resolving yes/no.",
      },
      event_time_hint: {
        type: "string",
        description: "When the outcome is expected, e.g. '10:30pm CT'.",
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
    "You rephrase Kalshi prediction-market contracts into daily game questions.",
    "Voice: funny, irreverent, sharp — think John Oliver on Last Week Tonight.",
    "CRITICAL: Preserve the EXACT yes/no resolution from the Kalshi contract.",
    "Do not change what counts as yes vs no — admins resolve against Kalshi's settlement.",
    "vote_yes_hint and vote_no_hint must match the Kalshi YES/NO subtitles (lightly edited for clarity).",
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
    `Kalshi URL: ${market.kalshi_url}`,
    `Kalshi YES means: ${market.yes_sub_title}`,
    `Kalshi NO means: ${market.no_sub_title}`,
    `Market-implied yes probability: ~${market.yes_price_pct}% (pick markets near 50/50).`,
    `Market close time: ${market.close_time} (${formatKalshiCloseHint(market.close_time)}).`,
    "",
    "Rephrase into one witty John Oliver–style question that ends in a clear yes/no.",
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
