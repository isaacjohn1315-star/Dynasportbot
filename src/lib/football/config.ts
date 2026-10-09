import { ConfigError } from "./errors";

/**
 * API-Football free plan allows 100 requests/day in total.
 * The 15-minute heartbeat ("fixtures?live=all") can use at most 96 of those,
 * and every detail/lineup request must share the same 100/day budget.
 * This limit is hard-coded: it can never be raised by configuration.
 */
export const HARD_DAILY_LIMIT = 100;
export const HEARTBEAT_INTERVAL_SECONDS = 15 * 60;

export function apiBaseUrl(): string {
  const base = process.env.FOOTBALL_API_BASE_URL ?? "https://v3.football.api-sports.io";
  return base.replace(/\/+$/, "");
}

export function footballApiKey(): string {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) {
    throw new ConfigError("FOOTBALL_API_KEY is not configured");
  }
  return key;
}

/** Daily API request budget. Defaults to 100 and is hard-capped at 100. */
export function dailyBudget(): number {
  const raw = Number(process.env.FOOTBALL_API_DAILY_BUDGET ?? HARD_DAILY_LIMIT);
  if (!Number.isFinite(raw) || raw <= 0) return HARD_DAILY_LIMIT;
  return Math.min(Math.floor(raw), HARD_DAILY_LIMIT);
}

/**
 * Requests held back from optional/detail work for recovery and unexpected
 * calls. Optional override: FOOTBALL_API_SAFETY_RESERVE (default 2).
 */
export function safetyReserve(): number {
  const raw = Number(process.env.FOOTBALL_API_SAFETY_RESERVE ?? 2);
  if (!Number.isFinite(raw) || raw < 0) return 2;
  return Math.min(Math.floor(raw), 20);
}

/**
 * Free plan per-minute cap is 10 requests/min. One automation run sends at
 * most a handful of requests, so this is a guard rail, not a throttle.
 */
export const MAX_REQUESTS_PER_RUN = 6;

/** API-Football accepts up to 20 fixture ids in one `?ids=` request. */
export const MAX_IDS_PER_BATCH = 20;

/** Max detail requests ("fixtures?id=..." / lineups) per automation run. */
export function detailMaxBatchesPerRun(): number {
  const raw = Number(process.env.FOOTBALL_API_DETAIL_MAX_BATCHES ?? 1);
  if (!Number.isFinite(raw) || raw < 0) return 1;
  return Math.min(Math.floor(raw), 5);
}

/** Total Facebook posts allowed per automation run (protects the Page from bursts). */
export const MAX_POSTS_PER_RUN = 40;

/** Delay between consecutive Facebook posts. */
export const POST_DELAY_MS = 300;

/** Milliseconds between cron heartbeats before a missing live fixture is treated as dropped. */
export const DROPPED_AFTER_MINUTES = 3;

/** Stop trying to recover dropped fixtures once they are this old. */
export const DROP_RECOVERY_HOURS = 30;

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Seconds until next UTC midnight - used to reserve tomorrow's in-day heartbeat slots. */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(0, Math.floor((midnight.getTime() - now.getTime()) / 1000));
}
