import type { Sql } from "@/lib/db";
import { DROP_RECOVERY_HOURS, DROPPED_AFTER_MINUTES, utcDay } from "./config";
import { errorMessage } from "./errors";
import type { CandidateEvent, FixtureSnapshot } from "./types";

/**
 * All Neon PostgreSQL persistence for DynaSport:
 * - api_usage        daily API-Football request budget accounting
 * - fixture_state    last known snapshot per fixture (lifecycle diffing)
 * - posted_events    deterministic event keys + atomic claim/post bookkeeping
 * - automation_runs  monitoring history for the dashboard
 */

let schemaReady = false;

export async function ensureSchema(sql: Sql): Promise<void> {
  if (schemaReady) return;

  await sql`
    create table if not exists api_usage (
      day text primary key,
      requests_total integer not null default 0,
      heartbeat_requests integer not null default 0,
      detail_requests integer not null default 0,
      updated_at timestamptz not null default now()
    )`;

  await sql`
    create table if not exists fixture_state (
      fixture_id bigint primary key,
      snapshot jsonb not null,
      status_short text,
      is_terminal boolean not null default false,
      kickoff_at timestamptz,
      last_seen timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;

  await sql`
    create table if not exists posted_events (
      event_key text primary key,
      fixture_id bigint not null,
      kind text not null,
      message text not null,
      status text not null default 'claimed',
      fb_post_id text,
      attempts integer not null default 0,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      posted_at timestamptz
    )`;

  await sql`
    create table if not exists automation_runs (
      id bigint generated always as identity primary key,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      status text not null default 'running',
      summary jsonb,
      error text
    )`;

  // Fixtures that vanished from the live list without a confirmed final
  // status. We never invent a result for these; they are surfaced instead.
  await sql`alter table fixture_state add column if not exists unresolved boolean not null default false`;

  // Links internal event-member claims to the complete Facebook post row. This
  // makes unknown-outcome reconciliation exact and non-destructive.
  await sql`alter table posted_events add column if not exists parent_key text`;

  await sql`
    create table if not exists system_events (
      id bigint generated always as identity primary key,
      kind text not null,
      detail text,
      created_at timestamptz not null default now()
    )`;

  await sql`
    create table if not exists team_countries (
      team_id bigint primary key,
      name text,
      country text,
      national boolean,
      updated_at timestamptz not null default now()
    )`;

  await sql`
    create table if not exists app_flags (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    )`;

  await sql`create index if not exists system_events_kind_idx on system_events (kind, created_at desc)`;
  await sql`create index if not exists fixture_state_live_idx on fixture_state (is_terminal, last_seen)`;
  await sql`create index if not exists posted_events_status_idx on posted_events (status, updated_at desc)`;

  // Housekeeping: forget fixtures long finished so the table stays lean.
  await sql`delete from fixture_state where kickoff_at is not null and kickoff_at < now() - interval '14 days'`;

  schemaReady = true;
}

/* ------------------------------- Fixture state ------------------------------- */

export interface StateRow {
  snapshot: FixtureSnapshot;
  isTerminal: boolean;
}

export async function countTrackedFixtures(sql: Sql): Promise<number> {
  const rows = (await sql`select count(*) as n from fixture_state`) as { n: number | string }[];
  return Number(rows[0]?.n ?? 0);
}

export async function loadStates(sql: Sql, ids: number[]): Promise<Map<number, StateRow>> {
  const map = new Map<number, StateRow>();
  if (ids.length === 0) return map;
  const rows = (await sql`
    select fixture_id, snapshot, is_terminal
    from fixture_state
    where fixture_id in (
      select (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::bigint
    )`) as { fixture_id: number | string; snapshot: FixtureSnapshot; is_terminal: boolean }[];
  for (const row of rows) {
    map.set(Number(row.fixture_id), { snapshot: row.snapshot, isTerminal: row.is_terminal });
  }
  return map;
}

/** Fixtures we were tracking as live that vanished from "live=all" and might have ended. */
export async function loadDroppedFixtureIds(sql: Sql, liveIds: Set<number>): Promise<number[]> {
  const rows = (await sql`
    select fixture_id
    from fixture_state
    where is_terminal = false
      and last_seen < now() - (${DROPPED_AFTER_MINUTES} * interval '1 minute')
      and kickoff_at > now() - (${DROP_RECOVERY_HOURS} * interval '1 hour')
    order by last_seen asc
    limit 60`) as { fixture_id: number | string }[];
  return rows.map((r) => Number(r.fixture_id)).filter((id) => !liveIds.has(id));
}

export async function upsertSnapshot(
  sql: Sql,
  snapshot: FixtureSnapshot,
  isTerminal: boolean,
): Promise<void> {
  await sql`
    insert into fixture_state (fixture_id, snapshot, status_short, is_terminal, kickoff_at, last_seen, updated_at)
    values (
      ${snapshot.fixtureId},
      ${JSON.stringify(snapshot)}::jsonb,
      ${snapshot.statusShort},
      ${isTerminal},
      ${snapshot.kickoffAt},
      now(),
      now()
    )
    on conflict (fixture_id) do update set
      snapshot = excluded.snapshot,
      status_short = excluded.status_short,
      is_terminal = excluded.is_terminal,
      kickoff_at = excluded.kickoff_at,
      last_seen = now(),
      updated_at = now()`;
}

/* ------------------------------ Event claiming ------------------------------ */

export type ClaimResult = "claimed" | "retry" | "duplicate";

const MAX_EVENT_ATTEMPTS = 5;

/**
 * Atomic claim in Neon: the unique event_key guarantees one Facebook post per
 * real football event. Failed events stay retryable (never marked posted).
 */
export async function claimEvent(
  sql: Sql,
  candidate: CandidateEvent,
  message: string,
): Promise<ClaimResult> {
  const inserted = (await sql`
    insert into posted_events (event_key, fixture_id, kind, message, status, attempts, updated_at)
    values (${candidate.eventKey}, ${candidate.fixtureId}, ${candidate.kind}, ${message}, 'claimed', 1, now())
    on conflict (event_key) do nothing
    returning event_key`) as { event_key: string }[];
  if (inserted.length > 0) return "claimed";

  // Existing key: allow retry only if the previous attempts failed (never if posted).
  const reclaimed = (await sql`
    update posted_events
    set status = 'claimed',
        attempts = attempts + 1,
        message = ${message},
        last_error = null,
        updated_at = now()
    where event_key = ${candidate.eventKey}
      and status in ('failed', 'blocked')
      and (status = 'blocked' or attempts < ${MAX_EVENT_ATTEMPTS})
    returning event_key`) as { event_key: string }[];
  return reclaimed.length > 0 ? "retry" : "duplicate";
}

export async function markEventPosted(sql: Sql, eventKey: string, fbPostId: string): Promise<void> {
  await sql`
    update posted_events
    set status = 'posted',
        fb_post_id = ${fbPostId},
        last_error = null,
        posted_at = now(),
        updated_at = now()
    where event_key = ${eventKey}`;
}

export async function markEventFailed(sql: Sql, eventKey: string, error: unknown): Promise<void> {
  await sql`
    update posted_events
    set status = 'failed',
        last_error = ${errorMessage(error)},
        updated_at = now()
    where event_key = ${eventKey}`;
}

/** Unknown Graph POST outcome: do not retry until feed reconciliation. */
export async function markEventUncertain(sql: Sql, eventKey: string, error: unknown): Promise<void> {
  await sql`
    update posted_events
    set status = 'uncertain',
        last_error = ${errorMessage(error)},
        updated_at = now()
    where event_key = ${eventKey} and status <> 'posted'`;
}

export interface UncertainEvent {
  eventKey: string;
  fixtureId: number;
  kind: string;
  message: string;
  updatedAt: string;
}

export async function loadUncertainEvents(sql: Sql, limit = 50): Promise<UncertainEvent[]> {
  const rows = (await sql`
    select event_key, fixture_id, kind, message, updated_at
    from posted_events
    where status = 'uncertain'
    order by updated_at asc
    limit ${Math.max(1, Math.min(limit, 100))}`) as {
    event_key: string;
    fixture_id: number | string;
    kind: string;
    message: string;
    updated_at: string;
  }[];
  return rows.map((row) => ({
    eventKey: row.event_key,
    fixtureId: Number(row.fixture_id),
    kind: row.kind,
    message: row.message,
    updatedAt: row.updated_at,
  }));
}

/* ----------------------- Grouped update member claiming ----------------------- */

/** Current bookkeeping status for a set of event keys. */
export async function getEventStatuses(sql: Sql, keys: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (keys.length === 0) return map;
  const rows = (await sql`
    select event_key, status
    from posted_events
    where event_key in (
      select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)
    )`) as { event_key: string; status: string }[];
  for (const row of rows) map.set(row.event_key, row.status);
  return map;
}

/**
 * Atomically claim one member event: fresh insert, or safe re-claim of a
 * previously failed attempt. Returns false when the key is already posted,
 * in-flight, or exhausted its retries.
 */
export async function tryClaimKey(
  sql: Sql,
  eventKey: string,
  fixtureId: number,
  kind: string,
  message: string,
): Promise<boolean> {
  const inserted = (await sql`
    insert into posted_events (event_key, fixture_id, kind, message, status, attempts, updated_at)
    values (${eventKey}, ${fixtureId}, ${kind}, ${message}, 'claimed', 1, now())
    on conflict (event_key) do nothing
    returning event_key`) as { event_key: string }[];
  if (inserted.length > 0) return true;

  const reclaimed = (await sql`
    update posted_events
    set status = 'claimed',
        attempts = attempts + 1,
        message = ${message},
        last_error = null,
        updated_at = now()
    where event_key = ${eventKey}
      and status in ('failed', 'blocked')
      and (status = 'blocked' or attempts < ${MAX_EVENT_ATTEMPTS})
    returning event_key`) as { event_key: string }[];
  return reclaimed.length > 0;
}

/** Mark several member keys posted after their grouped post succeeded. */
export async function markKeysPosted(sql: Sql, keys: string[], fbPostId: string): Promise<void> {
  for (const key of keys) {
    await sql`
      update posted_events
      set status = 'posted',
          fb_post_id = ${fbPostId},
          last_error = null,
          posted_at = now(),
          updated_at = now()
      where event_key = ${key} and status in ('claimed', 'uncertain')`;
  }
}

/** A grouped post with the identical member set already exists: reconcile members. */
export async function reconcileKeysPosted(sql: Sql, keys: string[]): Promise<void> {
  for (const key of keys) {
    await sql`
      update posted_events
      set status = 'posted', updated_at = now(), posted_at = coalesce(posted_at, now())
      where event_key = ${key} and status = 'claimed'`;
  }
}

/** Mark several member keys failed after their grouped post failed (retryable). */
export async function markKeysFailed(sql: Sql, keys: string[], error: unknown): Promise<void> {
  const message = errorMessage(error);
  for (const key of keys) {
    await sql`
      update posted_events
      set status = 'failed', last_error = ${message}, updated_at = now()
      where event_key = ${key} and status = 'claimed'`;
  }
}

export async function markKeysUncertain(sql: Sql, keys: string[], error: unknown): Promise<void> {
  const message = errorMessage(error);
  for (const key of keys) {
    await sql`
      update posted_events
      set status = 'uncertain', last_error = ${message}, updated_at = now()
      where event_key = ${key} and status = 'claimed'`;
  }
}

/** Reconciliation confirmed no Page post: release member rows for retry. */
export async function releaseUncertainKeys(sql: Sql, keys: string[]): Promise<void> {
  for (const key of keys) {
    await sql`
      update posted_events
      set status = 'failed',
          last_error = 'Facebook feed reconciliation found no matching post',
          updated_at = now()
      where event_key = ${key} and status = 'uncertain'`;
  }
}

export async function linkMemberKeysToParent(
  sql: Sql,
  keys: string[],
  parentKey: string,
): Promise<void> {
  for (const key of keys) {
    await sql`
      update posted_events
      set parent_key = ${parentKey}, updated_at = now()
      where event_key = ${key}`;
  }
}

export async function loadChildEventKeys(sql: Sql, parentKey: string): Promise<string[]> {
  const rows = (await sql`
    select event_key from posted_events where parent_key = ${parentKey}`) as {
    event_key: string;
  }[];
  return rows.map((row) => row.event_key);
}

/** Repair child claims after a confirmed parent was posted but child updates failed. */
export async function reconcilePostedChildren(sql: Sql): Promise<number> {
  const rows = (await sql`
    update posted_events child
    set status = 'posted',
        fb_post_id = parent.fb_post_id,
        last_error = null,
        posted_at = coalesce(child.posted_at, parent.posted_at, now()),
        updated_at = now()
    from posted_events parent
    where child.parent_key = parent.event_key
      and parent.status = 'posted'
      and child.status <> 'posted'
    returning child.event_key`) as { event_key: string }[];
  return rows.length;
}

/* --------------------- Stale claims + retry queue (no API cost) --------------------- */

/**
 * A run can die mid-flight (Vercel timeout, crash) after claiming an event but
 * before posting it. Those rows would stay 'claimed' forever and the event
 * would be lost, because snapshot diffing has already moved on. Release them
 * back to 'failed' so the retry sweep can pick them up.
 */
export async function reapStaleClaims(sql: Sql, olderThanMinutes = 10): Promise<number> {
  const rows = (await sql`
    update posted_events
    set status = 'uncertain',
        last_error = coalesce(
          last_error,
          'claim expired with unknown delivery outcome; feed reconciliation required'
        ),
        updated_at = now()
    where status = 'claimed'
      and updated_at < now() - (${olderThanMinutes} * interval '1 minute')
    returning event_key`) as { event_key: string }[];
  return rows.length;
}

export interface RetryableEvent {
  eventKey: string;
  fixtureId: number;
  kind: string;
  message: string;
  attempts: number;
}

/**
 * Events whose Facebook publish failed. Snapshot diffing will not re-create
 * them, so they are retried from the stored message - bounded by attempts and
 * by age, and skipping permanent failures.
 */
export async function loadRetryableEvents(sql: Sql, limit: number): Promise<RetryableEvent[]> {
  if (limit <= 0) return [];
  const rows = (await sql`
    select event_key, fixture_id, kind, message, attempts
    from posted_events
    where status in ('failed', 'blocked')
      and (status = 'blocked' or attempts < ${MAX_EVENT_ATTEMPTS})
      and created_at > now() - interval '24 hours'
      and coalesce(last_error, '') not like 'PERMANENT:%'
      -- Member rows are internal deduplication claims. Their message is only
      -- one event line, not a complete valid Facebook post; only composite
      -- candidate rows may enter the delivery retry queue.
      and kind not in (
        'goal','penalty_goal','own_goal','missed_penalty','yellow_card','red_card',
        'substitution','var_red_upgrade','var_goal_disallowed','var_goal_awarded',
        'var_penalty_awarded','var_penalty_overturned','var_review'
      )
    -- Milestones (FT, HT, kick-off, shootout, terminal statuses) are retried
    -- before ordinary events: a backlog of old failed goals must never crowd
    -- a failed full-time post out of the limited retry window.
    order by
      case when kind in (
        'fulltime','halftime','second_half','kickoff','extra_time',
        'extra_time_break','penalty_shootout','shootout_update','postponed',
        'cancelled','abandoned','suspended','interrupted','awarded','walkover'
      ) then 0 else 1 end asc,
      created_at asc
    limit ${limit}`) as {
    event_key: string;
    fixture_id: number | string;
    kind: string;
    message: string;
    attempts: number | string;
  }[];
  return rows.map((r) => ({
    eventKey: r.event_key,
    fixtureId: Number(r.fixture_id),
    kind: r.kind,
    message: r.message,
    attempts: Number(r.attempts ?? 0),
  }));
}

/** Re-claim a specific failed event for one more publishing attempt. */
export async function claimRetry(sql: Sql, eventKey: string): Promise<boolean> {
  const rows = (await sql`
    update posted_events
    set status = 'claimed', attempts = attempts + 1, updated_at = now()
    where event_key = ${eventKey}
      and status in ('failed', 'blocked')
      and (status = 'blocked' or attempts < ${MAX_EVENT_ATTEMPTS})
    returning event_key`) as { event_key: string }[];
  return rows.length > 0;
}

/** Mark an event permanently undeliverable (never retried again). */
export async function markEventPermanentlyFailed(
  sql: Sql,
  eventKey: string,
  error: unknown,
): Promise<void> {
  await sql`
    update posted_events
    set status = 'failed',
        attempts = ${MAX_EVENT_ATTEMPTS},
        last_error = ${`PERMANENT: ${errorMessage(error)}`.slice(0, 500)},
        updated_at = now()
    where event_key = ${eventKey}`;
}

/**
 * Credential failure: keep the event queued (never retired) so it is
 * delivered as soon as a valid Page access token is configured.
 */
export async function markEventAuthBlocked(sql: Sql, eventKey: string, error: unknown): Promise<void> {
  await sql`
    update posted_events
    set status = 'blocked',
        last_error = ${errorMessage(error)},
        updated_at = now()
    where event_key = ${eventKey} and status <> 'posted'`;
}

export async function markKeysAuthBlocked(sql: Sql, keys: string[], error: unknown): Promise<void> {
  const message = errorMessage(error);
  for (const key of keys) {
    await sql`
      update posted_events
      set status = 'blocked', last_error = ${message}, updated_at = now()
      where event_key = ${key} and status = 'claimed'`;
  }
}

/* ----------------------------- Diagnostics ----------------------------- */

export type SystemEventKind =
  | "heartbeat_ok"
  | "facebook_delivered"
  | "facebook_auth_error"
  | "api_error"
  /** An API event type or status the formatter does not recognise (kept for review). */
  | "unknown_event"
  | "unknown_status";

export async function recordSystemEvent(
  sql: Sql,
  kind: SystemEventKind,
  detail?: string | null,
): Promise<void> {
  try {
    await sql`insert into system_events (kind, detail) values (${kind}, ${detail ?? null})`;
    // Keep the diagnostics table small.
    await sql`
      delete from system_events
      where kind = ${kind}
        and created_at < now() - interval '7 days'`;
  } catch {
    // Diagnostics must never break the automation.
  }
}

export async function getFlag(sql: Sql, key: string): Promise<string | null> {
  try {
    const rows = (await sql`select value from app_flags where key = ${key}`) as { value: string }[];
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function setFlag(sql: Sql, key: string, value: string): Promise<void> {
  try {
    await sql`
      insert into app_flags (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch {
    // Flags are an optimisation only.
  }
}

/** Mark fixtures that disappeared from the live list without a confirmed end. */
export async function markUnresolved(sql: Sql, ids: number[], unresolved: boolean): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    update fixture_state
    set unresolved = ${unresolved}, updated_at = now()
    where fixture_id in (
      select (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::bigint
    )`;
}

/* ------------------------------- Run history ------------------------------- */

export async function startRun(sql: Sql, startedAtIso: string): Promise<number> {
  const rows = (await sql`
    insert into automation_runs (started_at, status)
    values (${startedAtIso}, 'running')
    returning id`) as { id: number | string }[];
  return Number(rows[0]?.id ?? 0);
}

export async function finishRun(
  sql: Sql,
  id: number,
  status: "success" | "partial" | "failed" | "skipped",
  summary: unknown,
  error: string | null,
): Promise<void> {
  if (!id) return;
  await sql`
    update automation_runs
    set finished_at = now(),
        status = ${status},
        summary = ${JSON.stringify(summary ?? {})}::jsonb,
        error = ${error}
    where id = ${id}`;
}

/* --------------------------------- Dashboard --------------------------------- */

export interface DashboardRun {
  id: number;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  summary: Record<string, unknown> | null;
  error: string | null;
}

export interface DashboardEvent {
  eventKey: string;
  fixtureId: number;
  kind: string;
  message: string;
  status: string;
  fbPostId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
  postedAt: string | null;
  updatedAt: string | null;
}

export interface DashboardUsage {
  day: string;
  total: number;
  heartbeat: number;
  detail: number;
}

export interface DashboardData {
  usage: DashboardUsage | null;
  liveNow: number;
  postedToday: number;
  failedEvents: number;
  blockedEvents: number;
  postedTotal: number;
  unresolvedFixtures: number;
  lastHeartbeatAt: string | null;
  lastDeliveryAt: string | null;
  lastFacebookAuthError: { detail: string | null; at: string | null } | null;
  lastApiError: { detail: string | null; at: string | null } | null;
  runs: DashboardRun[];
  events: DashboardEvent[];
}

export async function loadDashboardData(sql: Sql): Promise<DashboardData> {
  await ensureSchema(sql);
  const day = utcDay();

  const usageRows = (await sql`
    select day, requests_total, heartbeat_requests, detail_requests
    from api_usage where day = ${day}`) as {
    day: string;
    requests_total: number | string;
    heartbeat_requests: number | string;
    detail_requests: number | string;
  }[];

  const liveRows = (await sql`
    select count(*) as n from fixture_state
    where is_terminal = false and last_seen > now() - interval '30 minutes'`) as {
    n: number | string;
  }[];

  const postedTodayRows = (await sql`
    select count(*) as n from posted_events
    where status = 'posted'
      and posted_at is not null
      and (posted_at at time zone 'utc')::date = (now() at time zone 'utc')::date`) as {
    n: number | string;
  }[];

  const failedRows = (await sql`
    select count(*) as n from posted_events where status = 'failed'`) as { n: number | string }[];

  const blockedRows = (await sql`
    select count(*) as n from posted_events where status = 'blocked'`) as { n: number | string }[];

  const unresolvedRows = (await sql`
    select count(*) as n from fixture_state where unresolved = true`) as { n: number | string }[];

  const lastOf = async (kind: SystemEventKind) =>
    (await sql`
      select detail, created_at from system_events
      where kind = ${kind} order by created_at desc limit 1`) as {
      detail: string | null;
      created_at: string | null;
    }[];

  const [heartbeatRow, deliveryRow, fbAuthRow, apiErrRow] = await Promise.all([
    lastOf("heartbeat_ok"),
    lastOf("facebook_delivered"),
    lastOf("facebook_auth_error"),
    lastOf("api_error"),
  ]);

  const postedTotalRows = (await sql`
    select count(*) as n from posted_events where status = 'posted'`) as { n: number | string }[];

  const runRows = (await sql`
    select id, started_at, finished_at, status, summary, error
    from automation_runs
    order by started_at desc
    limit 12`) as {
    id: number | string;
    started_at: string | null;
    finished_at: string | null;
    status: string;
    summary: Record<string, unknown> | null;
    error: string | null;
  }[];

  const eventRows = (await sql`
    select event_key, fixture_id, kind, message, status, fb_post_id, attempts, last_error, created_at, posted_at, updated_at
    from posted_events
    order by updated_at desc
    limit 25`) as {
    event_key: string;
    fixture_id: number | string;
    kind: string;
    message: string;
    status: string;
    fb_post_id: string | null;
    attempts: number | string;
    last_error: string | null;
    created_at: string | null;
    posted_at: string | null;
    updated_at: string | null;
  }[];

  const usage = usageRows[0]
    ? {
        day: usageRows[0].day,
        total: Number(usageRows[0].requests_total ?? 0),
        heartbeat: Number(usageRows[0].heartbeat_requests ?? 0),
        detail: Number(usageRows[0].detail_requests ?? 0),
      }
    : null;

  return {
    usage,
    liveNow: Number(liveRows[0]?.n ?? 0),
    postedToday: Number(postedTodayRows[0]?.n ?? 0),
    failedEvents: Number(failedRows[0]?.n ?? 0),
    blockedEvents: Number(blockedRows[0]?.n ?? 0),
    postedTotal: Number(postedTotalRows[0]?.n ?? 0),
    unresolvedFixtures: Number(unresolvedRows[0]?.n ?? 0),
    lastHeartbeatAt: heartbeatRow[0]?.created_at ?? null,
    lastDeliveryAt: deliveryRow[0]?.created_at ?? null,
    lastFacebookAuthError: fbAuthRow[0]
      ? { detail: fbAuthRow[0].detail, at: fbAuthRow[0].created_at }
      : null,
    lastApiError: apiErrRow[0] ? { detail: apiErrRow[0].detail, at: apiErrRow[0].created_at } : null,
    runs: runRows.map((r) => ({
      id: Number(r.id),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      summary: r.summary,
      error: r.error,
    })),
    events: eventRows.map((r) => ({
      eventKey: r.event_key,
      fixtureId: Number(r.fixture_id),
      kind: r.kind,
      message: r.message,
      status: r.status,
      fbPostId: r.fb_post_id,
      attempts: Number(r.attempts ?? 0),
      lastError: r.last_error,
      createdAt: r.created_at,
      postedAt: r.posted_at,
      updatedAt: r.updated_at,
    })),
  };
}
