import { subDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { config } from "../config.js";

export const PREDICTION_GAME_TIMEZONE = config.reportingTimezone;
export const PREDICTION_VOTE_OPEN_HOUR = 9;
export const PREDICTION_VOTE_OPEN_MINUTE = 0;
export const PREDICTION_VOTE_CUTOFF_HOUR = 17;
export const PREDICTION_VOTE_CUTOFF_MINUTE = 0;

/** Kalshi / resolution window extends to 9:00am CT the morning after game day. */
export const PREDICTION_SETTLEMENT_WINDOW_HOUR = 9;
export const PREDICTION_SETTLEMENT_WINDOW_MINUTE = 0;
/** Allow settlement_timer lag after expected expiration (Kalshi weather, etc.). */
export const PREDICTION_SETTLEMENT_COMPLETE_BUFFER_MINUTES = 60;

/** Calendar date (yyyy-MM-dd) for the prediction game in reporting TZ. */
export function predictionGameDate(now: Date = new Date()): string {
  return formatInTimeZone(now, PREDICTION_GAME_TIMEZONE, "yyyy-MM-dd");
}

/** Calendar date for the prediction game immediately before `gameDate`. */
export function previousPredictionGameDate(gameDate: string): string {
  const anchor = fromZonedTime(`${gameDate}T12:00:00`, PREDICTION_GAME_TIMEZONE);
  return formatInTimeZone(subDays(anchor, 1), PREDICTION_GAME_TIMEZONE, "yyyy-MM-dd");
}

/** Human-readable long date for prompts and UI. */
export function predictionGameDateLabel(gameDate: string): string {
  return formatInTimeZone(
    fromZonedTime(`${gameDate}T12:00:00`, PREDICTION_GAME_TIMEZONE),
    PREDICTION_GAME_TIMEZONE,
    "EEEE, MMMM d, yyyy",
  );
}

/** 9:00am CT on `gameDate` as a UTC instant. */
export function predictionVoteOpenAt(gameDate: string): Date {
  return fromZonedTime(
    `${gameDate}T${String(PREDICTION_VOTE_OPEN_HOUR).padStart(2, "0")}:${String(
      PREDICTION_VOTE_OPEN_MINUTE,
    ).padStart(2, "0")}:00`,
    PREDICTION_GAME_TIMEZONE,
  );
}

/** 5:00pm CT on `gameDate` as a UTC instant. */
export function predictionVoteCutoffAt(gameDate: string): Date {
  return fromZonedTime(
    `${gameDate}T${String(PREDICTION_VOTE_CUTOFF_HOUR).padStart(2, "0")}:${String(
      PREDICTION_VOTE_CUTOFF_MINUTE,
    ).padStart(2, "0")}:00`,
    PREDICTION_GAME_TIMEZONE,
  );
}

/** 9:00am CT on the calendar day after `gameDate`. */
export function predictionSettlementWindowEndAt(gameDate: string): Date {
  const noonCt = fromZonedTime(`${gameDate}T12:00:00`, PREDICTION_GAME_TIMEZONE);
  const nextDay = formatInTimeZone(
    new Date(noonCt.getTime() + 24 * 60 * 60 * 1000),
    PREDICTION_GAME_TIMEZONE,
    "yyyy-MM-dd",
  );
  return fromZonedTime(
    `${nextDay}T${String(PREDICTION_SETTLEMENT_WINDOW_HOUR).padStart(2, "0")}:${String(
      PREDICTION_SETTLEMENT_WINDOW_MINUTE,
    ).padStart(2, "0")}:00`,
    PREDICTION_GAME_TIMEZONE,
  );
}

/** Latest instant settlement may finish (expected expiration + settlement lag). */
export function predictionSettlementCompleteDeadlineAt(gameDate: string): Date {
  const end = predictionSettlementWindowEndAt(gameDate);
  return new Date(end.getTime() + PREDICTION_SETTLEMENT_COMPLETE_BUFFER_MINUTES * 60_000);
}

export function isPredictionVotingOpen(
  openAt: Date,
  cutoffAt: Date,
  now: Date = new Date(),
): boolean {
  return now >= openAt && now < cutoffAt;
}

export function isBeforePredictionVotingOpen(openAt: Date, now: Date = new Date()): boolean {
  return now < openAt;
}
