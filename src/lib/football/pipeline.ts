import { getDb } from "@/lib/db";
import { MAX_POSTS_PER_RUN, POST_DELAY_MS, dailyBudget, detailMaxBatchesPerRun } from "./config";
import {
  ApiAccountError,
  ApiBudgetExceededError,
  errorMessage,
  isAuthFailure,
  isUndeliverable,
} from "./errors";
import {
  detailSlotsAvailable,
  embeddedLineups,
  fetchFixtureDetails,
  fetchLiveFixtures,
  fetchTeamCountry,
  getUsageToday,
} from "./api";
import { isFacebookConfigured, postToFacebookPage } from "./facebook";
import {
  buildSnapshot,
  competitionTier,
  diffFixture,
  safeEvents,
  isKnownEventType,
  isKnownStatus,
  isMilestoneKind,
  isInPlay,
  isTerminalStatus,
  sortCandidates,
} from "./lifecycle";
import { classifyCompetition, competitionDecision } from "./tiers";
import { resolveTeamFlag } from "./teamMeta";
import { buildLineupPostData, composeMessage, formatMemberLines, hasPublishableContent } from "./messages";
import {
  claimEvent,
  claimRetry,
  countTrackedFixtures,
  ensureSchema,
  finishRun,
  getEventStatuses,
  loadDroppedFixtureIds,
  loadRetryableEvents,
  loadStates,
  markEventAuthBlocked,
  markEventFailed,
  markEventPermanentlyFailed,
  markEventPosted,
  markKeysAuthBlocked,
  markKeysFailed,
  markKeysPosted,
  markUnresolved,
  reapStaleClaims,
  recordSystemEvent,
  reconcileKeysPosted,
  startRun,
  type StateRow,
  tryClaimKey,
  upsertSnapshot,
} from "./store";
import type { ApiFixture, ApiFixtureEvent, CandidateEvent, FixtureSnapshot, UpdateMember } from "./types";

/**
 * DynaSport automation pipeline (called every 15 minutes by cron-job.org):
 *
 *   GET /fixtures?live=all
 *   -> Tier 1: full live coverage (goals, assists, cards, subs, VAR, statuses,
 *      grouped under one 🚩 Live: status line per score update; Starting XI
 *      via /fixtures/lineups only when the daily budget safely permits)
 *   -> non-Tier-1 competitions are excluded immediately after the heartbeat
 *   -> dropped Tier 1 fixtures re-checked via /fixtures?id= detail requests
 *   -> deterministic event keys + Neon atomic claims (duplicate protection)
 *   -> real Meta Graph API posting to the Facebook Page
 */

export interface AutomationSummary {
  startedAt: string;
  durationMs: number;
  liveFixtures: number;
  eligibleFixtures: number;
  excludedFixtures: number;
  trackedFixtures: number;
  droppedRecovered: number;
  lineupsFetched: number;
  candidates: number;
  posted: number;
  postingFailed: number;
  duplicatesSkipped: number;
  retriedPosts: number;
  milestonesPosted: number;
  milestonesDeferred: number;
  skippedFixtures: number;
  unresolvedFixtures: number;
  facebookAuthBlocked: boolean;
  bootstrapBaseline: boolean;
  budgetUsedToday: number;
  dailyBudget: number;
  notes: string[];
}

interface SnapshotEntry {
  snapshot: FixtureSnapshot;
  terminal: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_LINEUP_FETCHES_PER_RUN = 2;
/** Stop publishing before the serverless function is killed (maxDuration 60s). */
const RUN_TIME_BUDGET_MS = 45000;
/**
 * Milestones may use more of the invocation than ordinary events: a missed
 * FT cannot be recreated by diffing once the fixture leaves the live list.
 */
const MILESTONE_TIME_BUDGET_MS = 52000;
/** Failed posts re-attempted per run (database only - costs no API requests). */
const MAX_RETRIES_PER_RUN = 5;
/** Only keep trying to fetch a Starting XI while the match is young. */
const LINEUP_FETCH_MAX_MINUTE = 40;

function scoreline(c: Pick<CandidateEvent, "goalsHome" | "goalsAway">): string {
  return `${c.goalsHome ?? 0}-${c.goalsAway ?? 0}`;
}

/** Deterministic key for a grouped update: stable for the identical member set. */
function groupKey(fixtureId: number, members: UpdateMember[]): string {
  const joined = members.map((m) => m.key).sort().join(";");
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) hash = ((hash << 5) + hash + joined.charCodeAt(i)) >>> 0;
  return `fx${fixtureId}:lu:${hash.toString(16)}`;
}

export async function runAutomation(): Promise<AutomationSummary> {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const sql = getDb();
  await ensureSchema(sql);

  const summary: AutomationSummary = {
    startedAt: startedAtIso,
    durationMs: 0,
    liveFixtures: 0,
    eligibleFixtures: 0,
    excludedFixtures: 0,
    trackedFixtures: 0,
    droppedRecovered: 0,
    lineupsFetched: 0,
    candidates: 0,
    posted: 0,
    postingFailed: 0,
    duplicatesSkipped: 0,
    retriedPosts: 0,
    milestonesPosted: 0,
    milestonesDeferred: 0,
    skippedFixtures: 0,
    unresolvedFixtures: 0,
    facebookAuthBlocked: false,
    bootstrapBaseline: false,
    budgetUsedToday: 0,
    dailyBudget: dailyBudget(),
    notes: [],
  };

  let runId = 0;
  const finalize = async (status: "success" | "partial" | "failed" | "skipped", error: string | null) => {
    summary.durationMs = Date.now() - startedAt.getTime();
    try {
      const usage = await getUsageToday(sql);
      summary.budgetUsedToday = usage.total;
    } catch {
      summary.notes.push("usage readback failed");
    }
    await finishRun(sql, runId, status, summary, error);
    return summary;
  };

  try {
    runId = await startRun(sql, startedAtIso);

    // Release claims orphaned by a previous crashed/timed-out invocation so
    // those events become retryable instead of being silently lost.
    try {
      const reaped = await reapStaleClaims(sql);
      if (reaped > 0) summary.notes.push(`${reaped} stale claim(s) released for retry.`);
    } catch (error) {
      summary.notes.push(`Stale-claim sweep failed: ${errorMessage(error)}`);
    }

    /* 1) Heartbeat: all live fixtures across every competition (the single
          15-minute request - no per-competition polling). */
    let liveFixtures: ApiFixture[];
    try {
      liveFixtures = await fetchLiveFixtures(sql);
    } catch (error) {
      if (error instanceof ApiBudgetExceededError) {
        summary.notes.push(errorMessage(error));
        await recordSystemEvent(sql, "api_error", errorMessage(error));
        return finalize("skipped", null);
      }
      if (error instanceof ApiAccountError) {
        await recordSystemEvent(sql, "api_error", errorMessage(error));
        // Suspended/invalid account: stop immediately, keep state intact and
        // surface a clear diagnostic. Normal operation resumes automatically
        // once the API account is restored.
        summary.notes.push(errorMessage(error));
        return finalize("failed", errorMessage(error));
      }
      await recordSystemEvent(sql, "api_error", errorMessage(error));
      throw error;
    }
    summary.liveFixtures = liveFixtures.length;

    /**
     * TIER-2 EXCLUSION (single choke point).
     * Low-interest competitions are dropped here, immediately after the
     * heartbeat, so no downstream component - snapshots, diffing, detail
     * requests, lineups, posting, dashboard - ever sees them.
     */
    const allLive = liveFixtures;
    const rejectionReasons: string[] = [];
    liveFixtures = allLive.filter((f) => {
      const decision = competitionDecision(
        f.league?.name,
        f.league?.country ?? null,
        typeof f.league?.id === "number" ? f.league.id : null,
      );
      if (!decision.approved && decision.reason) rejectionReasons.push(decision.reason);
      return decision.approved;
    });
    /** Fixture IDs cleared by the allowlist - the posting gate's source of truth. */
    const approvedFixtureIds = new Set(liveFixtures.map((f) => f.fixture.id));
    summary.eligibleFixtures = liveFixtures.length;
    summary.excludedFixtures = allLive.length - liveFixtures.length;
    if (summary.excludedFixtures > 0) {
      const sample = [...new Set(rejectionReasons)].slice(0, 5);
      summary.notes.push(
        `${summary.excludedFixtures} live fixture(s) excluded by the competition allowlist. ${sample.join(" | ")}`,
      );
    }

    const liveIds = new Set(liveFixtures.map((f) => f.fixture.id));

    /* 2) Bootstrap guard: silent baseline on the very first run only. */
    const trackedCount = await countTrackedFixtures(sql);
    const bootstrap = trackedCount === 0;
    summary.bootstrapBaseline = bootstrap;
    if (bootstrap) {
      summary.notes.push("First run: baseline snapshots established without posting (flood protection).");
    }

    /* 3) Diff live fixtures against stored snapshots. */
    const states = await loadStates(sql, [...liveIds]);
    const snapshots = new Map<number, SnapshotEntry>();
    const candidates: CandidateEvent[] = [];
    const lineupWanted: number[] = [];

    // Per-fixture isolation: one malformed or unexpected fixture must never
    // stop the other live matches from being processed.
    for (const fixture of liveFixtures) {
      const id = fixture.fixture.id;
      try {
        const previous = states.get(id)?.snapshot ?? null;
        const diffed = diffFixture(previous, fixture, { bootstrap });
        candidates.push(...diffed);

        const snapshot = buildSnapshot(fixture);
        snapshot.lineupPosted = previous?.lineupPosted ?? false;
        snapshot.lastPostedScoreline = previous?.lastPostedScoreline ?? null;
        snapshots.set(id, { snapshot, terminal: isTerminalStatus(snapshot.statusShort) });

        // Unfamiliar statuses/events are preserved for review, never published.
        if (!isKnownStatus(snapshot.statusShort)) {
          summary.notes.push(`Unrecognized fixture status "${snapshot.statusShort}" (fx${id}) - no post invented.`);
          await recordSystemEvent(sql, "unknown_status",
            `fx${id} status=${JSON.stringify(snapshot.statusShort)} league=${JSON.stringify(fixture.league?.name ?? null)}`);
        }
        const unknownTypes = new Set(
          safeEvents(fixture.events)
            .map((e: ApiFixtureEvent) => (typeof e?.type === "string" ? e.type.trim().toLowerCase() : ""))
            .filter((t: string) => t && !isKnownEventType(t)),
        );
        for (const type of unknownTypes) {
          summary.notes.push(`Unrecognized event type "${type}" (fx${id}) - not published.`);
          await recordSystemEvent(sql, "unknown_event", `fx${id} type=${JSON.stringify(type)}`);
        }

        const alreadyPosted = previous?.lineupPosted ?? false;
        const elapsed = snapshot.elapsed;
        const young = isInPlay(snapshot.statusShort) && (elapsed == null || elapsed <= LINEUP_FETCH_MAX_MINUTE);
        const freshKickoff = diffed.some((c) => c.kind === "kickoff");
        // Every tracked fixture is Tier 1 by construction (filtered above).
        if (!bootstrap && !alreadyPosted && young && (freshKickoff || previous !== null || elapsed != null)) {
          lineupWanted.push(id);
        }
      } catch (error) {
        summary.skippedFixtures += 1;
        summary.notes.push(`Fixture ${id} skipped: ${errorMessage(error)}`);
      }
    }

    /* 4) Detail batch A: dropped fixtures - Tier 1 only (FT detection).
          Only Tier 1 fixtures are ever tracked, so recovery is Tier 1 only. */
    let detailSlots = 0;
    let apiBlocked = false;
    try {
      detailSlots = await detailSlotsAvailable(sql);
    } catch {
      detailSlots = 0;
    }

    let droppedIds = await loadDroppedFixtureIds(sql, liveIds);
    if (droppedIds.length > 0) {
      const droppedStates = await loadStates(sql, droppedIds);
      droppedIds = droppedIds.filter((id) => {
        const snap = droppedStates.get(id)?.snapshot;
        return snap ? classifyCompetition(snap.leagueName, snap.leagueCountry) === 1 : false;
      });
    }
    // Detail recovery uses `/fixtures?ids=` (up to 20 per request, official)
    // with an automatic fall back to `/fixtures?id=` if the plan rejects it.
    // The response embeds events AND lineups, so no extra lineup call is made.
    const recoverable = Math.max(0, Math.min(droppedIds.length, detailSlots > 0 ? droppedIds.length : 0));
    const detailTargets = droppedIds.slice(0, recoverable);
    let detailRequestsUsed = 0;
    const recoveredStates: Map<number, StateRow> =
      detailTargets.length > 0 ? await loadStates(sql, detailTargets) : new Map();

    if (detailTargets.length > 0 && detailSlots > 0) {
      try {
        const detail = await fetchFixtureDetails(sql, detailTargets, detailSlots);
        detailRequestsUsed = detail.requestsUsed;
        const resolvedIds: number[] = [];
        for (const fixture of detail.fixtures) {
          const fixtureId = fixture.fixture.id;
          try {
            // Re-verify: a fixture must never enter via a detail lookup.
            const decision = competitionDecision(
              fixture.league?.name,
              fixture.league?.country ?? null,
              typeof fixture.league?.id === "number" ? fixture.league.id : null,
            );
            if (!decision.approved) {
              summary.notes.push(`Recovered fixture ${fixtureId} rejected: ${decision.reason}`);
              continue;
            }
            approvedFixtureIds.add(fixtureId);
            const previous =
              recoveredStates.get(fixtureId)?.snapshot ?? states.get(fixtureId)?.snapshot ?? null;
            candidates.push(...diffFixture(previous, fixture, { bootstrap }));
            const snapshot = buildSnapshot(fixture);
            snapshot.lineupPosted = previous?.lineupPosted ?? false;
            snapshot.lastPostedScoreline = previous?.lastPostedScoreline ?? null;
            snapshots.set(fixtureId, { snapshot, terminal: isTerminalStatus(snapshot.statusShort) });
            if (isTerminalStatus(snapshot.statusShort)) resolvedIds.push(fixtureId);
          } catch (error) {
            summary.notes.push(`Recovered fixture ${fixtureId} skipped: ${errorMessage(error)}`);
          }
        }
        summary.droppedRecovered += detail.fixtures.length;
        if (resolvedIds.length > 0) await markUnresolved(sql, resolvedIds, false).catch(() => undefined);
      } catch (error) {
        if (error instanceof ApiAccountError || error instanceof ApiBudgetExceededError) {
          apiBlocked = true;
        }
        summary.notes.push(`Detail recovery stopped: ${errorMessage(error)}`);
        await recordSystemEvent(sql, "api_error", errorMessage(error));
      }
    }

    /* Fixtures that vanished from the live list and could NOT be confirmed are
       flagged unresolved. We never invent a full-time result for them. */
    const stillUnknown = droppedIds.filter((dropId) => !snapshots.has(dropId));
    if (stillUnknown.length > 0) {
      summary.unresolvedFixtures = stillUnknown.length;
      await markUnresolved(sql, stillUnknown, true).catch(() => undefined);
      summary.notes.push(
        `${stillUnknown.length} fixture(s) left the live list without a confirmed final status (no result published).`,
      );
    }

    /* 5) Detail batch B: Starting XI for Tier 1, only with safe remaining budget. */
    const lineupBudget = apiBlocked
      ? 0
      : Math.max(0, Math.min(detailSlots - detailRequestsUsed, MAX_LINEUP_FETCHES_PER_RUN));

    if (lineupBudget > 0 && lineupWanted.length > 0) {
      try {
        // One detail request returns events AND lineups for up to 20 fixtures.
        const detail = await fetchFixtureDetails(sql, lineupWanted.slice(0, 20), lineupBudget);
        for (const fixture of detail.fixtures) {
          const fixtureId = fixture.fixture.id;
          const entry = snapshots.get(fixtureId);
          if (!entry) continue;
          try {
            const lineups = embeddedLineups(fixture);
            const isInternational =
              (entry.snapshot.leagueCountry ?? "").trim().toLowerCase() === "world";

            // Dynamic club-country detection (cache -> budget-guarded API -> omit).
            const homeLineupTeam = lineups.find(
              (l) => l.team?.name === entry.snapshot.home,
            ) ?? lineups[0];
            const awayLineupTeam = lineups.find(
              (l) => l.team?.name === entry.snapshot.away,
            ) ?? (lineups.length > 1 ? lineups[1] : undefined);

            let teamMetaSlots = Math.max(0, detailSlots - detailRequestsUsed);
            const homeResolved = homeLineupTeam
              ? await resolveTeamFlag(sql, {
                  id: homeLineupTeam.team?.id ?? null,
                  name: homeLineupTeam.team?.name ?? entry.snapshot.home,
                }, {
                  isInternational,
                  budgetSlots: teamMetaSlots,
                  fetchTeamMeta: (id) => fetchTeamCountry(sql, id),
                })
              : { flag: "", source: "none" as const };
            if (homeResolved.source === "api") teamMetaSlots = Math.max(0, teamMetaSlots - 1);
            const awayResolved = awayLineupTeam
              ? await resolveTeamFlag(sql, {
                  id: awayLineupTeam.team?.id ?? null,
                  name: awayLineupTeam.team?.name ?? entry.snapshot.away,
                }, {
                  isInternational,
                  budgetSlots: teamMetaSlots,
                  fetchTeamMeta: (id) => fetchTeamCountry(sql, id),
                })
              : { flag: "", source: "none" as const };

            const postData = buildLineupPostData(
              lineups,
              entry.snapshot.home,
              entry.snapshot.away,
              { homeFlag: homeResolved.flag, awayFlag: awayResolved.flag },
            );
            if (postData) {
              summary.lineupsFetched += 1;
              candidates.push({
                eventKey: `fx${fixtureId}:lineup`,
                fixtureId,
                kind: "lineup",
                minute: 0,
                sortRank: -6,
                league: entry.snapshot.leagueName,
                leagueCountry: entry.snapshot.leagueCountry,
                leagueFlagCode: entry.snapshot.leagueFlagCode,
                home: entry.snapshot.home,
                away: entry.snapshot.away,
                goalsHome: entry.snapshot.goalsHome,
                goalsAway: entry.snapshot.goalsAway,
                pensHome: entry.snapshot.pensHome,
                pensAway: entry.snapshot.pensAway,
                statusShort: entry.snapshot.statusShort,
                lineup: postData,
              });
              entry.snapshot = { ...entry.snapshot, lineupPosted: true };
            }
            // Detail responses also carry fresher events than the heartbeat.
            const previous = states.get(fixtureId)?.snapshot ?? null;
            if (previous) candidates.push(...diffFixture(previous, fixture, { bootstrap }));
          } catch (error) {
            summary.notes.push(`Lineup handling failed for fixture ${fixtureId}: ${errorMessage(error)}`);
          }
        }
      } catch (error) {
        if (error instanceof ApiAccountError || error instanceof ApiBudgetExceededError) {
          apiBlocked = true;
        }
        summary.notes.push(`Starting XI fetch skipped: ${errorMessage(error)}`);
      }
    }

    /* 6) De-duplicate, merge FT with its final goal, order, cap. */
    const unique = new Map<string, CandidateEvent>();
    for (const c of candidates) {
      if (c.kind === "live_update") {
        // Grouped updates are keyed at claim time; keep the richest copy.
        const existing = unique.get(`live_update:${c.fixtureId}`);
        if (!existing || (c.members?.length ?? 0) > (existing.members?.length ?? 0)) {
          unique.set(`live_update:${c.fixtureId}`, c);
        }
      } else if (!unique.has(c.eventKey)) {
        unique.set(c.eventKey, c);
      }
    }

    /**
     * If a final goal and full-time are detected in the SAME run, publish one
     * combined FT post (full-time line first, goal beneath) instead of two
     * posts. Member-level claims still guarantee a goal already published in
     * an earlier run is never repeated inside the FT post.
     */
    for (const candidate of [...unique.values()]) {
      if (candidate.kind !== "fulltime") continue;
      const liveKey = `live_update:${candidate.fixtureId}`;
      const live = unique.get(liveKey);
      if (!live) continue;
      const merged = [...(candidate.members ?? []), ...(live.members ?? [])];
      const seen = new Set<string>();
      candidate.members = merged.filter((m) => {
        if (seen.has(m.key)) return false;
        seen.add(m.key);
        return true;
      });
      // Keep the authoritative final score from the full-time payload.
      unique.delete(liveKey);
    }

    /**
     * FINAL ALLOWLIST GATE.
     * Every candidate - including ones produced by detail lookups or carried
     * over from an earlier phase - must belong to a fixture cleared by the
     * allowlist. Nothing reaches Facebook without passing this check.
     */
    for (const [mapKey, candidate] of [...unique.entries()]) {
      if (!approvedFixtureIds.has(candidate.fixtureId)) {
        unique.delete(mapKey);
        summary.notes.push(
          `Blocked post for fixture ${candidate.fixtureId}: competition not approved (posting gate).`,
        );
        continue;
      }
      // Never publish a bare status line with no renderable event (filler).
      if (!hasPublishableContent(candidate)) {
        unique.delete(mapKey);
      }
    }

    const ordered = sortCandidates([...unique.values()]);

    /**
     * MILESTONE PRIORITY.
     *
     * Major match-state transitions (kick-off, HT, 2H, ET, shootout, FT/AET/
     * PEN, terminal statuses) are split into their own priority class and
     * published FIRST, before any ordinary event.
     *
     * Root cause this fixes: milestones sort by match minute, so FT lands at
     * minute ~997 - dead last. The per-run post cap truncated from the end and
     * the run-time guard deferred from the end, which meant full-time was the
     * very first post to be dropped on a busy run. Milestones are now never
     * queued behind goals, lineups or cards and are exempt from the ordinary
     * post cap.
     */
    const milestoneQueue = bootstrap ? [] : ordered.filter((c) => isMilestoneKind(c.kind));
    const ordinaryAll = bootstrap ? [] : ordered.filter((c) => !isMilestoneKind(c.kind));
    const ordinaryQueue = ordinaryAll.slice(0, MAX_POSTS_PER_RUN);
    if (ordinaryAll.length > ordinaryQueue.length) {
      summary.notes.push(
        `${ordinaryAll.length - ordinaryQueue.length} ordinary event(s) skipped by the per-run post cap of ${MAX_POSTS_PER_RUN} (milestones unaffected).`,
      );
    }
    summary.candidates = ordered.length;

    /* 7) Claim -> compose -> post -> mark (all idempotent via Neon event keys). */
    const facebookReady = isFacebookConfigured();
    if (!facebookReady && milestoneQueue.length + ordinaryQueue.length > 0) {
      summary.notes.push(
        "Facebook is not configured (FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN) - events tracked but not posted.",
      );
    }

    /**
     * Shared failure policy:
     *  - credential failures  -> 'blocked' (stays queued, delivered once a
     *    valid Page token is configured) and the run stops publishing to
     *    avoid hammering Graph API with the same bad token.
     *  - undeliverable content -> retired permanently.
     *  - everything else       -> 'failed' and retried later.
     */
    let authBlocked = false;
    const handlePostFailure = async (eventKey: string, memberKeys: string[], error: unknown) => {
      if (isAuthFailure(error)) {
        authBlocked = true;
        summary.facebookAuthBlocked = true;
        await markEventAuthBlocked(sql, eventKey, error).catch(() => undefined);
        await markKeysAuthBlocked(sql, memberKeys, error).catch(() => undefined);
        await recordSystemEvent(sql, "facebook_auth_error", errorMessage(error));
        summary.notes.push(
          `Facebook authentication failed - publishing paused, events stay queued: ${errorMessage(error)}`,
        );
        return;
      }
      if (isUndeliverable(error)) {
        await markEventPermanentlyFailed(sql, eventKey, error).catch(() => undefined);
      } else {
        await markEventFailed(sql, eventKey, error).catch(() => undefined);
      }
      await markKeysFailed(sql, memberKeys, error).catch(() => undefined);
      summary.postingFailed += 1;
      summary.notes.push(`Post failed (${eventKey}): ${errorMessage(error)}`);
    };

    const postSingle = async (candidate: CandidateEvent, message: string): Promise<void> => {
      const claim = await claimEvent(sql, candidate, message);
      if (claim === "duplicate") {
        summary.duplicatesSkipped += 1;
        return;
      }
      try {
        const post = await postToFacebookPage(message);
        await markEventPosted(sql, candidate.eventKey, post.id);
        await recordSystemEvent(sql, "facebook_delivered", candidate.kind);
        summary.posted += 1;
        const entry = snapshots.get(candidate.fixtureId);
        if (entry && (candidate.kind === "kickoff" || candidate.kind === "live_update")) {
          entry.snapshot = { ...entry.snapshot, lastPostedScoreline: scoreline(candidate) };
        }
        await sleep(POST_DELAY_MS);
      } catch (error) {
        await handlePostFailure(candidate.eventKey, [], error);
      }
    };

    const postGroupedUpdate = async (candidate: CandidateEvent): Promise<void> => {
      const members = candidate.members ?? [];
      const memberKeys = members.map((m) => m.key);

      // Member-level duplicate protection: never repost an event already shown.
      const statuses = await getEventStatuses(sql, memberKeys);
      const included: UpdateMember[] = [];
      for (const member of members) {
        if (statuses.get(member.key) === "posted") continue;
        const line = formatMemberLines(member).join("\n") || member.detail;
        const claimed = await tryClaimKey(sql, member.key, candidate.fixtureId, member.kind, line);
        if (claimed) included.push(member);
      }

      const current = scoreline(candidate);
      const postedScoreline = snapshots.get(candidate.fixtureId)?.snapshot.lastPostedScoreline ?? null;
      const alreadyShown = postedScoreline === current;

      if (included.length === 0 && candidate.kind !== "live_update") {
        // Status post (e.g. FT) whose goal was already published earlier:
        // still publish the status itself, just without the goal line.
        await postSingle({ ...candidate, members: [] }, composeMessage({ ...candidate, members: [] }));
        return;
      }

      if (included.length === 0) {
        if (members.length > 0) {
          summary.duplicatesSkipped += 1;
          return; // every member already on the Page
        }
        if (!candidate.scoreChanged && !candidate.joined) return; // nothing new at all
        if (alreadyShown && !candidate.joined) {
          summary.duplicatesSkipped += 1;
          return; // same scoreline already shown, no new events
        }
      }

      const compositeKey =
        candidate.kind !== "live_update"
          ? // Status posts (FT, etc.) keep their own deterministic key so the
            // post itself is deduplicated across runs.
            candidate.eventKey
          : included.length > 0
            ? groupKey(candidate.fixtureId, included)
            : candidate.joined
              ? `fx${candidate.fixtureId}:joined`
              : `fx${candidate.fixtureId}:score:${current}`;

      const composed = { ...candidate, members: included, eventKey: compositeKey };
      const message = composeMessage(composed);

      const claim = await claimEvent(sql, composed, message);
      if (claim === "duplicate") {
        await reconcileKeysPosted(sql, included.map((m) => m.key)).catch(() => undefined);
        summary.duplicatesSkipped += 1;
        return;
      }

      const memberKeysToMark = included.map((m) => m.key);
      try {
        const post = await postToFacebookPage(message);
        await markEventPosted(sql, compositeKey, post.id);
        await markKeysPosted(sql, memberKeysToMark, post.id);
        await recordSystemEvent(sql, "facebook_delivered", "live_update");
        summary.posted += 1;
        const entry = snapshots.get(candidate.fixtureId);
        if (entry) entry.snapshot = { ...entry.snapshot, lastPostedScoreline: current };
        await sleep(POST_DELAY_MS);
      } catch (error) {
        await handlePostFailure(compositeKey, memberKeysToMark, error);
      }
    };

    const outOfTime = () => Date.now() - startedAt.getTime() > RUN_TIME_BUDGET_MS;

    /**
     * Retries replay a stored message for a fixture claimed in an earlier run.
     * If that fixture is visible in this run it must still be approved; if it
     * is not visible we allow the retry, because the event was already cleared
     * by the gate when it was first claimed.
     */
    const seenThisRun = new Set<number>([...snapshots.keys()]);
    const retryApprovalBlocked = (fixtureId: number): boolean =>
      seenThisRun.has(fixtureId) && !approvedFixtureIds.has(fixtureId);

    if (facebookReady) {
      const publish = async (candidate: CandidateEvent) => {
        try {
          if (candidate.kind === "live_update" || (candidate.members?.length ?? 0) > 0) {
            await postGroupedUpdate(candidate);
          } else {
            await postSingle(candidate, composeMessage(candidate));
          }
        } catch (error) {
          summary.postingFailed += 1;
          summary.notes.push(`Unexpected posting error (${candidate.eventKey}): ${errorMessage(error)}`);
        }
      };

      /* 7a) MILESTONES FIRST - never starved by ordinary events. They use a
             wider time allowance because a missed milestone (especially FT)
             cannot be regenerated by snapshot diffing on a later run. */
      for (const candidate of milestoneQueue) {
        if (authBlocked) {
          summary.milestonesDeferred += 1;
          continue;
        }
        if (Date.now() - startedAt.getTime() > MILESTONE_TIME_BUDGET_MS) {
          summary.milestonesDeferred += 1;
          summary.notes.push(`Milestone deferred to the next run (time budget): ${candidate.eventKey}`);
          continue;
        }
        const before = summary.posted;
        await publish(candidate);
        if (summary.posted > before) summary.milestonesPosted += 1;
      }

      /* 7b) Ordinary events, subject to the per-run cap and time budget. */
      let deferred = 0;
      for (const candidate of ordinaryQueue) {
        if (outOfTime() || authBlocked) {
          deferred += 1;
          continue;
        }
        await publish(candidate);
      }
      if (deferred > 0) {
        summary.notes.push(`${deferred} ordinary event(s) deferred to the next run (run time budget).`);
      }

      /* 7b) Retry previously failed posts. Snapshot diffing will not recreate
             them, so they are replayed from their stored message. Database
             only - this never consumes API-Football requests. */
      try {
        const retryables = authBlocked ? [] : await loadRetryableEvents(sql, MAX_RETRIES_PER_RUN);
        for (const retryable of retryables) {
          // A retry must never resurrect a fixture that is no longer approved.
          if (retryApprovalBlocked(retryable.fixtureId)) continue;
          if (outOfTime() || authBlocked) break;
          const claimed = await claimRetry(sql, retryable.eventKey);
          if (!claimed) continue;
          try {
            const post = await postToFacebookPage(retryable.message);
            await markEventPosted(sql, retryable.eventKey, post.id);
            await recordSystemEvent(sql, "facebook_delivered", `retry:${retryable.kind}`);
            summary.retriedPosts += 1;
            summary.posted += 1;
            await sleep(POST_DELAY_MS);
          } catch (error) {
            await handlePostFailure(retryable.eventKey, [], error);
            summary.notes.push(`Retry failed (${retryable.eventKey}): ${errorMessage(error)}`);
            if (authBlocked) break;
          }
        }
      } catch (error) {
        summary.notes.push(`Retry sweep failed: ${errorMessage(error)}`);
      }
    }

    /* 8) Persist fresh snapshots so the next heartbeat diffs against reality. */
    for (const [fixtureId, entry] of snapshots) {
      try {
        await upsertSnapshot(sql, entry.snapshot, entry.terminal);
      } catch (error) {
        summary.notes.push(`Snapshot persist failed for fixture ${fixtureId}: ${errorMessage(error)}`);
      }
    }

    summary.trackedFixtures = snapshots.size;
    const status =
      summary.facebookAuthBlocked || summary.postingFailed > 0 ? "partial" : "success";
    return finalize(
      status,
      summary.facebookAuthBlocked ? "Facebook authentication failed (events queued)" : null,
    );
  } catch (error) {
    const message = errorMessage(error);
    summary.notes.push(message);
    return finalize("failed", message);
  }
}

export { detailMaxBatchesPerRun };
