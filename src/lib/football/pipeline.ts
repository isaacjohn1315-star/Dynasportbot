import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { MAX_POSTS_PER_RUN, POST_DELAY_MS, dailyBudget, detailMaxBatchesPerRun } from "./config";
import {
  ApiAccountError,
  ApiBudgetExceededError,
  FacebookConfigError,
  errorMessage,
  isAuthFailure,
  isUncertainFailure,
  isUndeliverable,
} from "./errors";
import {
  criticalDetailSlotsAvailable,
  detailSlotsAvailable,
  embeddedLineups,
  fetchFixtureDetails,
  fetchLiveFixtures,
  getUsageToday,
} from "./api";
import {
  getRecentFacebookPagePosts,
  isFacebookConfigured,
  postToFacebookPage,
} from "./facebook";
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
  linkMemberKeysToParent,
  loadChildEventKeys,
  loadDroppedFixtureIds,
  loadRetryableEvents,
  loadStates,
  loadUncertainEvents,
  markEventAuthBlocked,
  markEventFailed,
  markEventPermanentlyFailed,
  markEventPosted,
  markEventUncertain,
  markKeysAuthBlocked,
  markKeysFailed,
  markKeysUncertain,
  markKeysPosted,
  markUnresolved,
  reapStaleClaims,
  recordSystemEvent,
  reconcileKeysPosted,
  reconcilePostedChildren,
  releaseUncertainKeys,
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
  ordinaryCandidates: number;
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

/** Stop publishing before the serverless function is killed (maxDuration 60s). */
const RUN_TIME_BUDGET_MS = 45000;
/**
 * Milestones may use more of the invocation than ordinary events: a missed
 * FT cannot be recreated by diffing once the fixture leaves the live list.
 */
const MILESTONE_TIME_BUDGET_MS = 52000;
/** Failed posts re-attempted per run (database only - costs no API requests). */
const MAX_RETRIES_PER_RUN = 5;
/** Do not decide an uncertain Graph outcome until propagation has had time. */
const UNCERTAIN_RECONCILE_GRACE_MS = 2 * 60 * 1000;
/** Only keep trying to fetch a Starting XI while the match is young. */
const LINEUP_FETCH_MAX_MINUTE = 40;

function scoreline(c: Pick<CandidateEvent, "goalsHome" | "goalsAway">): string {
  return `${c.goalsHome ?? 0}-${c.goalsAway ?? 0}`;
}

/**
 * Collision-resistant deterministic key for a grouped update. A prior 32-bit
 * hash could theoretically collide and suppress an unrelated post.
 */
function groupKey(fixtureId: number, members: UpdateMember[]): string {
  const joined = members.map((m) => m.key).sort().join(";");
  const digest = createHash("sha256").update(joined).digest("hex").slice(0, 32);
  return `fx${fixtureId}:lu:${digest}`;
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
    ordinaryCandidates: 0,
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

    // Claims orphaned by a crashed/timed-out invocation have an UNKNOWN
    // Facebook outcome. Reconcile them instead of retrying blindly.
    try {
      const reaped = await reapStaleClaims(sql);
      if (reaped > 0) {
        summary.notes.push(`${reaped} stale claim(s) moved to uncertain reconciliation.`);
      }
      const repaired = await reconcilePostedChildren(sql);
      if (repaired > 0) {
        summary.notes.push(`${repaired} child event claim(s) reconciled from posted parents.`);
      }
    } catch (error) {
      summary.notes.push(`Claim reconciliation sweep failed: ${errorMessage(error)}`);
    }

    /* 1) Heartbeat: all live fixtures across every competition (the single
          15-minute request - no per-competition polling). */
    let liveFixtures: ApiFixture[];
    try {
      liveFixtures = await fetchLiveFixtures(sql);
    } catch (error) {
      if (error instanceof ApiBudgetExceededError) {
        /**
         * Daily quota exhausted. The heartbeat cannot be paid for, but the
         * finish detector needs no requests at all: it works from state we
         * already stored while the matches were live. Continue with an empty
         * live list so unambiguous finishes are still published, and leave the
         * ambiguous ones flagged rather than guessed.
         */
        summary.notes.push(errorMessage(error));
        await recordSystemEvent(sql, "api_error", errorMessage(error));
        return finalize("skipped", null);
      } else if (error instanceof ApiAccountError) {
        await recordSystemEvent(sql, "api_error", errorMessage(error));
        // Suspended/invalid account: stop immediately, keep state intact and
        // surface a clear diagnostic. Normal operation resumes automatically
        // once the API account is restored.
        summary.notes.push(errorMessage(error));
        return finalize("failed", errorMessage(error));
      } else {
        await recordSystemEvent(sql, "api_error", errorMessage(error));
        throw error;
      }
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
    let criticalDetailSlots = 0;
    let apiBlocked = false;
    try {
      [detailSlots, criticalDetailSlots] = await Promise.all([
        detailSlotsAvailable(sql),
        criticalDetailSlotsAvailable(sql),
      ]);
    } catch {
      detailSlots = 0;
      criticalDetailSlots = 0;
    }

    let droppedIds = await loadDroppedFixtureIds(sql, liveIds);
    if (droppedIds.length > 0) {
      const droppedStates = await loadStates(sql, droppedIds);
      droppedIds = droppedIds.filter((id) => {
        const snap = droppedStates.get(id)?.snapshot;
        return snap
          ? classifyCompetition(snap.leagueName, snap.leagueCountry, snap.leagueId ?? null) === 1
          : false;
      });
    }

    /**
     * FINISH DETECTOR - CONFIRMED RESULTS ONLY.
     *
     * `/fixtures?live=all` reports in-play statuses only (1H HT 2H ET BT P),
     * so a match that ends between two cron runs leaves the feed without ever
     * showing FT. Its final status and score are therefore read back from the
     * fixture endpoint.
     *
     * Accuracy rule: a final result is ONLY ever published from a status the
     * API explicitly returned. Nothing is inferred from stored state, because
     * a goal scored after our last poll (a stoppage-time winner, a shootout
     * kick) would make an inferred score wrong. If no request can be spared,
     * the finish stays queued and is confirmed on a later run - it is never
     * guessed.
     *
     * Cost: `/fixtures?ids=` confirms up to 20 matches in ONE request, so a
     * whole matchday of finishes usually costs a single request from the
     * existing daily budget.
     */
    const droppedStates = droppedIds.length > 0 ? await loadStates(sql, droppedIds) : new Map<number, StateRow>();

    // Dropped fixtures were already allowlisted above; record them so the
    // final posting gate accepts their confirmed finish.
    for (const id of droppedIds) approvedFixtureIds.add(id);

    const confirmTargets = [...droppedIds];
    const lineupWantedSet = new Set(lineupWanted);

    /**
     * Lineups ride along in the SAME batched request as finish confirmations,
     * which costs nothing extra. With no finish pending, lineups may use only
     * normal optional slots; finish confirmation may use the configured safety
     * reserve through criticalDetailSlots. Future heartbeat slots remain
     * untouchable in both cases.
     */
    const requestAllowance =
      confirmTargets.length > 0 ? criticalDetailSlots : detailSlots;
    const detailTargets =
      requestAllowance > 0 && (confirmTargets.length > 0 || lineupWanted.length > 0)
        ? [...new Set([...confirmTargets, ...lineupWanted])].slice(0, 20)
        : [];
    const droppedSet = new Set(droppedIds);
    const recoveredStates: Map<number, StateRow> =
      detailTargets.length > 0 ? await loadStates(sql, detailTargets) : new Map();

    if (detailTargets.length > 0) {
      try {
        const detail = await fetchFixtureDetails(sql, detailTargets, requestAllowance);
        const resolvedIds: number[] = [];
        for (const fixture of detail.fixtures) {
          const fixtureId = fixture.fixture.id;
          try {
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
            snapshot.lineupPosted =
              (previous?.lineupPosted ?? false) ||
              (droppedStates.get(fixtureId)?.snapshot?.lineupPosted ?? false);
            snapshot.lastPostedScoreline = previous?.lastPostedScoreline ?? null;
            snapshots.set(fixtureId, { snapshot, terminal: isTerminalStatus(snapshot.statusShort) });
            if (isTerminalStatus(snapshot.statusShort)) resolvedIds.push(fixtureId);

            /**
             * Diagnostic: the confirmed final score differs from the last
             * score we published while the match was live. This is the
             * stoppage-time-goal case - the goal itself is picked up by the
             * diff above and merged into the FT post, so nothing is wrong,
             * but the divergence is recorded for review.
             */
            if (isTerminalStatus(snapshot.statusShort) && previous?.lastPostedScoreline) {
              const confirmed = `${snapshot.goalsHome ?? 0}-${snapshot.goalsAway ?? 0}`;
              if (confirmed !== previous.lastPostedScoreline) {
                await recordSystemEvent(
                  sql,
                  "api_error",
                  `fx${fixtureId} final score ${confirmed} differs from last posted ${previous.lastPostedScoreline} (late goal)`,
                ).catch(() => undefined);
              }
            }

            // Reuse this same response for a pending starting XI - no extra call.
            if (lineupWantedSet.has(fixtureId) && !snapshot.lineupPosted) {
              const lineups = embeddedLineups(fixture);
              const isInternational =
                (snapshot.leagueCountry ?? "").trim().toLowerCase() === "world";
              const homeLineupTeam =
                lineups.find((l) => l.team?.name === snapshot.home) ?? lineups[0];
              const awayLineupTeam =
                lineups.find((l) => l.team?.name === snapshot.away) ??
                (lineups.length > 1 ? lineups[1] : undefined);
              const noMetadataCall = async () => null;
              const homeResolved = homeLineupTeam
                ? await resolveTeamFlag(sql, {
                    id: homeLineupTeam.team?.id ?? null,
                    name: homeLineupTeam.team?.name ?? snapshot.home,
                  }, { isInternational, budgetSlots: 0, fetchTeamMeta: noMetadataCall })
                : { flag: "", source: "none" as const };
              const awayResolved = awayLineupTeam
                ? await resolveTeamFlag(sql, {
                    id: awayLineupTeam.team?.id ?? null,
                    name: awayLineupTeam.team?.name ?? snapshot.away,
                  }, { isInternational, budgetSlots: 0, fetchTeamMeta: noMetadataCall })
                : { flag: "", source: "none" as const };
              const postData = buildLineupPostData(lineups, snapshot.home, snapshot.away, {
                homeFlag: homeResolved.flag,
                awayFlag: awayResolved.flag,
              });
              if (postData) {
                summary.lineupsFetched += 1;
                candidates.push({
                  eventKey: `fx${fixtureId}:lineup`,
                  fixtureId,
                  kind: "lineup",
                  minute: 0,
                  sortRank: -6,
                  league: snapshot.leagueName,
                  leagueCountry: snapshot.leagueCountry,
                  leagueFlagCode: snapshot.leagueFlagCode,
                  home: snapshot.home,
                  away: snapshot.away,
                  goalsHome: snapshot.goalsHome,
                  goalsAway: snapshot.goalsAway,
                  pensHome: snapshot.pensHome,
                  pensAway: snapshot.pensAway,
                  statusShort: snapshot.statusShort,
                  lineup: postData,
                });
                snapshot.lineupPosted = true;
              }
            }
          } catch (error) {
            summary.notes.push(`Recovered fixture ${fixtureId} skipped: ${errorMessage(error)}`);
          }
        }
        summary.droppedRecovered += detail.fixtures.filter((f) => droppedSet.has(f.fixture.id)).length;
        if (resolvedIds.length > 0) await markUnresolved(sql, resolvedIds, false).catch(() => undefined);
      } catch (error) {
        if (error instanceof ApiAccountError || error instanceof ApiBudgetExceededError) {
          apiBlocked = true;
        }
        summary.notes.push(`Detail recovery stopped: ${errorMessage(error)}`);
        await recordSystemEvent(sql, "api_error", errorMessage(error));
      }
    }

    /* Fixtures that left the live list without a confirmed result. They stay
       queued in fixture_state and are confirmed on a later run (within the
       recovery window) - a result is never invented for them. */
    const stillUnknown = droppedIds.filter((dropId) => !snapshots.has(dropId));
    if (stillUnknown.length > 0) {
      summary.unresolvedFixtures = stillUnknown.length;
      await markUnresolved(sql, stillUnknown, true).catch(() => undefined);
      summary.notes.push(
        `${stillUnknown.length} finish(es) awaiting confirmation (no result published until the API confirms it).`,
      );
    }

    /* 5) No standalone lineup/detail request.
       Lineups are processed from the recovery batch above, so final-status
       reconciliation can never be starved by an earlier optional lookup. */

    /* 6) De-duplicate, merge FT with its final goal, order, cap. */
    const unique = new Map<string, CandidateEvent>();
    for (const c of candidates) {
      if (c.kind === "live_update") {
        // Keyed per event CATEGORY plus the incident (first member key), so a
        // fixture's goal, red-card, missed-penalty and VAR posts are never
        // collapsed into one another, while duplicate candidates produced for
        // the same incident (e.g. heartbeat + detail diff) still collapse to
        // the richest copy. Score-only updates key on the category alone.
        const cat = c.category ?? "goal";
        const incident = c.members?.[0]?.key ?? "score";
        const catKey = `live_update:${c.fixtureId}:${cat}:${incident}`;
        const existing = unique.get(catKey);
        if (!existing || (c.members?.length ?? 0) > (existing.members?.length ?? 0)) {
          unique.set(catKey, c);
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
    summary.ordinaryCandidates = ordered.filter((c) => !isMilestoneKind(c.kind)).length;
    summary.candidates = ordered.length;

    /* 7) Claim -> compose -> post -> mark (all idempotent via Neon event keys). */
    const facebookReady = isFacebookConfigured();
    if (!facebookReady && ordered.length > 0) {
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
    let authBlockError: unknown = null;
    const handlePostFailure = async (eventKey: string, memberKeys: string[], error: unknown) => {
      if (isAuthFailure(error)) {
        authBlocked = true;
        authBlockError = error;
        summary.facebookAuthBlocked = true;
        await markEventAuthBlocked(sql, eventKey, error).catch(() => undefined);
        await markKeysAuthBlocked(sql, memberKeys, error).catch(() => undefined);
        await recordSystemEvent(sql, "facebook_auth_error", errorMessage(error));
        summary.notes.push(
          `Facebook authentication failed - publishing paused, events stay queued: ${errorMessage(error)}`,
        );
        return;
      }
      if (isUncertainFailure(error)) {
        await markEventUncertain(sql, eventKey, error).catch(() => undefined);
        await markKeysUncertain(sql, memberKeys, error).catch(() => undefined);
        summary.postingFailed += 1;
        summary.notes.push(
          `Facebook publish outcome uncertain (${eventKey}); queued for feed reconciliation, not retried blindly.`,
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

    const postSingle = async (
      candidate: CandidateEvent,
      message: string,
      queueWithoutDelivery?: unknown,
    ): Promise<void> => {
      const claim = await claimEvent(sql, candidate, message);
      if (claim === "duplicate") {
        summary.duplicatesSkipped += 1;
        return;
      }
      if (queueWithoutDelivery) {
        await handlePostFailure(candidate.eventKey, [], queueWithoutDelivery);
        return;
      }
      let post: { id: string };
      try {
        post = await postToFacebookPage(message);
      } catch (error) {
        await handlePostFailure(candidate.eventKey, [], error);
        return;
      }

      // Graph confirmed success. A later Neon failure must NEVER turn this
      // into a Facebook retry; preserve it as uncertain for feed reconciliation.
      summary.posted += 1;
      try {
        await markEventPosted(sql, candidate.eventKey, post.id);
      } catch (error) {
        await markEventUncertain(sql, candidate.eventKey, error).catch(() => undefined);
        summary.notes.push(
          `Facebook delivered ${candidate.eventKey}, but Neon acknowledgement failed; queued for reconciliation.`,
        );
      }
      await recordSystemEvent(sql, "facebook_delivered", candidate.kind).catch(() => undefined);
      const entry = snapshots.get(candidate.fixtureId);
      if (entry && (candidate.kind === "kickoff" || candidate.kind === "live_update")) {
        entry.snapshot = { ...entry.snapshot, lastPostedScoreline: scoreline(candidate) };
      }
      await sleep(POST_DELAY_MS);
    };

    const postGroupedUpdate = async (
      candidate: CandidateEvent,
      queueWithoutDelivery?: unknown,
    ): Promise<void> => {
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
        await postSingle(
          { ...candidate, members: [] },
          composeMessage({ ...candidate, members: [] }),
          queueWithoutDelivery,
        );
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
      await linkMemberKeysToParent(sql, included.map((m) => m.key), compositeKey);

      const claim = await claimEvent(sql, composed, message);
      if (claim === "duplicate") {
        const parentStatus = (await getEventStatuses(sql, [compositeKey])).get(compositeKey);
        if (parentStatus === "posted") {
          await reconcileKeysPosted(sql, included.map((m) => m.key)).catch(() => undefined);
        } else if (parentStatus === "uncertain") {
          await markKeysUncertain(
            sql,
            included.map((m) => m.key),
            new Error("parent Facebook outcome is uncertain"),
          ).catch(() => undefined);
        }
        // A claimed parent is still in flight; leave child claims linked and
        // let the winner confirm them or the stale-claim reconciler handle it.
        summary.duplicatesSkipped += 1;
        return;
      }

      const memberKeysToMark = included.map((m) => m.key);
      if (queueWithoutDelivery) {
        await handlePostFailure(compositeKey, memberKeysToMark, queueWithoutDelivery);
        return;
      }
      let post: { id: string };
      try {
        post = await postToFacebookPage(message);
      } catch (error) {
        await handlePostFailure(compositeKey, memberKeysToMark, error);
        return;
      }

      summary.posted += 1;
      let parentRecorded = false;
      try {
        await markEventPosted(sql, compositeKey, post.id);
        parentRecorded = true;
      } catch (error) {
        await markEventUncertain(sql, compositeKey, error).catch(() => undefined);
        await markKeysUncertain(sql, memberKeysToMark, error).catch(() => undefined);
        summary.notes.push(
          `Facebook delivered ${compositeKey}, but Neon acknowledgement failed; queued for reconciliation.`,
        );
      }
      if (parentRecorded) {
        // If this child update fails, reconcilePostedChildren repairs it at the
        // start of the next run from the confirmed posted parent.
        await markKeysPosted(sql, memberKeysToMark, post.id).catch((error) => {
          summary.notes.push(`Child claim acknowledgement deferred: ${errorMessage(error)}`);
        });
      }
      await recordSystemEvent(sql, "facebook_delivered", "live_update").catch(() => undefined);
      const entry = snapshots.get(candidate.fixtureId);
      if (entry) entry.snapshot = { ...entry.snapshot, lastPostedScoreline: current };
      await sleep(POST_DELAY_MS);
    };

    const outOfTime = () => Date.now() - startedAt.getTime() > RUN_TIME_BUDGET_MS;

    {

      // Missing credentials: queue every candidate immediately, without making
      // any Graph request. Expired credentials discovered during delivery set
      // authBlockError; every remaining candidate is then queued the same way.
      if (!facebookReady) {
        authBlocked = true;
        authBlockError = new FacebookConfigError(
          "FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN must both be configured",
        );
        summary.facebookAuthBlocked = true;
      }

      const publish = async (candidate: CandidateEvent) => {
        try {
          const queueError = authBlockError ?? undefined;
          if (candidate.kind === "live_update" || (candidate.members?.length ?? 0) > 0) {
            await postGroupedUpdate(candidate, queueError);
          } else {
            await postSingle(candidate, composeMessage(candidate), queueError);
          }
        } catch (error) {
          summary.postingFailed += 1;
          summary.notes.push(`Unexpected posting error (${candidate.eventKey}): ${errorMessage(error)}`);
        }
      };

      /**
       * PUBLISH IN MATCH ORDER.
       *
       * Posts go out chronologically (a 90+4 goal before the full-time line),
       * which is what a follower expects to read. Starvation protection is
       * preserved by treating milestones differently *within* the same pass:
       * milestones are exempt from the ordinary per-run post cap and get a
       * wider time allowance, so a busy run can never drop a full-time.
       */
      let ordinaryPosted = 0;
      let deferred = 0;
      for (const candidate of ordered) {
        const milestone = isMilestoneKind(candidate.kind);
        if (!milestone && ordinaryPosted >= MAX_POSTS_PER_RUN) {
          deferred += 1;
          continue;
        }
        const budget = milestone ? MILESTONE_TIME_BUDGET_MS : RUN_TIME_BUDGET_MS;
        if (Date.now() - startedAt.getTime() > budget) {
          if (milestone) {
            summary.milestonesDeferred += 1;
            summary.notes.push(`Milestone deferred to the next run (time budget): ${candidate.eventKey}`);
          } else {
            deferred += 1;
          }
          continue;
        }
        const before = summary.posted;
        await publish(candidate);
        if (summary.posted > before) {
          if (milestone) summary.milestonesPosted += 1;
          else ordinaryPosted += 1;
        }
      }
      if (deferred > 0) {
        summary.notes.push(`${deferred} ordinary event(s) deferred to the next run (cap or time budget).`);
      }

      /* 7b) Reconcile unknown Graph POST outcomes before any retry. */
      try {
        const uncertain = authBlocked ? [] : await loadUncertainEvents(sql, 50);
        if (uncertain.length > 0) {
          // One Page-feed read reconciles every uncertain post in this run.
          const recentPosts = await getRecentFacebookPagePosts(100);
          for (const item of uncertain) {
            const attemptedAt = Date.parse(item.updatedAt);
            const earliest = Number.isFinite(attemptedAt)
              ? attemptedAt - 5 * 60 * 1000
              : Date.now() - 24 * 60 * 60 * 1000;
            const match = recentPosts.find((post) => {
              if (post.message !== item.message) return false;
              const created = Date.parse(post.createdTime ?? "");
              return !Number.isFinite(created) || created >= earliest;
            });
            const childKeys = await loadChildEventKeys(sql, item.eventKey);
            if (match) {
              await markEventPosted(sql, item.eventKey, match.id);
              await markKeysPosted(sql, childKeys, match.id);
              summary.notes.push(`Reconciled Facebook post ${item.eventKey} as delivered.`);
              continue;
            }

            // The next cron run is normally 15 minutes later, beyond this
            // propagation grace. Only then is absence strong enough to release
            // the post for the ordinary bounded retry queue.
            if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt >= UNCERTAIN_RECONCILE_GRACE_MS) {
              await markEventFailed(
                sql,
                item.eventKey,
                new Error("Facebook feed reconciliation found no matching post"),
              );
              await releaseUncertainKeys(sql, childKeys);
              summary.notes.push(`Facebook post ${item.eventKey} confirmed absent; released for retry.`);
            }
          }
        }
      } catch (error) {
        // Feed unavailable or token invalid: leave every row uncertain. Never
        // risk a duplicate by converting an unknown outcome into a retry.
        summary.notes.push(`Facebook uncertain-outcome reconciliation deferred: ${errorMessage(error)}`);
      }

      /* 7c) Retry previously failed posts. Snapshot diffing will not recreate
             them, so they are replayed from their stored message. Database
             only - this never consumes API-Football requests. */
      try {
        const retryables = authBlocked ? [] : await loadRetryableEvents(sql, MAX_RETRIES_PER_RUN);
        const retryStates = await loadStates(
          sql,
          [...new Set(retryables.map((item) => item.fixtureId))],
        );
        for (const retryable of retryables) {
          // A retry must never resurrect an unapproved or unverifiable fixture.
          const retrySnapshot = retryStates.get(retryable.fixtureId)?.snapshot;
          if (
            !retrySnapshot ||
            classifyCompetition(
              retrySnapshot.leagueName,
              retrySnapshot.leagueCountry,
              retrySnapshot.leagueId ?? null,
            ) !== 1
          ) {
            summary.notes.push(
              `Retry blocked for fixture ${retryable.fixtureId}: competition cannot be re-verified.`,
            );
            continue;
          }
          if (outOfTime() || authBlocked) break;
          const claimed = await claimRetry(sql, retryable.eventKey);
          if (!claimed) continue;
          let post: { id: string };
          try {
            post = await postToFacebookPage(retryable.message);
          } catch (error) {
            await handlePostFailure(retryable.eventKey, [], error);
            summary.notes.push(`Retry failed (${retryable.eventKey}): ${errorMessage(error)}`);
            if (authBlocked) break;
            continue;
          }

          summary.retriedPosts += 1;
          summary.posted += 1;
          try {
            await markEventPosted(sql, retryable.eventKey, post.id);
          } catch (error) {
            await markEventUncertain(sql, retryable.eventKey, error).catch(() => undefined);
            summary.notes.push(
              `Facebook delivered retry ${retryable.eventKey}, but Neon acknowledgement failed; queued for reconciliation.`,
            );
          }
          await recordSystemEvent(
            sql,
            "facebook_delivered",
            `retry:${retryable.kind}`,
          ).catch(() => undefined);
          await sleep(POST_DELAY_MS);
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
