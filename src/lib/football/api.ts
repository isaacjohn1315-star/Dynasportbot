import type { Sql } from "@/lib/db";
import {
  HEARTBEAT_INTERVAL_SECONDS,
  MAX_IDS_PER_BATCH,
  apiBaseUrl,
  dailyBudget,
  detailMaxBatchesPerRun,
  footballApiKey,
  safetyReserve,
  secondsUntilUtcMidnight,
  utcDay,
} from "./config";
import {
  ApiAccountError,
  ApiBudgetExceededError,
  ApiFootballError,
  errorMessage,
} from "./errors";
import { getFlag, recordSystemEvent, setFlag } from "./store";
import type { ApiFixture, ApiLineup } from "./types";

/** Set once if the plan rejects the `ids` parameter, so we never retry it. */
const IDS_UNSUPPORTED_FLAG = "api_ids_param_unsupported";

/**
 * API-Football client with atomic, database-enforced daily request budget.
 *
 * Every request (heartbeat or detail) is reserved in Neon BEFORE it is sent,
 * so the free-plan limit of 100 requests/day can never be exceeded, even with
 * overlapping cron invocations.
 *
 * Verified against current API-Football v3 documentation:
 * - success envelope: { get, parameters, errors, results, paging, response }
 * - `errors` is `[]` on success but an OBJECT on failure, e.g.
 *   { "rateLimit": "..." }, { "token": "..." }, { "plan": "..." }, { "requests": "..." }
 * - an unsubscribed/suspended account answers with a NON-envelope body:
 *   { "access": "Your account is suspended, check on https://dashboard.api-football.com." }
 * - rate-limit headers: x-ratelimit-requests-limit / x-ratelimit-requests-remaining
 *   (daily) and X-RateLimit-Limit / X-RateLimit-Remaining (per minute)
 * - the `ids` parameter is NOT available on free plans -> single `?id=` is used
 */

async function reserveRequest(sql: Sql, kind: "heartbeat" | "detail"): Promise<void> {
  const day = utcDay();
  const budget = dailyBudget();

  await sql`insert into api_usage (day) values (${day}) on conflict (day) do nothing`;

  const rows = (
    kind === "heartbeat"
      ? await sql`
          update api_usage
          set requests_total = requests_total + 1,
              heartbeat_requests = heartbeat_requests + 1,
              updated_at = now()
          where day = ${day} and requests_total < ${budget}
          returning requests_total`
      : await sql`
          update api_usage
          set requests_total = requests_total + 1,
              detail_requests = detail_requests + 1,
              updated_at = now()
          where day = ${day} and requests_total < ${budget}
          returning requests_total`
  ) as { requests_total: number }[];

  if (!rows || rows.length === 0) {
    throw new ApiBudgetExceededError(
      `API-Football daily request budget exhausted (${budget} requests/day, free plan).`,
    );
  }
}

/**
 * Reconcile our local counter with the provider's own daily counter.
 * If the provider says fewer requests remain than we think, we trust the
 * provider and raise our usage so we can never overshoot the real quota.
 */
async function reconcileWithRateLimitHeaders(sql: Sql, res: Response): Promise<void> {
  const limitHeader = Number(res.headers.get("x-ratelimit-requests-limit") ?? NaN);
  const remainingHeader = Number(res.headers.get("x-ratelimit-requests-remaining") ?? NaN);
  if (!Number.isFinite(limitHeader) || !Number.isFinite(remainingHeader)) return;
  if (limitHeader <= 0 || remainingHeader < 0) return;

  const providerUsed = limitHeader - remainingHeader;
  if (!Number.isFinite(providerUsed) || providerUsed < 0) return;

  try {
    await sql`
      update api_usage
      set requests_total = greatest(requests_total, ${providerUsed}),
          updated_at = now()
      where day = ${utcDay()}`;
  } catch {
    // Never let reconciliation break a successful data fetch.
  }
}

function describeErrors(errors: unknown): string {
  try {
    return JSON.stringify(errors).slice(0, 300);
  } catch {
    return String(errors).slice(0, 300);
  }
}

/**
 * Classify an API-Football `errors` payload. Account/plan/credential problems
 * are permanent for this configuration and must stop further requests for the
 * run instead of burning the daily quota on retries.
 */
function throwForErrors(errors: Record<string, unknown>): never {
  const keys = Object.keys(errors).map((k) => k.toLowerCase());
  const text = describeErrors(errors);
  const permanentKeys = ["token", "access", "plan", "subscription", "bug"];
  if (keys.some((k) => permanentKeys.includes(k))) {
    throw new ApiAccountError(`API-Football access/plan problem: ${text}`);
  }
  if (keys.includes("requests")) {
    // Provider-side daily quota exhausted.
    throw new ApiBudgetExceededError(`API-Football daily quota reached: ${text}`);
  }
  if (keys.includes("ratelimit")) {
    throw new ApiFootballError(`API-Football per-minute rate limit: ${text}`);
  }
  throw new ApiFootballError(`API-Football returned errors: ${text}`);
}

async function callApiFootball<T>(sql: Sql, pathAndQuery: string): Promise<T[]> {
  const url = `${apiBaseUrl()}${pathAndQuery}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "x-apisports-key": footballApiKey(),
        accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    // Network failure / DNS / timeout: retryable, and the reserved budget slot
    // is deliberately not refunded (conservative accounting).
    throw new ApiFootballError(`API-Football request failed: ${errorMessage(error)}`);
  }

  await reconcileWithRateLimitHeaders(sql, res);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiFootballError(
      `API-Football returned a malformed body (HTTP ${res.status}).`,
    );
  }

  const payload = body as Record<string, unknown>;

  // Account suspended / not subscribed: the provider replies with a bare
  // { "access": "..." } object instead of the normal envelope. Without this
  // check the response would look like "no live fixtures" and the automation
  // would silently stop posting.
  if (typeof payload.access === "string") {
    throw new ApiAccountError(`API-Football account problem: ${payload.access.slice(0, 200)}`);
  }
  if (typeof payload.message === "string" && !("response" in payload)) {
    throw new ApiAccountError(`API-Football refused the request: ${payload.message.slice(0, 200)}`);
  }

  if (res.status === 429) {
    throw new ApiFootballError("API-Football per-minute rate limit (HTTP 429).");
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiAccountError(`API-Football rejected the credentials (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new ApiFootballError(`API-Football HTTP ${res.status}`);
  }

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    if (errors.length > 0) {
      throw new ApiFootballError(`API-Football returned errors: ${describeErrors(errors)}`);
    }
  } else if (errors && typeof errors === "object" && Object.keys(errors).length > 0) {
    throwForErrors(errors as Record<string, unknown>);
  }

  // `results: 0` with an empty array is a valid "nothing right now" answer.
  const response = payload.response;
  if (!Array.isArray(response)) {
    throw new ApiFootballError("API-Football response field was not an array.");
  }

  return response as T[];
}

/** True when the object has the minimum shape DynaSport needs from a fixture. */
export function isUsableFixture(value: unknown): value is ApiFixture {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiFixture>;
  const fixture = candidate.fixture;
  if (!fixture || typeof fixture !== "object") return false;
  if (typeof fixture.id !== "number" || !Number.isFinite(fixture.id)) return false;
  if (!fixture.status || typeof fixture.status !== "object") return false;
  return true;
}

/** Main heartbeat: all live fixtures across every competition API-Football returns. */
export async function fetchLiveFixtures(sql: Sql): Promise<ApiFixture[]> {
  await reserveRequest(sql, "heartbeat");
  const raw = await callApiFootball<unknown>(sql, "/fixtures?live=all");
  const fixtures = raw.filter(isUsableFixture);
  await recordSystemEvent(sql, "heartbeat_ok", `${fixtures.length} live fixture(s)`);
  return fixtures;
}

/**
 * Fetch full fixture detail. Per the official documentation, `/fixtures?id=`
 * and `/fixtures?ids=` embed the events, lineups, statistics and players
 * objects, so ONE request yields both events and the starting XI - there is
 * no need for a separate `/fixtures/lineups` call.
 *
 * `ids` accepts up to 20 fixtures in a single request. Some plans reject the
 * `ids` parameter; if that happens we remember it permanently and fall back
 * to single-id requests, so at most one request is ever spent discovering it.
 */
export async function fetchFixtureDetails(
  sql: Sql,
  ids: number[],
  maxRequests: number,
): Promise<{ fixtures: ApiFixture[]; requestsUsed: number }> {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id)))];
  if (unique.length === 0 || maxRequests <= 0) return { fixtures: [], requestsUsed: 0 };

  const fixtures: ApiFixture[] = [];
  let requestsUsed = 0;
  const idsUnsupported = (await getFlag(sql, IDS_UNSUPPORTED_FLAG)) === "true";

  if (!idsUnsupported && unique.length > 1) {
    const batch = unique.slice(0, MAX_IDS_PER_BATCH);
    await reserveRequest(sql, "detail");
    requestsUsed += 1;
    try {
      const raw = await callApiFootball<unknown>(sql, `/fixtures?ids=${batch.join("-")}`);
      return { fixtures: raw.filter(isUsableFixture), requestsUsed };
    } catch (error) {
      // Plan does not allow `ids`: record it and fall through to single ids.
      if (error instanceof ApiAccountError && /ids/i.test(error.message)) {
        await setFlag(sql, IDS_UNSUPPORTED_FLAG, "true");
      } else {
        throw error;
      }
    }
  }

  for (const id of unique) {
    if (requestsUsed >= maxRequests) break;
    await reserveRequest(sql, "detail");
    requestsUsed += 1;
    const raw = await callApiFootball<unknown>(sql, `/fixtures?id=${id}`);
    fixtures.push(...raw.filter(isUsableFixture));
  }

  return { fixtures, requestsUsed };
}

/**
 * Verified team metadata (country + national flag) for one team.
 * Documented response: /teams?id= -> { team: { id, name, code, country,
 * founded, national, logo }, venue: { ... } }.
 * Costs one budgeted request; callers must cache the result.
 */
export async function fetchTeamCountry(
  sql: Sql,
  teamId: number,
): Promise<{ teamId: number; name: string; country: string | null; national: boolean | null } | null> {
  if (!Number.isFinite(teamId)) return null;
  await reserveRequest(sql, "detail");
  const raw = await callApiFootball<unknown>(sql, `/teams?id=${teamId}`);
  const entry = raw.find(
    (e): e is Record<string, unknown> => Boolean(e) && typeof e === "object",
  ) as Record<string, unknown> | undefined;
  const team = entry?.team as Record<string, unknown> | undefined;
  if (!team || typeof team !== "object") return null;
  return {
    teamId,
    name: typeof team.name === "string" ? team.name : "",
    country: typeof team.country === "string" && team.country.trim() ? team.country.trim() : null,
    national: typeof team.national === "boolean" ? team.national : null,
  };
}

/** Starting XI embedded in a detail fixture response (no extra request). */
export function embeddedLineups(fixture: ApiFixture): ApiLineup[] {
  const raw = (fixture as ApiFixture & { lineups?: unknown }).lineups;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ApiLineup =>
      Boolean(entry) && typeof entry === "object" && Array.isArray((entry as ApiLineup).startXI),
  );
}

/**
 * How many detail requests this run may spend without starving the heartbeat:
 * today's remaining budget minus the heartbeat slots still needed before UTC midnight.
 */
async function usedRequestsToday(sql: Sql): Promise<number> {
  const day = utcDay();
  await sql`insert into api_usage (day) values (${day}) on conflict (day) do nothing`;
  const rows = (await sql`select requests_total from api_usage where day = ${day}`) as {
    requests_total: number | string;
  }[];
  return Number(rows[0]?.requests_total ?? 0);
}

export async function detailSlotsAvailable(sql: Sql): Promise<number> {
  const used = await usedRequestsToday(sql);
  // Reserve every heartbeat still due before the 00:00 UTC quota reset, plus
  // a configurable safety reserve for finish recovery work.
  const heartbeatReserve = Math.ceil(secondsUntilUtcMidnight() / HEARTBEAT_INTERVAL_SECONDS);
  const remainingForDetail = dailyBudget() - used - heartbeatReserve - safetyReserve();
  return Math.max(0, Math.min(remainingForDetail, detailMaxBatchesPerRun()));
}

/**
 * Critical recovery allowance. It may use the configured safety reserve, but
 * never a future heartbeat slot and never the hard 100/day cap. Used only for
 * authoritative final-status confirmation after a fixture leaves live=all.
 */
export async function criticalDetailSlotsAvailable(sql: Sql): Promise<number> {
  const used = await usedRequestsToday(sql);
  const heartbeatReserve = Math.ceil(secondsUntilUtcMidnight() / HEARTBEAT_INTERVAL_SECONDS);
  const remaining = dailyBudget() - used - heartbeatReserve;
  return Math.max(0, Math.min(remaining, detailMaxBatchesPerRun()));
}

export interface UsageToday {
  day: string;
  total: number;
  heartbeat: number;
  detail: number;
  budget: number;
}

export async function getUsageToday(sql: Sql): Promise<UsageToday> {
  const day = utcDay();
  await sql`insert into api_usage (day) values (${day}) on conflict (day) do nothing`;
  const rows = (await sql`
    select requests_total, heartbeat_requests, detail_requests
    from api_usage where day = ${day}`) as {
    requests_total: number | string;
    heartbeat_requests: number | string;
    detail_requests: number | string;
  }[];
  const row = rows[0];
  return {
    day,
    total: Number(row?.requests_total ?? 0),
    heartbeat: Number(row?.heartbeat_requests ?? 0),
    detail: Number(row?.detail_requests ?? 0),
    budget: dailyBudget(),
  };
}
