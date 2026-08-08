import { query } from "../db/pool.js";
import {
  generatePredictionQuestion,
  PredictionQuestionParseError,
  rephraseKalshiMarket,
} from "../ai/predictionQuestion.js";
import { config } from "../config.js";
import {
  formatKalshiCloseHint,
  pickKalshiMarketForGame,
} from "./kalshiMarkets.js";
import {
  isBeforePredictionVotingOpen,
  isPredictionVotingOpen,
  predictionGameDate,
  predictionGameDateLabel,
  predictionVoteCutoffAt,
  predictionVoteOpenAt,
} from "./predictionGameTime.js";
import type { PredictionQuestionRow } from "../types.js";

export type PredictionQuestionDto = {
  id: string;
  group_id: string;
  game_date: string;
  question_text: string;
  event_summary: string;
  event_time_hint: string | null;
  vote_yes_hint: string;
  vote_no_hint: string;
  cutoff_at: string;
  outcome: boolean | null;
  outcome_note: string | null;
  resolved_at: string | null;
  llm_model: string | null;
  generated_at: string;
  kalshi_market_ticker: string | null;
  kalshi_yes_price: number | null;
};

export type PredictionTodayPayload = {
  game_date: string;
  question: PredictionQuestionDto | null;
  voting_open: boolean;
  opens_at: string | null;
  cutoff_at: string | null;
  my_vote: { prediction: boolean; voted_at: string } | null;
  vote_counts: { will_happen: number; will_not_happen: number };
};

type QuestionRow = PredictionQuestionRow & {
  cutoff_at: Date;
  generated_at: Date;
  resolved_at: Date | null;
};

function isoDateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function mapQuestion(row: QuestionRow): PredictionQuestionDto {
  return {
    id: row.id,
    group_id: row.group_id,
    game_date: isoDateOnly(row.game_date),
    question_text: row.question_text,
    event_summary: row.event_summary,
    event_time_hint: row.event_time_hint,
    vote_yes_hint: row.vote_yes_hint,
    vote_no_hint: row.vote_no_hint,
    cutoff_at: row.cutoff_at.toISOString(),
    outcome: row.outcome,
    outcome_note: row.outcome_note,
    resolved_at: row.resolved_at?.toISOString() ?? null,
    llm_model: row.llm_model,
    generated_at: row.generated_at.toISOString(),
    kalshi_market_ticker: row.kalshi_market_ticker,
    kalshi_yes_price: row.kalshi_yes_price != null ? Number(row.kalshi_yes_price) : null,
  };
}

async function loadGroupName(groupId: string): Promise<string> {
  const { rows } = await query<{ name: string }>(`SELECT name FROM groups WHERE id = $1`, [groupId]);
  return rows[0]?.name ?? "your team";
}

async function loadQuestionByDate(groupId: string, gameDate: string): Promise<QuestionRow | null> {
  const { rows } = await query<QuestionRow>(
    `SELECT * FROM prediction_questions WHERE group_id = $1 AND game_date = $2::date`,
    [groupId, gameDate],
  );
  return rows[0] ?? null;
}

async function loadVoteCounts(questionId: string): Promise<{ will_happen: number; will_not_happen: number }> {
  const { rows } = await query<{ will_happen: string; will_not_happen: string }>(
    `SELECT
        COUNT(*) FILTER (WHERE prediction = TRUE)::text AS will_happen,
        COUNT(*) FILTER (WHERE prediction = FALSE)::text AS will_not_happen
       FROM prediction_votes
      WHERE question_id = $1`,
    [questionId],
  );
  return {
    will_happen: Number(rows[0]?.will_happen ?? 0),
    will_not_happen: Number(rows[0]?.will_not_happen ?? 0),
  };
}

export async function buildTodayPayload(
  groupId: string,
  userId: string,
  gameDate = predictionGameDate(),
): Promise<PredictionTodayPayload> {
  const question = await loadQuestionByDate(groupId, gameDate);
  const opensAt = predictionVoteOpenAt(gameDate);
  const defaultCutoff = predictionVoteCutoffAt(gameDate);
  if (!question) {
    return {
      game_date: gameDate,
      question: null,
      voting_open: isPredictionVotingOpen(opensAt, defaultCutoff),
      opens_at: opensAt.toISOString(),
      cutoff_at: defaultCutoff.toISOString(),
      my_vote: null,
      vote_counts: { will_happen: 0, will_not_happen: 0 },
    };
  }

  const { rows: voteRows } = await query<{ prediction: boolean; voted_at: Date }>(
    `SELECT prediction, voted_at FROM prediction_votes WHERE question_id = $1 AND user_id = $2`,
    [question.id, userId],
  );
  const voteCounts = await loadVoteCounts(question.id);

  return {
    game_date: gameDate,
    question: mapQuestion(question),
    voting_open: isPredictionVotingOpen(opensAt, question.cutoff_at),
    opens_at: opensAt.toISOString(),
    cutoff_at: question.cutoff_at.toISOString(),
    my_vote: voteRows[0]
      ? {
          prediction: voteRows[0].prediction,
          voted_at: voteRows[0].voted_at.toISOString(),
        }
      : null,
    vote_counts: voteCounts,
  };
}

export async function generateQuestionForGroup(
  groupId: string,
  generatedBy: string | null,
  gameDate = predictionGameDate(),
): Promise<PredictionQuestionDto> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const tenantName = await loadGroupName(groupId);

  let draft;
  let kalshiTicker: string | null = null;
  let kalshiYesPrice: number | null = null;

  try {
    const kalshiMarket = await pickKalshiMarketForGame(gameDate);
    if (kalshiMarket) {
      console.log(
        `[prediction-game] Kalshi pick ${kalshiMarket.ticker} (${kalshiMarket.category}) yes=${kalshiMarket.yes_price_pct}% vol=${kalshiMarket.volume_24h} ${kalshiMarket.kalshi_url}`,
      );
      draft = await rephraseKalshiMarket(kalshiMarket, tenantName);
      kalshiTicker = kalshiMarket.ticker;
      kalshiYesPrice = kalshiMarket.yes_price;
      if (!draft.event_time_hint?.trim()) {
        draft.event_time_hint = formatKalshiCloseHint(kalshiMarket.close_time);
      }
    } else {
      console.log("[prediction-game] no suitable Kalshi market — falling back to LLM invent");
      draft = await generatePredictionQuestion({
        tenantName,
        gameDate,
        gameDateLabel: predictionGameDateLabel(gameDate),
      });
    }
  } catch (kalshiErr) {
    console.warn("[prediction-game] Kalshi sourcing failed, falling back to LLM:", kalshiErr);
    draft = await generatePredictionQuestion({
      tenantName,
      gameDate,
      gameDateLabel: predictionGameDateLabel(gameDate),
    });
  }

  const cutoffAt = predictionVoteCutoffAt(gameDate);

  const { rows } = await query<QuestionRow>(
    `INSERT INTO prediction_questions (
        group_id, game_date, question_text, event_summary, event_time_hint,
        vote_yes_hint, vote_no_hint, cutoff_at, llm_model, generated_by,
        kalshi_market_ticker, kalshi_yes_price
      ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (group_id, game_date) DO UPDATE SET
        question_text = EXCLUDED.question_text,
        event_summary = EXCLUDED.event_summary,
        event_time_hint = EXCLUDED.event_time_hint,
        vote_yes_hint = EXCLUDED.vote_yes_hint,
        vote_no_hint = EXCLUDED.vote_no_hint,
        cutoff_at = EXCLUDED.cutoff_at,
        kalshi_market_ticker = EXCLUDED.kalshi_market_ticker,
        kalshi_yes_price = EXCLUDED.kalshi_yes_price,
        outcome = NULL,
        outcome_note = NULL,
        resolved_at = NULL,
        resolved_by = NULL,
        llm_model = EXCLUDED.llm_model,
        generated_at = NOW(),
        generated_by = EXCLUDED.generated_by
      RETURNING *`,
    [
      groupId,
      gameDate,
      draft.question_text,
      draft.event_summary,
      draft.event_time_hint,
      draft.vote_yes_hint,
      draft.vote_no_hint,
      cutoffAt,
      draft.model,
      generatedBy,
      kalshiTicker,
      kalshiYesPrice,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("failed to persist prediction question");

  await query(`DELETE FROM prediction_votes WHERE question_id = $1`, [row.id]);

  return mapQuestion(row);
}

export async function castPredictionVote(
  groupId: string,
  userId: string,
  prediction: boolean,
  gameDate = predictionGameDate(),
): Promise<PredictionTodayPayload> {
  const question = await loadQuestionByDate(groupId, gameDate);
  if (!question) {
    throw new PredictionGameError("no_question", "No prediction question for today yet.");
  }
  const opensAt = predictionVoteOpenAt(gameDate);
  if (isBeforePredictionVotingOpen(opensAt)) {
    throw new PredictionGameError("voting_not_open", "Voting opens at 9:00am Central.");
  }
  if (!isPredictionVotingOpen(opensAt, question.cutoff_at)) {
    throw new PredictionGameError("voting_closed", "Voting closed at 5:00pm Central.");
  }

  await query(
    `INSERT INTO prediction_votes (question_id, user_id, prediction)
     VALUES ($1, $2, $3)
     ON CONFLICT (question_id, user_id) DO UPDATE SET
       prediction = EXCLUDED.prediction,
       voted_at = NOW()`,
    [question.id, userId, prediction],
  );

  return buildTodayPayload(groupId, userId, gameDate);
}

export async function resolvePredictionQuestion(
  groupId: string,
  questionId: string,
  resolverId: string,
  outcome: boolean,
  note?: string,
): Promise<PredictionQuestionDto> {
  const trimmedNote = note?.trim() || null;
  const { rows } = await query<QuestionRow>(
    `UPDATE prediction_questions
        SET outcome = $1,
            outcome_note = $2,
            resolved_at = NOW(),
            resolved_by = $3
      WHERE id = $4 AND group_id = $5
      RETURNING *`,
    [outcome, trimmedNote, resolverId, questionId, groupId],
  );
  const row = rows[0];
  if (!row) throw new PredictionGameError("not_found", "Question not found.");
  return mapQuestion(row);
}

export type PredictionHistoryRow = PredictionQuestionDto & {
  vote_counts: { will_happen: number; will_not_happen: number };
};

export async function loadPredictionHistory(groupId: string, limit = 14): Promise<PredictionHistoryRow[]> {
  const { rows } = await query<QuestionRow>(
    `SELECT * FROM prediction_questions
      WHERE group_id = $1
      ORDER BY game_date DESC
      LIMIT $2`,
    [groupId, limit],
  );
  const out: PredictionHistoryRow[] = [];
  for (const row of rows) {
    const vote_counts = await loadVoteCounts(row.id);
    out.push({ ...mapQuestion(row), vote_counts });
  }
  return out;
}

export class PredictionGameError extends Error {
  constructor(
    public code: "no_question" | "voting_not_open" | "voting_closed" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PredictionGameError";
  }
}

export { PredictionQuestionParseError };
