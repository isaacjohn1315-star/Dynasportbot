import { classifyCompetition, type Tier } from "./tiers";
import type {
  ApiFixture,
  ApiFixtureEvent,
  CandidateEvent,
  CandidateKind,
  FixtureSnapshot,
  MemberKind,
  SnapshotEvent,
  UpdateMember,
} from "./types";

/**
 * Match lifecycle engine (two-tier):
 *
 * Tier 1: full coverage - kickoff, grouped live updates (all new events from
 * the heartbeat listed under one 🚩 Live: status line), HT / 2H / ET / shootout
 * / FT / terminal statuses. Starting XI is handled separately in the pipeline.
 *
 * Only Tier 1 (popular, high-interest) competitions are processed; every
 * other competition is excluded upstream and produces no candidates.
 *
 * Every candidate carries stable deterministic event keys so repeated
 * 15-minute heartbeats never regenerate the same post.
 */

/**
 * API-Football v3 soccer status codes (verified against current docs):
 * TBD, NS, 1H, HT, 2H, ET, BT, P, SUSP, INT, FT, AET, PEN, PST, CANC, ABD, AWD, WO,
 * plus LIVE ("In Progress", used where coverage is minimal).
 */
const TERMINAL_STATUSES = new Set(["FT", "AET", "PEN", "PST", "CANC", "ABD", "AWD", "WO"]);
const NOT_STARTED_STATUSES = new Set(["TBD", "NS"]);
const IN_PLAY_STATUSES = new Set(["1H", "2H", "ET", "BT", "P", "INT", "SUSP", "LIVE"]);

/**
 * True when the fixture kicked off recently enough that publishing its final
 * result is still meaningful (and a backlog after downtime cannot flood the
 * page). Unparseable kickoff times are treated as stale - never guessed.
 */
export function isRecentKickoff(fixture: ApiFixture, maxAgeHours = 6): boolean {
  const date = fixture?.fixture?.date;
  if (typeof date !== "string" || !date) return false;
  const kickoff = Date.parse(date);
  if (!Number.isFinite(kickoff)) return false;
  const ageMs = Date.now() - kickoff;
  return ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
}

export function shortStatus(fixture: ApiFixture): string | null {
  const short = fixture.fixture?.status?.short;
  return typeof short === "string" && short.trim() ? short.trim().toUpperCase() : null;
}

export function isTerminalStatus(short: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has((short ?? "").toUpperCase());
}

/**
 * Anything that is not finished and not pre-match counts as in play.
 * `/fixtures?live=all` only returns matches in progress, so an unrecognised
 * status (a new provider code) must be treated as live rather than ignored -
 * otherwise a real match would be silently skipped.
 */
/** Statuses the formatter knows how to publish. */
export const KNOWN_STATUSES = new Set([
  "TBD", "NS", "1H", "HT", "2H", "ET", "BT", "P", "FT", "AET", "PEN",
  "SUSP", "INT", "PST", "CANC", "ABD", "AWD", "WO", "LIVE",
]);

/** Event types the pipeline can publish. Anything else is recorded, not invented. */
export const KNOWN_EVENT_TYPES = new Set(["goal", "card", "subst", "var"]);

export function isKnownStatus(short: string | null | undefined): boolean {
  return KNOWN_STATUSES.has((short ?? "").trim().toUpperCase());
}

export function isKnownEventType(type: string | null | undefined): boolean {
  return KNOWN_EVENT_TYPES.has((type ?? "").trim().toLowerCase());
}

export function isInPlay(short: string | null | undefined): boolean {
  const value = (short ?? "").toUpperCase();
  if (!value) return false;
  if (IN_PLAY_STATUSES.has(value)) return true;
  return !TERMINAL_STATUSES.has(value) && !NOT_STARTED_STATUSES.has(value);
}

export function competitionTier(fixture: ApiFixture): Tier {
  return classifyCompetition(
    fixture.league?.name,
    fixture.league?.country ?? null,
    typeof fixture.league?.id === "number" ? fixture.league.id : null,
  );
}

/** Considered "just started" enough to narrate kickoff + early events. */
const EARLY_KICKOFF_WINDOW_MINUTES = 20;

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Non-empty display string, or the fallback. Never yields "undefined"/"null". */
function safeName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Optional player/person name: empty and placeholder values become null. */
function safeOptionalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") {
    return null;
  }
  return trimmed;
}

/** Score values are only trusted when they are real finite numbers. */
function safeGoals(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function safeEvents(value: unknown): ApiFixtureEvent[] {
  return Array.isArray(value) ? (value.filter((e) => e && typeof e === "object") as ApiFixtureEvent[]) : [];
}

function parseFlagCode(flagUrl: string | null | undefined): string | null {
  if (!flagUrl) return null;
  const match = /\/flags\/([a-z]{2})\.[a-z0-9]+/i.exec(flagUrl);
  return match ? match[1].toLowerCase() : null;
}

/**
 * STABLE event identity - the backbone of duplicate prevention.
 *
 * The previous key hashed raw API fields (assist name, player display name,
 * elapsed and extra separately, and the detail text). API-Football refines
 * events IN PLACE after first publishing them:
 *   - an assist is often added a few minutes after the goal
 *   - player names are normalised ("K. Havertz" -> "Kai Havertz")
 *   - injury time is normalised (elapsed 90 + extra 3 -> elapsed 93)
 *   - VAR wording is refined ("Goal cancelled" -> "Goal Disallowed - offside")
 * Any of those minted a NEW key, so the SAME goal/card/VAR was posted twice.
 *
 * The identity is therefore built ONLY from stable facts:
 *   classified kind + team + player SURNAME + total minute.
 * The classified kind is stable because it maps reworded details to the same
 * outcome, and the surname is stable across first-initial/name changes.
 */
function surnameOf(playerName: string | null | undefined): string {
  const name = norm(playerName);
  if (!name) return "";
  const words = name.split(" ").filter(Boolean);
  return words[words.length - 1] ?? name;
}

function totalMinuteOf(minute: number | null | undefined, extra: number | null | undefined): string {
  if (minute == null || !Number.isFinite(minute)) return "";
  return String(minute + (extra ?? 0));
}

/** Classify an API event into its stable DynaSport kind. */
export function classifyEventKind(type: string, detail: string): MemberKind | null {
  const t = norm(type);
  const d = norm(detail);
  if (t === "goal") {
    if (d.includes("missed penalty")) return "missed_penalty";
    if (d.includes("own goal")) return "own_goal";
    if (d.includes("penalty")) return "penalty_goal";
    return "goal";
  }
  if (t === "card") {
    return d.includes("red") || d.includes("second yellow") ? "red_card" : "yellow_card";
  }
  if (t === "subst") return "substitution";
  if (t === "var") {
    if (d.includes("card upgraded") || d.includes("red card")) return "var_red_upgrade";
    if (d.includes("goal cancelled") || d.includes("goal disallowed")) return "var_goal_disallowed";
    if (d.includes("goal confirmed") || d.includes("goal awarded")) return "var_goal_awarded";
    if (d.includes("penalty cancelled") || d.includes("penalty disallowed") || d.includes("penalty overturned")) return "var_penalty_overturned";
    if (d.includes("penalty confirmed") || d.includes("penalty awarded")) return "var_penalty_awarded";
    return "var_review";
  }
  // Corners, statistics and unknown incident types are never published.
  return null;
}

/** Stable identity for a raw API-Football event. */
export function stableEventIdentity(
  type: string | null | undefined,
  detail: string | null | undefined,
  teamName: string | null | undefined,
  playerName: string | null | undefined,
  minute: number | null | undefined,
  extra: number | null | undefined,
): string {
  const kind = classifyEventKind(type ?? "", detail ?? "");
  if (!kind) return "";
  return [kind, norm(teamName), surnameOf(playerName), totalMinuteOf(minute, extra)].join("|");
}

/** Stable identity computed from a stored snapshot event (raw fields kept). */
function identityOfSnapshotEvent(event: SnapshotEvent): string {
  return stableEventIdentity(event?.type, event?.detail, event?.teamName, event?.player, event?.minute, event?.extra);
}

/** Stable identity computed from a fresh API event. */
function identityOfApiEvent(event: ApiFixtureEvent): string {
  return stableEventIdentity(
    typeof event?.type === "string" ? event.type : "",
    typeof event?.detail === "string" ? event.detail : "",
    event?.team?.name,
    event?.player?.name,
    typeof event?.time?.elapsed === "number" ? event.time.elapsed : null,
    typeof event?.time?.extra === "number" ? event.time.extra : null,
  );
}

function toSnapshotEvent(event: ApiFixtureEvent): SnapshotEvent {
  const elapsed = event.time?.elapsed;
  const extra = event.time?.extra;
  return {
    key: identityOfApiEvent(event),
    type: typeof event.type === "string" ? event.type : "",
    detail: typeof event.detail === "string" ? event.detail : "",
    minute: typeof elapsed === "number" && Number.isFinite(elapsed) ? elapsed : null,
    extra: typeof extra === "number" && Number.isFinite(extra) ? extra : null,
    teamName: safeName(event.team?.name, ""),
    player: safeOptionalName(event.player?.name),
    assist: safeOptionalName(event.assist?.name),
    comments: safeOptionalName(event.comments),
  };
}

/** Tolerates partial fixtures: missing teams, league, score or events. */
export function buildSnapshot(fixture: ApiFixture): FixtureSnapshot {
  const status = fixture.fixture?.status;
  const elapsed = status?.elapsed;
  return {
    fixtureId: fixture.fixture.id,
    kickoffAt: typeof fixture.fixture?.date === "string" ? fixture.fixture.date : null,
    leagueName: safeName(fixture.league?.name, "Unknown competition"),
    leagueCountry: safeOptionalName(fixture.league?.country),
    leagueFlagCode: parseFlagCode(fixture.league?.flag),
    home: safeName(fixture.teams?.home?.name, "Home"),
    away: safeName(fixture.teams?.away?.name, "Away"),
    statusShort: shortStatus(fixture),
    elapsed: typeof elapsed === "number" && Number.isFinite(elapsed) ? elapsed : null,
    goalsHome: safeGoals(fixture.goals?.home),
    goalsAway: safeGoals(fixture.goals?.away),
    pensHome: safeGoals(fixture.score?.penalty?.home),
    pensAway: safeGoals(fixture.score?.penalty?.away),
    events: safeEvents(fixture.events).map(toSnapshotEvent),
    lineupPosted: false,
    lastPostedScoreline: null,
  };
}

/* ------------------------------ Candidate helpers ------------------------------ */

function baseCandidate(fixture: ApiFixture, kind: CandidateKind, minute: number | null, sortRank: number): CandidateEvent {
  const id = fixture.fixture.id;
  return {
    eventKey: "",
    fixtureId: id,
    kind,
    minute,
    sortRank,
    league: safeName(fixture.league?.name, "Unknown competition"),
    leagueCountry: safeOptionalName(fixture.league?.country),
    leagueFlagCode: parseFlagCode(fixture.league?.flag),
    home: safeName(fixture.teams?.home?.name, "Home"),
    away: safeName(fixture.teams?.away?.name, "Away"),
    goalsHome: safeGoals(fixture.goals?.home),
    goalsAway: safeGoals(fixture.goals?.away),
    pensHome: safeGoals(fixture.score?.penalty?.home),
    pensAway: safeGoals(fixture.score?.penalty?.away),
    statusShort: shortStatus(fixture),
  };
}

const STATUS_KIND_MAP: Record<string, CandidateKind> = {
  HT: "halftime",
  "2H": "second_half",
  ET: "extra_time",
  BT: "extra_time_break",
  P: "penalty_shootout",
  FT: "fulltime",
  AET: "fulltime",
  PEN: "fulltime",
  PST: "postponed",
  CANC: "cancelled",
  ABD: "abandoned",
  SUSP: "suspended",
  INT: "interrupted",
  AWD: "awarded",
  WO: "walkover",
};

const STATUS_SORT_MINUTES: Record<string, number> = {
  HT: 45,
  "2H": 46,
  ET: 91,
  BT: 106,
  P: 121,
  SUSP: 995,
  INT: 996,
  FT: 997,
  AET: 997,
  PEN: 997,
  PST: 998,
  CANC: 998,
  ABD: 998,
  AWD: 998,
  WO: 998,
};

/**
 * Build a post for a status transition. Returns null for a status the
 * formatter does not know, so an unrecognised code is never published with an
 * invented label (the pipeline records it for review instead).
 */
function statusCandidate(fixture: ApiFixture, short: string): CandidateEvent | null {
  const kind = STATUS_KIND_MAP[short];
  if (!kind) return null;
  const c = baseCandidate(fixture, kind, STATUS_SORT_MINUTES[short] ?? fixture.fixture.status.elapsed ?? null, 3);
  c.eventKey = `fx${fixture.fixture.id}:status:${short}`;
  return c;
}

/** Map an API timeline event to a live_update member (null = not post-worthy). */
export function toUpdateMember(event: SnapshotEvent): UpdateMember | null {
  const type = norm(event.type);
  const detail = norm(event.detail);

  let kind: MemberKind | null = null;
  if (type === "goal") {
    if (detail.includes("missed penalty")) kind = "missed_penalty";
    else if (detail.includes("own goal")) kind = "own_goal";
    else if (detail.includes("penalty")) kind = "penalty_goal";
    else kind = "goal";
  } else if (type === "card") {
    kind = detail.includes("red") || detail.includes("second yellow") ? "red_card" : "yellow_card";
  } else if (type === "subst") {
    kind = "substitution";
  } else if (type === "var") {
    /**
     * API-Football reports VAR outcomes through the `detail` string
     * ("Goal cancelled", "Penalty confirmed", "Card upgraded", ...).
     * Map them to precise, fan-readable decisions. An unmapped or empty
     * detail becomes a generic review which the formatter drops unless the
     * text is meaningful - we never claim a decision changed.
     */
    if (detail.includes("card upgraded") || detail.includes("red card")) kind = "var_red_upgrade";
    else if (detail.includes("goal cancelled") || detail.includes("goal disallowed")) kind = "var_goal_disallowed";
    else if (detail.includes("goal confirmed") || detail.includes("goal awarded")) kind = "var_goal_awarded";
    else if (detail.includes("penalty cancelled") || detail.includes("penalty disallowed") || detail.includes("penalty overturned")) kind = "var_penalty_overturned";
    else if (detail.includes("penalty confirmed") || detail.includes("penalty awarded")) kind = "var_penalty_awarded";
    else kind = "var_review";
  }
  // Everything else - corners, statistics and any unknown incident type - is
  // deliberately NOT published. Unknown types are ignored, never invented.

  if (!kind) return null;
  const minute = event.minute != null ? event.minute + (event.extra ?? 0) : null;
  return {
    key: "", // deterministic member key assigned by the caller (fixture-scoped)
    kind,
    minute,
    extra: event.extra,
    teamName: event.teamName,
    player: event.player,
    assist: event.assist,
    // Raw API detail only. An empty detail stays empty so the formatter can
    // skip the event instead of publishing a meaningless placeholder.
    detail: typeof event.detail === "string" ? event.detail.trim() : "",
    comments: event.comments ?? null,
  };
}

function memberKey(fixtureId: number, event: SnapshotEvent): string {
  return `fx${fixtureId}:ev:${identityOfSnapshotEvent(event)}`;
}

function toMembers(fixtureId: number, events: SnapshotEvent[]): UpdateMember[] {
  const members: UpdateMember[] = [];
  for (const event of events) {
    const member = toUpdateMember(event);
    if (member) members.push({ ...member, key: memberKey(fixtureId, event) });
  }
  return members;
}

function liveUpdateCandidate(
  fixture: ApiFixture,
  members: UpdateMember[],
  options: { scoreChanged: boolean; joined?: boolean; prevHome: number | null; prevAway: number | null },
): CandidateEvent {
  const c = baseCandidate(fixture, "live_update", fixture.fixture.status.elapsed ?? null, 1);
  c.members = members;
  c.scoreChanged = options.scoreChanged;
  c.joined = options.joined ?? false;
  c.prevHome = options.prevHome;
  c.prevAway = options.prevAway;
  c.eventKey = members[0]?.key ?? `fx${fixture.fixture.id}:lu:placeholder`;
  c.category = members.length > 0 ? eventCategory(members[0].kind) : "goal";
  return c;
}

/* --------------------------------- Diff engine --------------------------------- */

export interface DiffOptions {
  /** True when fixture_state is empty (first ever run): silent baseline, no posts. */
  bootstrap: boolean;
}

export function diffFixture(
  previous: FixtureSnapshot | null,
  fixture: ApiFixture,
  options: DiffOptions,
): CandidateEvent[] {
  if (options.bootstrap) return [];

  const id = fixture.fixture.id;
  const tier = competitionTier(fixture);
  const nextShort = shortStatus(fixture);
  const rawElapsed = fixture.fixture?.status?.elapsed;
  const elapsed = typeof rawElapsed === "number" && Number.isFinite(rawElapsed) ? rawElapsed : null;
  const rawHome = safeGoals(fixture.goals?.home);
  const rawAway = safeGoals(fixture.goals?.away);

  /**
   * A temporarily missing score must never be read as 0-0: that would publish
   * a wrong scoreline and then publish the real score again as a "change".
   * When the feed omits goals but we already know them, keep the known score
   * and suppress score-change detection for this heartbeat.
   */
  const scoreUnknown = rawHome === null || rawAway === null;
  const nextHome = rawHome ?? previous?.goalsHome ?? 0;
  const nextAway = rawAway ?? previous?.goalsAway ?? 0;
  const nextEvents = safeEvents(fixture.events).map(toSnapshotEvent);
  const candidates: CandidateEvent[] = [];

  /** Ensure every emitted candidate carries the resolved (never null) score. */
  const finish = (list: CandidateEvent[]): CandidateEvent[] =>
    sortCandidates(
      list.map((c) => ({ ...c, goalsHome: c.goalsHome ?? nextHome, goalsAway: c.goalsAway ?? nextAway })),
    );

  /**
   * Tier 2 (low-interest) competitions are not covered by the platform.
   * They are filtered out before reaching this engine; this guard makes the
   * rule explicit and total - no candidate is ever produced for them.
   */
  if (tier !== 1) return [];

  /* -------------------------------- Tier 1: full -------------------------------- */

  if (!previous) {
    // First time this fixture appears in the live heartbeat.
    const members = toMembers(id, nextEvents);

    /**
     * FULL-TIME RECOVERY (first seen already finished).
     *
     * Finished fixtures leave "/fixtures?live=all" roughly 5-20 minutes after
     * the final whistle, so a match that ends between two 15-minute polls is
     * often FIRST seen in a terminal state. Previously this branch produced
     * nothing for terminal statuses, so those full-times were never posted.
     * The confirmed final status is now published, bounded by a freshness
     * window so a long outage cannot flood the page with stale results.
     */
    if (nextShort && isTerminalStatus(nextShort) && isRecentKickoff(fixture)) {
      const finalPost = statusCandidate(fixture, nextShort);
      if (finalPost) candidates.push(finalPost);
      return finish(candidates);
    }

    if (nextShort === "1H" && (elapsed == null || elapsed <= EARLY_KICKOFF_WINDOW_MINUTES) && nextHome === 0 && nextAway === 0) {
      const kickoff = baseCandidate(fixture, "kickoff", 0, -5);
      kickoff.eventKey = `fx${id}:kickoff`;
      kickoff.scoreChanged = false;
      kickoff.prevHome = 0;
      kickoff.prevAway = 0;
      candidates.push(kickoff);
    } else if (!isTerminalStatus(nextShort)) {
      // Mid-match join: publish the current events, split by category.
      const joinBuckets = new Map<string, UpdateMember[]>();
      for (const member of members) {
        if (isPerIncidentKind(member.kind)) {
          joinBuckets.set(`${member.kind}:${member.key}`, [member]);
        } else {
          const category = eventCategory(member.kind);
          joinBuckets.set(category, [...(joinBuckets.get(category) ?? []), member]);
        }
      }
      for (const bucketMembers of joinBuckets.values()) {
        candidates.push(
          liveUpdateCandidate(fixture, bucketMembers, {
            scoreChanged: false,
            joined: true,
            prevHome: null,
            prevAway: null,
          }),
        );
      }
      if (joinBuckets.size === 0 && (nextHome !== 0 || nextAway !== 0)) {
        candidates.push(
          liveUpdateCandidate(fixture, [], { scoreChanged: true, joined: true, prevHome: null, prevAway: null }),
        );
      }
    }
    return finish(candidates);
  }

  const prevShort = (previous.statusShort ?? "").toUpperCase();
  const prevHome = previous.goalsHome ?? 0;
  const prevAway = previous.goalsAway ?? 0;
  const scoreChanged = !scoreUnknown && (nextHome !== prevHome || nextAway !== prevAway);

  /**
   * New timeline events since the stored snapshot.
   * `previous.events` is read defensively: a legacy or partially-written
   * snapshot row without an events array used to throw here, which aborted
   * the whole fixture and silently lost its milestones (including FT).
   */
  const previousEvents = Array.isArray(previous.events) ? previous.events : [];
  /**
   * Compare by STABLE identity computed from the raw fields on BOTH sides, so
   * a previously stored event is still recognised after the provider refines
   * its assist, player name, minute or detail wording. This is what prevents
   * the same goal being posted twice.
   */
  const previousIdentities = new Set(
    previousEvents.map((e) => identityOfSnapshotEvent(e)).filter((k) => k.length > 0),
  );
  const freshSnapshotEvents = nextEvents.filter((e) => !previousIdentities.has(identityOfSnapshotEvent(e)));
  let members = toMembers(id, freshSnapshotEvents);

  /**
   * Penalty-shootout kicks: while the shootout is in progress (status P) the
   * match score no longer changes - shootout progress is reported through
   * score.penalty (shootout_update). Goal events during P are shootout kicks,
   * not match goals, and must not be published as goals.
   */
  if (nextShort === "P") {
    members = members.filter((m) => eventCategory(m.kind) !== "goal");
  }

  /**
   * Disallowed goals: when API-Football reports a confirmed "Goal cancelled"
   * VAR decision for a team at a minute, a goal event for that same team and
   * minute must not also be published as a scored goal. The cancellation is
   * confirmed by the provider, so suppressing the matching goal uses confirmed
   * data rather than inference.
   */
  const disallowed = members.filter((m) => m.kind === "var_goal_disallowed");
  if (disallowed.length > 0) {
    members = members.filter((m) => {
      if (eventCategory(m.kind) !== "goal") return true;
      return !disallowed.some(
        (d) => d.teamName === m.teamName && d.minute === m.minute,
      );
    });
  }

  /**
   * CATEGORY SPLITTING.
   * Events of different categories are never mixed in one post: goals (with
   * assists), cards, substitutions, missed penalties and VAR decisions each
   * produce their own post. Within a category the existing grouping is kept -
   * several goals still share one post, as do several cards or substitutions.
   * VAR decisions are split per incident because separate VAR incidents are
   * unrelated to one another.
   */
  const buckets = new Map<string, UpdateMember[]>();
  for (const member of members) {
    if (isPerIncidentKind(member.kind)) {
      /**
       * Each GOAL (with its assist), each RED CARD, each MISSED PENALTY and
       * each VAR decision is published as its own post. Yellow cards and
       * substitutions keep the existing same-category grouping.
       */
      buckets.set(`${member.kind}:${member.key}`, [member]);
    } else {
      const category = eventCategory(member.kind);
      buckets.set(category, [...(buckets.get(category) ?? []), member]);
    }
  }

  // A score change with no goal event still produces a score-only update.
  const goalEntries = [...buckets.entries()].filter(([k]) => k.startsWith("goal:"));
  if (goalEntries.length > 0) {
    for (const [, goalMembers] of goalEntries) {
      candidates.push(
        liveUpdateCandidate(fixture, goalMembers, { scoreChanged, prevHome, prevAway }),
      );
    }
  } else if (scoreChanged) {
    candidates.push(
      liveUpdateCandidate(fixture, [], { scoreChanged, prevHome, prevAway }),
    );
  }
  for (const [bucketKey, bucketMembers] of buckets) {
    if (bucketKey.startsWith("goal:")) continue;
    candidates.push(
      liveUpdateCandidate(fixture, bucketMembers, { scoreChanged: false, prevHome, prevAway }),
    );
  }

  // Status transitions as individual posts.
  if (nextShort && nextShort !== prevShort && STATUS_KIND_MAP[nextShort]) {
    const statusPost = statusCandidate(fixture, nextShort);
    if (statusPost) candidates.push(statusPost);
  }

  // Penalty shootout score ticks (API has no per-kick events in the heartbeat).
  if (nextShort === "P") {
    const prevPens = `${previous.pensHome ?? ""}-${previous.pensAway ?? ""}`;
    const nextPens = `${fixture.score?.penalty?.home ?? ""}-${fixture.score?.penalty?.away ?? ""}`;
    if (prevPens !== nextPens && nextPens !== "-") {
      const c = baseCandidate(fixture, "shootout_update", elapsed, 5);
      c.eventKey = `fx${id}:pens:${nextPens}`;
      c.prevHome = prevHome;
      c.prevAway = prevAway;
      candidates.push(c);
    }
  }

  return finish(candidates);
}

/**
 * Major match-state milestones. These get an independent processing path and
 * are never queued behind goals, lineups, cards or other ordinary events.
 * Kick-off, HT, 2H, ET, ET break, shootout start/updates, FT/AET/PEN and the
 * terminal statuses (postponed/cancelled/abandoned/suspended/interrupted/
 * awarded/walkover) all qualify.
 */
export const MILESTONE_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  "kickoff",
  "halftime",
  "second_half",
  "extra_time",
  "extra_time_break",
  "penalty_shootout",
  "shootout_update",
  "fulltime",
  "postponed",
  "cancelled",
  "abandoned",
  "suspended",
  "interrupted",
  "awarded",
  "walkover",
]);

export function isMilestoneKind(kind: CandidateKind): boolean {
  return MILESTONE_KINDS.has(kind);
}

/**
 * Event category for grouping. Only events of the SAME category may share a
 * post: goals (with their assists), cards, substitutions, missed penalties and
 * VAR decisions. VAR decisions are additionally split per incident, because
 * separate VAR incidents are unrelated to one another.
 */
export type EventCategory = "goal" | "card" | "substitution" | "penalty" | "var";

/**
 * Events that must each be published as their OWN post, never grouped with
 * anything else: goals (with their assist), red cards, missed penalties and
 * every VAR decision. Yellow cards and substitutions keep the existing
 * same-category grouping.
 */
export function isPerIncidentKind(kind: MemberKind): boolean {
  switch (kind) {
    case "red_card":
    case "missed_penalty":
      return true;
    default:
      // Goals and every VAR outcome are per-incident.
      return eventCategory(kind) === "goal" || eventCategory(kind) === "var";
  }
}

export function eventCategory(kind: MemberKind): EventCategory {
  switch (kind) {
    case "goal":
    case "penalty_goal":
    case "own_goal":
      return "goal";
    case "yellow_card":
    case "red_card":
      return "card";
    case "substitution":
      return "substitution";
    case "missed_penalty":
      return "penalty";
    default:
      // Every VAR outcome (upgrade, goal cancelled/awarded, penalty
      // awarded/overturned, generic review).
      return "var";
  }
}

/** Event kinds that deserve their own post rather than being grouped. */
const TOP_INCIDENT_MEMBERS: ReadonlySet<string> = new Set([
  "red_card",
  "var_red_upgrade",
  "var_goal_disallowed",
  "var_goal_awarded",
  "var_penalty_awarded",
  "var_penalty_overturned",
]);

export function isTopIncidentMember(kind: string): boolean {
  return TOP_INCIDENT_MEMBERS.has(kind);
}

const KIND_RANK: Record<CandidateKind, number> = {
  lineup: -6,
  kickoff: -5,
  live_update: 1,
  halftime: 5,
  second_half: 5,
  extra_time: 5,
  extra_time_break: 5,
  penalty_shootout: 5,
  shootout_update: 5,
  fulltime: 6,
  suspended: 7,
  interrupted: 7,
  postponed: 8,
  cancelled: 8,
  abandoned: 8,
  awarded: 8,
  walkover: 8,
};

export function sortCandidates(candidates: CandidateEvent[]): CandidateEvent[] {
  return [...candidates].sort((a, b) => {
    const minuteDelta = (a.minute ?? 1000) - (b.minute ?? 1000);
    if (minuteDelta !== 0) return minuteDelta;
    const kindDelta = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const rankDelta = a.sortRank - b.sortRank;
    if (rankDelta !== 0) return rankDelta;
    return a.fixtureId - b.fixtureId;
  });
}
