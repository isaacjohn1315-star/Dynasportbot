import type { ApiLineup, CandidateEvent, LineupPostData, UpdateMember } from "./types";

/**
 * DynaSport Facebook templates - data only, NO hashtags, NO commentary,
 * NO corners, NO statistics, NO filler.
 *
 *   🚩 Live: Argentina 1-0 Benin
 *   <blank>
 *   ⚽️ Goal: Otamendi (48’)
 *   🎯 L. Messi
 *   <blank>
 *   🟨 Yellow Card: Player Name (42’)
 *
 * Spacing (enforced here, not left to Facebook):
 *  - one blank line between the status line and the event details
 *  - goal and its assist on CONSECUTIVE lines (no blank line between)
 *  - exactly one blank line between separate event GROUPS (goal group vs card
 *    vs substitution, etc.)
 *  - no trailing spaces, no extra blank lines, no headings
 */

/** Typographic apostrophe used for match minutes, per the DynaSport templates. */
const MIN = "\u2019";

/** Assemble a post: status line + one blank line + event groups, single newline between parts. */
function buildPost(statusLine: string, groups: string[][]): string {
  const parts: string[] = [statusLine];
  for (const group of groups) {
    const lines = group.filter((line) => typeof line === "string" && line.trim().length > 0);
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  return parts.join("\n\n").replace(/[ \t]+$/gm, "");
}

function scoreOf(c: CandidateEvent): string {
  return `${c.home} ${c.goalsHome ?? 0}-${c.goalsAway ?? 0} ${c.away}`;
}

function pensOf(c: CandidateEvent): string {
  return `${c.home} ${c.pensHome ?? 0}-${c.pensAway ?? 0} ${c.away}`;
}

function versusOf(c: CandidateEvent): string {
  return `${c.home} vs ${c.away}`;
}

/** Minute text, preserving injury time: 90+4 stays 90+4. */
function minuteOf(m: UpdateMember): string {
  if (m.minute == null) return "";
  return m.extra != null && m.extra > 0 ? `${m.minute - m.extra}+${m.extra}` : `${m.minute}`;
}

/**
 * Format one real API-Football event as an event GROUP (goal+assist share a
 * group - the assist sits directly beneath the goal with no blank line).
 * Returns [] for anything that must never be published (corners, statistics,
 * unknown incidents).
 */
export function formatMemberGroup(m: UpdateMember): string[] {
  const minute = minuteOf(m);
  const time = minute ? ` (${minute}${MIN})` : "";
  const who = (m.player ?? "").trim();

  switch (m.kind) {
    case "goal": {
      if (!who) return [];
      const lines = [`⚽️ Goal: ${who}${time}`];
      if (m.assist) lines.push(`🎯 ${m.assist}`);
      return lines;
    }
    case "penalty_goal":
      return who ? [`⚽️ Penalty Goal: ${who}${time}`] : [];
    case "own_goal":
      return who ? [`⚽️ Own Goal: ${who}${time}`] : [];
    case "missed_penalty":
      return who ? [`❌ Penalty Missed: ${who}${time}`] : [];
    case "yellow_card":
      return who ? [`🟨 Yellow Card: ${who}${time}`] : [];
    case "red_card":
      return who ? [`🟥 Red Card: ${who}${time}`] : [];
    case "substitution": {
      const off = (m.player ?? "").trim();
      const on = (m.assist ?? "").trim();
      if (off && on) return [`🔄 Substitution: ${on} replaces ${off}${time}`];
      return [];
    }
    /* ------------------------------ VAR outcomes ------------------------------ */
    case "var_red_upgrade":
      // Yellow upgraded to red after review. Only claimed when the provider
      // explicitly reports the upgrade.
      return who ? [`🟥 Red Card (VAR upgrade): ${who}${time}`] : [];
    case "var_goal_disallowed":
      return [`🚫 Goal disallowed after VAR${who ? `: ${who}` : ""}${time}`];
    case "var_goal_awarded":
      return [`⚽️ Goal awarded after VAR${who ? `: ${who}` : ""}${time}`];
    case "var_penalty_awarded":
      return [`⚖️ Penalty awarded after VAR${who ? `: ${who}` : ""}${time}`];
    case "var_penalty_overturned":
      return [`⚖️ Penalty overturned after VAR${who ? `: ${who}` : ""}${time}`];
    case "var_review": {
      // No confirmed outcome: publish only if the provider supplied readable
      // text, and never assert that a decision changed.
      const detail = (m.detail ?? "").trim();
      if (!detail) return [];
      return [`📺 VAR review: ${detail}${time}`];
    }
    default:
      return [];
  }
}

/**
 * @deprecated Use {@link formatMemberGroup}. Kept for compatibility with any
 * callers expecting flat lines; groups are flattened with newlines.
 */
export function formatMemberLines(m: UpdateMember): string[] {
  return formatMemberGroup(m);
}

const MEMBER_ORDER: Record<UpdateMember["kind"], number> = {
  goal: 0,
  penalty_goal: 0,
  own_goal: 0,
  missed_penalty: 1,
  red_card: 2,
  yellow_card: 3,
  var_red_upgrade: 2,
  var_goal_disallowed: 4,
  var_goal_awarded: 4,
  var_penalty_awarded: 4,
  var_penalty_overturned: 4,
  var_review: 4,
  substitution: 5,
};

/** Chronological event groups (each is one blank-line-separated block). */
function memberGroups(c: CandidateEvent): string[][] {
  const sorted = [...(c.members ?? [])].sort((a, b) => {
    const minuteDelta = (a.minute ?? 0) - (b.minute ?? 0);
    if (minuteDelta !== 0) return minuteDelta;
    return MEMBER_ORDER[a.kind] - MEMBER_ORDER[b.kind];
  });
  return sorted
    .map((m) => formatMemberGroup(m))
    .filter((g) => g.filter((line) => line.trim().length > 0).length > 0);
}

/* ------------------------------ Starting XI ------------------------------ */

function formatXI(startXI: ApiLineup["startXI"]): string {
  const keeper = startXI.filter((e) => (e.player?.pos ?? "").toUpperCase() === "G");
  const outfield = startXI.filter((e) => (e.player?.pos ?? "").toUpperCase() !== "G");

  const lines = new Map<number, string[]>();
  const ungridded: string[] = [];
  for (const entry of outfield) {
    const name = (entry.player?.name ?? "").trim();
    if (!name) continue;
    const grid = entry.player?.grid;
    const line = grid ? Number(String(grid).split(":")[0]) : NaN;
    if (Number.isFinite(line)) lines.set(line, [...(lines.get(line) ?? []), name]);
    else ungridded.push(name);
  }

  const parts: string[] = [];
  const keeperNames = keeper.map((e) => (e.player?.name ?? "").trim()).filter(Boolean);
  if (keeperNames.length > 0) parts.push(keeperNames.join(", "));
  for (const [, names] of [...lines.entries()].sort((a, b) => a[0] - b[0])) parts.push(names.join(", "));
  if (ungridded.length > 0) parts.push(ungridded.join(", "));
  return parts.join("; ");
}

export function buildLineupPostData(
  lineups: ApiLineup[],
  homeTeam: string,
  awayTeam: string,
  flags?: { homeFlag?: string; awayFlag?: string },
): LineupPostData | null {
  const home = lineups.find((l) => l.team?.name === homeTeam) ?? lineups[0];
  const away = lineups.find((l) => l.team?.name === awayTeam) ?? (lineups.length > 1 ? lineups[1] : undefined);
  if (!home || !away || home === away) return null;
  const homeXI = formatXI(home.startXI ?? []);
  const awayXI = formatXI(away.startXI ?? []);
  if (!homeXI || !awayXI) return null;
  return {
    homeFormation: home.formation ?? "",
    awayFormation: away.formation ?? "",
    homeXI,
    awayXI,
    homeFlag: flags?.homeFlag ?? "",
    awayFlag: flags?.awayFlag ?? "",
  };
}

/* ------------------------------ Compose ------------------------------ */

/**
 * True when a candidate will actually render publishable content.
 *
 * A live update whose events all render empty (e.g. a VAR review with no
 * readable detail, or a card with no player name) must NOT be published as a
 * bare status line - that is filler. Score changes and status posts are
 * always meaningful on their own.
 */
export function hasPublishableContent(c: CandidateEvent): boolean {
  if (c.kind !== "live_update") return true;
  if (memberGroups(c).length > 0) return true;
  // No renderable events: only worth posting if the score itself changed.
  return c.scoreChanged === true || c.joined === true;
}

export function composeMessage(c: CandidateEvent): string {
  switch (c.kind) {
    case "kickoff":
      return buildPost(`🚩 Kick-off: ${scoreOf(c)}`, []);

    case "lineup": {
      const xi = c.lineup;
      if (!xi) return buildPost(`🚩 Starting XI: ${versusOf(c)}`, []);
      // Exactly one blank line between the two teams, via the buildPost join.
      // Flags are resolved in the pipeline from VERIFIED team metadata.
      const homeLine = xi.homeFlag ? `${xi.homeFlag} ${c.home} XI: ${xi.homeXI}` : `${c.home} XI: ${xi.homeXI}`;
      const awayLine = xi.awayFlag ? `${xi.awayFlag} ${c.away} XI: ${xi.awayXI}` : `${c.away} XI: ${xi.awayXI}`;
      return buildPost(homeLine, [[awayLine]]);
    }

    case "live_update":
      return buildPost(`🚩 Live: ${scoreOf(c)}`, memberGroups(c));

    case "halftime":
      return buildPost(`🚩 HT: ${scoreOf(c)}`, []);

    case "second_half":
      return buildPost(`🚩 Second Half: ${scoreOf(c)}`, []);

    case "extra_time":
      return buildPost(`🚩 Extra Time: ${scoreOf(c)}`, []);

    case "extra_time_break":
      return buildPost(`🚩 ET: ${scoreOf(c)}`, []);

    case "penalty_shootout":
      return buildPost(`🚩 Penalty Shootout: ${versusOf(c)}`, []);

    case "shootout_update":
      return buildPost(`🚩 Penalty Shootout: ${pensOf(c)}`, []);

    case "fulltime": {
      // FT status first; a not-yet-published final goal(s) beneath it.
      const groups = memberGroups(c);
      const isPens = c.statusShort?.toUpperCase() === "PEN" && c.pensHome != null && c.pensAway != null;
      if (isPens) groups.push([`⚽️ Penalties: ${pensOf(c)}`]);
      return buildPost(`🚩 FT: ${scoreOf(c)}`, groups);
    }

    case "postponed":
      return buildPost(`🚩 Postponed: ${versusOf(c)}`, []);

    case "cancelled":
      return buildPost(`🚩 Cancelled: ${versusOf(c)}`, []);

    case "abandoned":
      return buildPost(`🚩 Abandoned: ${scoreOf(c)}`, []);

    case "suspended":
      return buildPost(`🚩 Suspended: ${scoreOf(c)}`, []);

    case "interrupted":
      return buildPost(`🚩 Interrupted: ${scoreOf(c)}`, []);

    case "awarded":
      return buildPost(`🚩 Awarded: ${scoreOf(c)}`, []);

    case "walkover":
      return buildPost(`🚩 Walkover: ${versusOf(c)}`, []);

    default:
      return buildPost(`🚩 Live: ${scoreOf(c)}`, memberGroups(c));
  }
}
