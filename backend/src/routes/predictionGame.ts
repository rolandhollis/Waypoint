import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import {
  loadGroupConstants,
  predictionGameRegenerateEnabled,
} from "../lib/groupConstants.js";
import {
  buildTodayPayload,
  castPredictionVote,
  generateQuestionForGroup,
  loadPredictionHistory,
  PredictionGameError,
  PredictionQuestionParseError,
  resolvePredictionQuestion,
} from "../lib/predictionGame.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

/**
 * Daily prediction game — LLM-authored yes/no questions about
 * real-world events; voting runs 9am–5pm Central.
 */
export const predictionGameRouter = Router();

predictionGameRouter.get("/today", async (req, res) => {
  const payload = await buildTodayPayload(req.groupId!, req.user!.id);
  res.json(payload);
});

predictionGameRouter.get("/history", async (req, res) => {
  const rows = await loadPredictionHistory(req.groupId!);
  res.json(rows);
});

const voteSchema = z.object({
  prediction: z.boolean(),
});

predictionGameRouter.post("/today/vote", async (req, res) => {
  const body = voteSchema.parse(req.body);
  try {
    const payload = await castPredictionVote(req.groupId!, req.user!.id, body.prediction);
    res.json(payload);
  } catch (err) {
    if (err instanceof PredictionGameError) {
      if (err.code === "no_question") throw new HttpError(404, err.message);
      if (err.code === "voting_not_open" || err.code === "voting_closed") {
        throw new HttpError(403, err.message);
      }
      throw new HttpError(400, err.message);
    }
    throw err;
  }
});

predictionGameRouter.post("/generate", requireAdmin, async (req, res) => {
  const groupConstants = await loadGroupConstants({ groupId: req.groupId! });
  if (!predictionGameRegenerateEnabled(groupConstants.get(req.groupId!) ?? {})) {
    throw new HttpError(
      403,
      "Manual prediction question generation is disabled for this workspace.",
    );
  }
  try {
    await generateQuestionForGroup(req.groupId!, req.user!.id);
    const payload = await buildTodayPayload(req.groupId!, req.user!.id);
    res.json(payload);
  } catch (err) {
    if (err instanceof Error && err.message.includes("ANTHROPIC_API_KEY")) {
      res.status(503).json({
        error: "Prediction game AI not configured — set ANTHROPIC_API_KEY",
      });
      return;
    }
    if (err instanceof PredictionQuestionParseError) {
      res.status(502).json({ error: "question generation failed", detail: err.message });
      return;
    }
    console.error("[prediction-game] generate failed", err);
    res.status(502).json({
      error: "question generation failed",
      detail: err instanceof Error ? err.message : "unknown error",
    });
  }
});

const resolveSchema = z.object({
  outcome: z.boolean(),
  note: z.string().max(2000).optional(),
});

const questionIdSchema = z.object({
  id: z.string().uuid(),
});

predictionGameRouter.post("/:id/resolve", requireAdmin, async (req, res) => {
  const { id } = questionIdSchema.parse(req.params);
  const body = resolveSchema.parse(req.body);
  try {
    const question = await resolvePredictionQuestion(
      req.groupId!,
      id,
      req.user!.id,
      body.outcome,
      body.note,
    );
    res.json(question);
  } catch (err) {
    if (err instanceof PredictionGameError && err.code === "not_found") {
      throw new HttpError(404, err.message);
    }
    throw err;
  }
});

/** Cron entry: generate today's question for every group. */
export async function generateDailyPredictionQuestions(): Promise<void> {
  const { rows } = await query<{ id: string; name: string }>(`SELECT id, name FROM groups`);
  for (const group of rows) {
    try {
      await generateQuestionForGroup(group.id, null);
      console.log(`[prediction-game] generated question for group=${group.name}`);
    } catch (err) {
      console.error(`[prediction-game] generate failed for group=${group.id}:`, err);
    }
  }
}
