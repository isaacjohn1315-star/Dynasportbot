/**
 * API-Football v3 response shapes (only the fields DynaSport consumes)
 * plus the internal snapshot/candidate types used by the lifecycle engine.
 */

export interface ApiFixtureStatus {
  long: string | null;
  short: string | null;
  elapsed: number | null;
  extra?: number | null;
}

export interface ApiTeamRef {
  id: number | null;
  name: string;
  logo?: string | null;
  winner?: boolean | null;
}

export interface ApiScoreLine {
  home: number | null;
  away: number | null;
}

export interface ApiFixtureScore {
  halftime: ApiScoreLine;
  fulltime: ApiScoreLine;
  extratime?: ApiScoreLine;
  penalty?: ApiScoreLine;
}

export interface ApiLeague {
  id: number | null;
  name: string;
  country?: string | null;
  logo?: string | null;
  flag?: string | null;
  season?: number | null;
  round?: string | null;
}

export interface ApiFixtureEvent {
  time: { elapsed: number | null; extra?: number | null };
  team: { id: number | null; name: string; logo?: string | null };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string | null;
  comments: string | null;
}

export interface ApiFixture {
  fixture: {
    id: number;
    referee?: string | null;
    timezone?: string;
    date: string;
    timestamp?: number;
    venue?: { id: number | null; name: string | null; city: string | null };
    status: ApiFixtureStatus;
  };
  league: ApiLeague;
  teams: { home: ApiTeamRef; away: ApiTeamRef };
  goals: { home: number | null; away: number | null };
  score: ApiFixtureScore;
  events?: ApiFixtureEvent[];
}

export interface ApiLineupPlayer {
  id: number | null;
  name: string;
  number: number | null;
  pos: string | null;
  grid: string | null;
}

export interface ApiLineupEntry {
  player: ApiLineupPlayer;
}

export interface ApiLineup {
  team: ApiTeamRef;
  coach?: { id: number | null; name: string | null; photo?: string | null };
  formation: string;
  startXI: ApiLineupEntry[];
  substitutes?: ApiLineupEntry[];
}

/* ---------------------------------- Snapshots ---------------------------------- */

export interface SnapshotEvent {
  key: string;
  type: string;
  detail: string;
  minute: number | null;
  extra: number | null;
  teamName: string;
  player: string | null;
  assist: string | null;
  comments?: string | null;
}

export interface FixtureSnapshot {
  fixtureId: number;
  kickoffAt: string | null;
  leagueName: string;
  leagueCountry: string | null;
  leagueFlagCode: string | null;
  home: string;
  away: string;
  statusShort: string | null;
  elapsed: number | null;
  goalsHome: number | null;
  goalsAway: number | null;
  pensHome: number | null;
  pensAway: number | null;
  events: SnapshotEvent[];
  lineupPosted: boolean;
  /** Scoreline that was last shown in a posted live/score update, e.g. "2-0". */
  lastPostedScoreline?: string | null;
}

/* ---------------------------------- Candidates ---------------------------------- */

/**
 * Candidates are per-fixture, per-run posting units:
 * Only Tier 1 (popular, high-interest) competitions are covered: kickoff,
 * starting XI, one grouped "live_update" per score update (all new events
 * listed under the 🚩 Live: status line) and status transitions
 * (HT / 2nd Half / ET / shootout / FT / terminal statuses).
 */
export type CandidateKind =
  | "kickoff"
  | "lineup"
  | "live_update"
  | "halftime"
  | "second_half"
  | "extra_time"
  | "extra_time_break"
  | "penalty_shootout"
  | "shootout_update"
  | "fulltime"
  | "postponed"
  | "cancelled"
  | "abandoned"
  | "suspended"
  | "interrupted"
  | "awarded"
  | "walkover";

export type MemberKind =
  | "goal"
  | "own_goal"
  | "penalty_goal"
  | "missed_penalty"
  | "yellow_card"
  | "red_card"
  | "substitution"
  /* VAR outcomes, derived from the provider's own detail strings. */
  | "var_red_upgrade"
  | "var_goal_disallowed"
  | "var_goal_awarded"
  | "var_penalty_awarded"
  | "var_penalty_overturned"
  | "var_review";

/** One API-Football timeline event inside a grouped live update. */
export interface UpdateMember {
  key: string;
  kind: MemberKind;
  minute: number | null;
  extra: number | null;
  teamName: string;
  player: string | null;
  assist: string | null;
  detail: string;
  comments?: string | null;
}

export interface LineupPostData {
  homeFormation: string;
  awayFormation: string;
  /** "Team XI: GK; line, line; line" strings, one per team. */
  homeXI: string;
  awayXI: string;
  /** Verified country flag for each team ("" when unverifiable). */
  homeFlag: string;
  awayFlag: string;
}

export interface CandidateEvent {
  eventKey: string;
  fixtureId: number;
  kind: CandidateKind;
  minute: number | null;
  sortRank: number;
  league: string;
  leagueCountry: string | null;
  leagueFlagCode: string | null;
  home: string;
  away: string;
  goalsHome: number | null;
  goalsAway: number | null;
  pensHome: number | null;
  pensAway: number | null;
  statusShort: string | null;
  /** Timeline events belonging to this score update (live_update only). */
  members?: UpdateMember[];
  /**
   * Event category of a live_update ("goal" | "card" | "substitution" |
   * "penalty" | "var"). Events of different categories are NEVER mixed in one
   * post; each category produces its own post.
   */
  category?: string;
  /** True when the score changed since the stored snapshot. */
  scoreChanged?: boolean;
  /** First time this fixture is seen in-play (Tier 1 "now tracking" post). */
  joined?: boolean;
  prevHome?: number | null;
  prevAway?: number | null;
  detail?: string | null;
  lineup?: LineupPostData;
}
