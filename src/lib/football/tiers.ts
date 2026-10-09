import { matchCompetition, type MatchResult } from "./competitions";

/**
 * Competition eligibility for DynaSport.
 *
 * All decisions delegate to the approved competition registry
 * (`competitions.ts`), which resolves by stable API-Football league ID first,
 * then country-scoped official names/aliases, then approved qualification
 * phases. Everything else is rejected with a recorded reason.
 */

export type Tier = 1 | 2;

/** Tier 1 = approved and published. Tier 2 = excluded from the platform. */
export function classifyCompetition(
  leagueName: string | null | undefined,
  country: string | null | undefined,
  leagueId?: number | null,
): Tier {
  return matchCompetition(leagueName, country, leagueId).approved ? 1 : 2;
}

/** Single platform-wide eligibility predicate. */
export function isEligibleCompetition(
  leagueName: string | null | undefined,
  country: string | null | undefined,
  leagueId?: number | null,
): boolean {
  return classifyCompetition(leagueName, country, leagueId) === 1;
}

/** Full match result, including the internal rejection reason for logging. */
export function competitionDecision(
  leagueName: string | null | undefined,
  country: string | null | undefined,
  leagueId?: number | null,
): MatchResult {
  return matchCompetition(leagueName, country, leagueId);
}
