import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { config } from "../config.js";
import {
  PREDICTION_GAME_TIMEZONE,
  predictionSettlementCompleteDeadlineAt,
  predictionSettlementWindowEndAt,
  predictionVoteCutoffAt,
  predictionVoteOpenAt,
} from "./predictionGameTime.js";

const DEFAULT_BASE = "https://external-api.kalshi.com/trade-api/v2";

/** Multivariate sports parlays — low-quality for a daily yes/no game. */
const MULTIVARIATE_PARLAY_RE = /KXMV-|MULTIGAME|KXMVESPORT/i;

const MAX_RETRIES = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 200;
/** Minimum spacing between Kalshi HTTP calls to reduce 429 rate limits. */
const MIN_REQUEST_INTERVAL_MS = 300;
const EVENT_META_CONCURRENCY = 3;

/** Priority labels for logging; Kalshi API category strings differ from labels. */
const CATEGORY_PRIORITY: Array<{ label: string; kalshiCategories: string[] }> = [
  { label: "Culture", kalshiCategories: ["Entertainment", "Culture"] },
  { label: "Sports", kalshiCategories: ["Sports"] },
  { label: "Politics", kalshiCategories: ["Politics"] },
];

/** Last-resort fallback when Culture / Sports / Politics have no qualifying markets. */
const FALLBACK_KALSHI_CATEGORIES = ["Economics", "World", "Elections", "Financials"];

export type KalshiMarketCandidate = {
  ticker: string;
  title: string;
  yes_sub_title: string;
  no_sub_title: string;
  close_time: string;
  expected_expiration_time: string;
  yes_price: number;
  yes_price_pct: number;
  volume_24h: number;
  open_interest: number;
  event_ticker: string;
  event_title: string;
  category: string;
  series_ticker: string;
  kalshi_url: string;
};

export type KalshiPickResult = {
  pick: KalshiMarketCandidate;
  category_counts: Record<string, number>;
};

export type GameDayTimeBounds = {
  /** 9:00 AM CT on game day — voting opens. */
  voteOpen: Date;
  /** 5:00 PM CT on game day — voting closes. */
  voteCutoff: Date;
  /** 11:59:59 PM CT on game day — upper bound for evening market close scans. */
  endOfDay: Date;
  /** 9:00 AM CT the morning after game day — resolution/settlement window end. */
  settlementWindowEnd: Date;
  /** Latest allowed settlement completion (expiration + settlement_timer lag). */
  settlementCompleteDeadline: Date;
};

type KalshiSeriesRaw = {
  ticker: string;
  title?: string;
  category?: string;
};

type KalshiMarketRaw = {
  ticker: string;
  title?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  close_time?: string;
  expected_expiration_time?: string | null;
  settlement_timer_seconds?: number;
  event_ticker?: string;
  last_price_dollars?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  volume_24h_fp?: string;
  open_interest_fp?: string;
  result?: string;
  status?: string;
};

type KalshiEventRaw = {
  event_ticker: string;
  title?: string;
  category?: string;
  series_ticker?: string;
  markets?: KalshiMarketRaw[];
};

type KalshiSeriesResponse = {
  series?: KalshiSeriesRaw[] | null;
  cursor?: string;
};

type KalshiEventsResponse = {
  events?: KalshiEventRaw[];
  cursor?: string;
};

type KalshiMarketsResponse = {
  markets?: KalshiMarketRaw[];
  cursor?: string;
};

type KalshiSingleEventResponse = {
  event?: KalshiEventRaw;
};

type QualifyingMarketInternal = {
  event_ticker: string;
  event_title: string;
  category: string;
  series_ticker: string;
  market: KalshiMarketRaw;
};

let kalshiRequestGate: Promise<void> = Promise.resolve();
let lastKalshiRequestAt = 0;

function kalshiBaseUrl(): string {
  return (config.kalshi?.apiBaseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoUtc(value: string): Date {
  return new Date(value);
}

function impliedYesPrice(m: KalshiMarketRaw): number {
  const last = parseFloat(m.last_price_dollars ?? "0");
  if (last > 0) return last;
  const bid = parseFloat(m.yes_bid_dollars ?? "0");
  const ask = parseFloat(m.yes_ask_dollars ?? "1");
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  if (bid > 0) return bid;
  if (ask > 0 && ask < 1) return ask;
  return 0.5;
}

function isParlayMarket(blob: string): boolean {
  return MULTIVARIATE_PARLAY_RE.test(blob);
}

/** DST-aware bounds for filtering markets on a prediction game calendar date. */
export function gameDayTimeBounds(gameDate: string): GameDayTimeBounds {
  const voteOpen = predictionVoteOpenAt(gameDate);
  const voteCutoff = predictionVoteCutoffAt(gameDate);
  const endOfDay = fromZonedTime(`${gameDate}T23:59:59`, PREDICTION_GAME_TIMEZONE);
  const settlementWindowEnd = predictionSettlementWindowEndAt(gameDate);
  const settlementCompleteDeadline = predictionSettlementCompleteDeadlineAt(gameDate);
  return { voteOpen, voteCutoff, endOfDay, settlementWindowEnd, settlementCompleteDeadline };
}

/** Markets that close while teammates can vote would leak the outcome mid-poll. */
function closesDuringVotingWindow(closeTime: Date, bounds: GameDayTimeBounds): boolean {
  return closeTime >= bounds.voteOpen && closeTime <= bounds.voteCutoff;
}

async function withKalshiThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const run = kalshiRequestGate.then(async () => {
    const waitMs = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastKalshiRequestAt);
    if (waitMs > 0) await sleep(waitMs);
    lastKalshiRequestAt = Date.now();
    return fn();
  });
  kalshiRequestGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function kalshiGet<T>(path: string, params: URLSearchParams): Promise<T> {
  const url = `${kalshiBaseUrl()}/${path}?${params.toString()}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const res = await withKalshiThrottle(() =>
        fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      );

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(
          `Kalshi API ${res.status}: ${await res.text().catch(() => res.statusText)}`,
        );
        await sleep(Math.min(30_000, 1500 * (attempt + 1)));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Kalshi API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(Math.min(30_000, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error("Kalshi API request failed");
}

async function paginateKalshi<T>(
  path: string,
  buildParams: (cursor?: string) => URLSearchParams,
  extract: (page: T) => { items: unknown[]; cursor?: string },
): Promise<unknown[]> {
  const all: unknown[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 200; page += 1) {
    const data = await kalshiGet<T>(path, buildParams(cursor));
    const { items, cursor: next } = extract(data);
    all.push(...items);
    if (!next || items.length === 0) break;
    cursor = next;
  }

  return all;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Fetch all series templates in a Kalshi API category (paginated).
 * Note: Kalshi uses "Entertainment" for culture-style content; "Culture" is often empty.
 */
export async function getSeriesByCategory(category: string): Promise<KalshiSeriesRaw[]> {
  const rows = await paginateKalshi<KalshiSeriesResponse>(
    "series",
    (cursor) => {
      const params = new URLSearchParams({ category, limit: String(PAGE_LIMIT) });
      if (cursor) params.set("cursor", cursor);
      return params;
    },
    (page) => ({
      items: page.series ?? [],
      cursor: page.cursor,
    }),
  );
  return rows as KalshiSeriesRaw[];
}

/**
 * Fetch open events (with nested markets) for a single series ticker (paginated).
 */
export async function getEventsForSeries(seriesTicker: string): Promise<KalshiEventRaw[]> {
  const rows = await paginateKalshi<KalshiEventsResponse>(
    "events",
    (cursor) => {
      const params = new URLSearchParams({
        series_ticker: seriesTicker,
        status: "open",
        with_nested_markets: "true",
        limit: String(PAGE_LIMIT),
      });
      if (cursor) params.set("cursor", cursor);
      return params;
    },
    (page) => ({
      items: page.events ?? [],
      cursor: page.cursor,
    }),
  );
  return rows as KalshiEventRaw[];
}

/**
 * Open markets whose close_time falls between vote cutoff and end of game day (paginated).
 * Narrows the search space before applying expiration/settlement filters.
 */
async function getMarketsClosingBetween(bounds: GameDayTimeBounds): Promise<KalshiMarketRaw[]> {
  const minCloseTs = Math.floor(bounds.voteCutoff.getTime() / 1000);
  const maxCloseTs = Math.floor(bounds.endOfDay.getTime() / 1000);
  const rows = await paginateKalshi<KalshiMarketsResponse>(
    "markets",
    (cursor) => {
      const params = new URLSearchParams({
        status: "open",
        limit: String(PAGE_LIMIT),
        min_close_ts: String(minCloseTs),
        max_close_ts: String(maxCloseTs),
      });
      if (cursor) params.set("cursor", cursor);
      return params;
    },
    (page) => ({
      items: page.markets ?? [],
      cursor: page.cursor,
    }),
  );
  return rows as KalshiMarketRaw[];
}

function marketQualifies(market: KalshiMarketRaw, bounds: GameDayTimeBounds): boolean {
  const closeRaw = market.close_time;
  const expectedRaw = market.expected_expiration_time;
  if (!closeRaw || !expectedRaw) return false;

  const closeTime = parseIsoUtc(closeRaw);
  const expectedExpiration = parseIsoUtc(expectedRaw);
  const settlementSeconds = Number(market.settlement_timer_seconds ?? 0);
  const settlementComplete = new Date(expectedExpiration.getTime() + settlementSeconds * 1000);

  if (closesDuringVotingWindow(closeTime, bounds)) return false;

  return (
    expectedExpiration > bounds.voteCutoff &&
    expectedExpiration <= bounds.settlementWindowEnd &&
    settlementComplete <= bounds.settlementCompleteDeadline
  );
}

/**
 * From open events with nested markets, return flat qualifying market rows.
 */
export function filterQualifyingMarkets(
  events: KalshiEventRaw[],
  bounds: GameDayTimeBounds,
): QualifyingMarketInternal[] {
  const out: QualifyingMarketInternal[] = [];

  for (const event of events) {
    const eventTicker = event.event_ticker;
    if (!eventTicker) continue;

    const markets = event.markets ?? [];
    for (const market of markets) {
      if (!market.ticker || !market.title?.trim()) continue;

      const blob = `${market.ticker} ${eventTicker} ${event.series_ticker ?? ""} ${market.title}`;
      if (isParlayMarket(blob)) continue;
      if (!marketQualifies(market, bounds)) continue;

      out.push({
        event_ticker: eventTicker,
        event_title: (event.title ?? market.title).trim(),
        category: (event.category ?? "").trim(),
        series_ticker: (event.series_ticker ?? "").trim(),
        market,
      });
    }
  }

  return out;
}

function filterQualifyingFlatMarkets(
  markets: KalshiMarketRaw[],
  bounds: GameDayTimeBounds,
): QualifyingMarketInternal[] {
  const out: QualifyingMarketInternal[] = [];

  for (const market of markets) {
    if (!market.ticker || !market.title?.trim()) continue;
    const eventTicker = market.event_ticker ?? "";
    const blob = `${market.ticker} ${eventTicker} ${market.title}`;
    if (isParlayMarket(blob)) continue;
    if (!marketQualifies(market, bounds)) continue;

    out.push({
      event_ticker: eventTicker,
      event_title: market.title.trim(),
      category: "",
      series_ticker: "",
      market,
    });
  }

  return out;
}

async function fetchEventMeta(eventTicker: string): Promise<KalshiEventRaw | null> {
  if (!eventTicker) return null;
  try {
    const data = await kalshiGet<KalshiSingleEventResponse>(
      `events/${encodeURIComponent(eventTicker)}`,
      new URLSearchParams(),
    );
    return data.event ?? null;
  } catch {
    return null;
  }
}

async function enrichCandidatesWithEventMeta(
  rows: QualifyingMarketInternal[],
): Promise<QualifyingMarketInternal[]> {
  const uniqueTickers = [...new Set(rows.map((r) => r.event_ticker).filter(Boolean))];
  const metaByTicker = new Map<string, KalshiEventRaw>();

  await mapWithConcurrency(uniqueTickers, EVENT_META_CONCURRENCY, async (ticker) => {
    const event = await fetchEventMeta(ticker);
    if (event) metaByTicker.set(ticker, event);
  });

  return rows.map((row) => {
    const meta = metaByTicker.get(row.event_ticker);
    if (!meta) return row;
    return {
      ...row,
      event_title: (meta.title ?? row.event_title).trim(),
      category: (meta.category ?? row.category).trim(),
      series_ticker: (meta.series_ticker ?? row.series_ticker).trim(),
    };
  });
}

function toCandidate(row: QualifyingMarketInternal): KalshiMarketCandidate {
  const m = row.market;
  const yes_price = impliedYesPrice(m);
  return {
    ticker: m.ticker,
    title: m.title!.trim(),
    yes_sub_title: (m.yes_sub_title ?? "Yes").trim(),
    no_sub_title: (m.no_sub_title ?? "No").trim(),
    close_time: m.close_time!,
    expected_expiration_time: m.expected_expiration_time!,
    yes_price,
    yes_price_pct: Math.round(yes_price * 100),
    volume_24h: parseFloat(m.volume_24h_fp ?? "0"),
    open_interest: parseFloat(m.open_interest_fp ?? "0"),
    event_ticker: row.event_ticker,
    event_title: row.event_title,
    category: row.category,
    series_ticker: row.series_ticker,
    kalshi_url: `https://kalshi.com/markets/${row.event_ticker}`,
  };
}

/** TODO: customize selection — currently highest 24h volume, then open interest. */
function pickBestCandidate(rows: QualifyingMarketInternal[]): KalshiMarketCandidate {
  const sorted = [...rows]
    .map(toCandidate)
    .sort((a, b) => {
      if (b.volume_24h !== a.volume_24h) return b.volume_24h - a.volume_24h;
      return b.open_interest - a.open_interest;
    });
  return sorted[0]!;
}

function matchesKalshiCategories(row: QualifyingMarketInternal, kalshiCategories: string[]): boolean {
  return kalshiCategories.includes(row.category);
}

function countByPriorityLabels(
  qualifying: QualifyingMarketInternal[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of CATEGORY_PRIORITY) {
    counts[entry.label] = qualifying.filter((row) =>
      matchesKalshiCategories(row, entry.kalshiCategories),
    ).length;
  }
  for (const kalshiCategory of FALLBACK_KALSHI_CATEGORIES) {
    counts[kalshiCategory] = qualifying.filter((row) => row.category === kalshiCategory).length;
  }
  return counts;
}

/**
 * Scan open markets closing after vote cutoff tonight, enrich with event category,
 * and return rows that pass expiration/settlement filters.
 */
async function collectQualifyingEveningMarkets(bounds: GameDayTimeBounds): Promise<QualifyingMarketInternal[]> {
  const eveningMarkets = await getMarketsClosingBetween(bounds);
  const qualifying = filterQualifyingFlatMarkets(eveningMarkets, bounds);
  console.log(
    `[kalshi] evening-close scan: ${eveningMarkets.length} markets, ${qualifying.length} qualifying before enrich`,
  );
  if (!qualifying.length) return [];
  return enrichCandidatesWithEventMeta(qualifying);
}

/**
 * Series-template scan (spec API flow). Serial per-series to avoid rate limits.
 * Prefer {@link collectQualifyingEveningMarkets} for the daily cron job.
 */
export async function collectQualifyingForKalshiCategoriesViaSeries(
  kalshiCategories: string[],
  bounds: GameDayTimeBounds,
): Promise<QualifyingMarketInternal[]> {
  const qualifying: QualifyingMarketInternal[] = [];

  for (const kalshiCategory of kalshiCategories) {
    const seriesList = await getSeriesByCategory(kalshiCategory);
    for (const series of seriesList) {
      const events = await getEventsForSeries(series.ticker);
      qualifying.push(...filterQualifyingMarkets(events, bounds));
    }
  }

  return qualifying;
}

/**
 * Pick one Kalshi event/market for today's prediction game.
 * Categories: Culture (Entertainment) → Sports → Politics → fallback list.
 */
export async function pickEventForToday(gameDate: string): Promise<KalshiPickResult | null> {
  const bounds = gameDayTimeBounds(gameDate);
  const qualifying = await collectQualifyingEveningMarkets(bounds);
  const category_counts = countByPriorityLabels(qualifying);

  for (const entry of CATEGORY_PRIORITY) {
    const inCategory = qualifying.filter((row) =>
      matchesKalshiCategories(row, entry.kalshiCategories),
    );
    if (inCategory.length > 0) {
      const pick = pickBestCandidate(inCategory);
      console.log(
        `[kalshi] pick ${pick.ticker} category=${entry.label} vol=${pick.volume_24h} url=${pick.kalshi_url}`,
      );
      console.log(`[kalshi] category candidate counts: ${JSON.stringify(category_counts)}`);
      return { pick, category_counts };
    }
  }

  for (const kalshiCategory of FALLBACK_KALSHI_CATEGORIES) {
    const inCategory = qualifying.filter((row) => row.category === kalshiCategory);
    if (inCategory.length > 0) {
      const pick = pickBestCandidate(inCategory);
      console.log(
        `[kalshi] pick ${pick.ticker} fallback=${kalshiCategory} vol=${pick.volume_24h} url=${pick.kalshi_url}`,
      );
      console.log(`[kalshi] category candidate counts: ${JSON.stringify(category_counts)}`);
      return { pick, category_counts };
    }
  }

  console.log(`[kalshi] no qualifying event for ${gameDate}`);
  console.log(`[kalshi] category candidate counts: ${JSON.stringify(category_counts)}`);
  return null;
}

/**
 * Back-compat entry point used by prediction game generation.
 */
export async function pickKalshiMarketForGame(gameDate: string): Promise<KalshiMarketCandidate | null> {
  const result = await pickEventForToday(gameDate);
  return result?.pick ?? null;
}

type KalshiSingleMarketResponse = {
  market?: KalshiMarketRaw;
};

export type KalshiMarketSettlement = {
  ticker: string;
  status: string;
  /** true = yes, false = no; null when unsettled or non-binary. */
  outcome: boolean | null;
};

/** Look up a settled Kalshi market outcome for auto-resolving prediction questions. */
export async function fetchKalshiMarketSettlement(ticker: string): Promise<KalshiMarketSettlement | null> {
  try {
    const data = await kalshiGet<KalshiSingleMarketResponse>(
      `markets/${encodeURIComponent(ticker)}`,
      new URLSearchParams(),
    );
    const m = data.market;
    if (!m?.ticker) return null;
    const result = String(m.result ?? "").trim().toLowerCase();
    const status = String(m.status ?? "").trim().toLowerCase();
    if (result === "yes") return { ticker: m.ticker, status, outcome: true };
    if (result === "no") return { ticker: m.ticker, status, outcome: false };
    return { ticker: m.ticker, status, outcome: null };
  } catch (err) {
    console.warn(`[kalshi] settlement lookup failed for ${ticker}:`, err);
    return null;
  }
}

export function formatKalshiCloseHint(closeTimeIso: string): string {
  return formatInTimeZone(new Date(closeTimeIso), PREDICTION_GAME_TIMEZONE, "h:mm a z");
}

/** CLI: `npx tsx src/lib/kalshiMarkets.ts [yyyy-MM-dd]` */
async function main(): Promise<void> {
  const gameDate = process.argv[2] ?? formatInTimeZone(new Date(), PREDICTION_GAME_TIMEZONE, "yyyy-MM-dd");
  const result = await pickEventForToday(gameDate);

  if (!result) {
    console.log("no qualifying event today");
    return;
  }

  const { pick, category_counts } = result;
  console.log(
    JSON.stringify(
      {
        event_ticker: pick.event_ticker,
        title: pick.event_title,
        category: pick.category,
        series_ticker: pick.series_ticker,
        market_ticker: pick.ticker,
        close_time: pick.close_time,
        expected_expiration_time: pick.expected_expiration_time,
        kalshi_url: pick.kalshi_url,
        volume_24h: pick.volume_24h,
        open_interest: pick.open_interest,
        category_counts,
      },
      null,
      2,
    ),
  );
}

const invokedDirectly =
  process.argv[1]?.includes("kalshiMarkets") || process.argv[1]?.endsWith("kalshiMarkets.ts");

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
