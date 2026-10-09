import type { Sql } from "@/lib/db";
import { flagForCountry, flagForNationalTeam, isCountryName } from "./flags";

/**
 * Dynamic team-country resolution for lineup flags.
 *
 * Priority (per the DynaSport production rules):
 *   1. Verified country metadata already present in the API response
 *      (an international fixture whose teams are national teams by definition).
 *   2. Cached verified metadata in Neon, keyed by the stable API team ID
 *      (team IDs are persistent across all competitions and seasons).
 *   3. A budget-guarded /teams?id=<id> lookup through the existing
 *      API-Football integration - only when necessary and only when the
 *      daily request budget safely permits it. The result is cached so the
 *      lookup happens at most once per team, ever.
 *   5. The verified country is converted to a flag emoji.
 *   6. If the country still cannot be verified, the flag is omitted and the
 *      lineup is still published.
 *
 * Never done here:
 *   - inferring a club's country from a player's nationality
 *   - using the competition's country as a club-country fallback
 *   - name-only matching for clubs
 *   - per-player metadata requests
 */

export interface TeamCountryMeta {
  teamId: number;
  name: string;
  country: string | null;
  national: boolean | null;
}

export interface ResolvedFlag {
  flag: string;
  /** How the flag was resolved - recorded for diagnostics/auditing. */
  source: "response" | "cache" | "api" | "national-team" | "none";
}

/* ------------------------------ Neon cache ------------------------------ */

export async function getCachedTeamMeta(
  sql: Sql,
  teamIds: number[],
): Promise<Map<number, TeamCountryMeta>> {
  const map = new Map<number, TeamCountryMeta>();
  const ids = teamIds.filter((id) => Number.isFinite(id));
  if (ids.length === 0) return map;
  try {
    const rows = (await sql`
      select team_id, name, country, national
      from team_countries
      where team_id in (
        select (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::bigint
      )`) as {
      team_id: number | string;
      name: string;
      country: string | null;
      national: boolean | null;
    }[];
    for (const row of rows) {
      map.set(Number(row.team_id), {
        teamId: Number(row.team_id),
        name: row.name,
        country: row.country,
        national: row.national,
      });
    }
  } catch {
    // Cache misses must never break flag resolution.
  }
  return map;
}

export async function saveTeamMeta(sql: Sql, meta: TeamCountryMeta): Promise<void> {
  try {
    await sql`
      insert into team_countries (team_id, name, country, national, updated_at)
      values (${meta.teamId}, ${meta.name}, ${meta.country}, ${meta.national}, now())
      on conflict (team_id) do update set
        name = excluded.name,
        country = excluded.country,
        national = excluded.national,
        updated_at = now()`;
  } catch {
    // Caching is best-effort.
  }
}

/* ------------------------------ Resolution ------------------------------ */

/**
 * Resolve the flag for one lineup team.
 *
 * @param isInternational the fixture's competition is international
 *        (league country "World"), so the teams are national teams whose
 *        verified names are country names.
 * @param budgetSlots remaining API request slots the caller is willing to
 *        spend on team metadata (0 = no lookups, cache/response only).
 */
export async function resolveTeamFlag(
  sql: Sql,
  team: { id: number | null; name: string },
  options: { isInternational: boolean; budgetSlots: number; fetchTeamMeta: (id: number) => Promise<TeamCountryMeta | null> },
): Promise<ResolvedFlag> {
  const name = (team.name ?? "").trim();

  // 1) Verified metadata already in the response: national team in an
  //    international competition. Never used for clubs.
  if (options.isInternational && isCountryName(name)) {
    const flag = flagForNationalTeam(name);
    if (flag) return { flag, source: "response" };
  }

  if (team.id == null || !Number.isFinite(team.id)) {
    return { flag: "", source: "none" };
  }

  // 2) Cached verified metadata keyed by the stable team ID.
  const cached = await getCachedTeamMeta(sql, [team.id]);
  const hit = cached.get(team.id);
  if (hit?.country) {
    const flag = flagForCountry(hit.country);
    if (flag) return { flag, source: "cache" };
  }

  // 3) Budget-guarded /teams lookup through the existing integration.
  if (options.budgetSlots > 0) {
    try {
      const meta = await options.fetchTeamMeta(team.id);
      if (meta?.country) {
        await saveTeamMeta(sql, meta);
        const flag = flagForCountry(meta.country);
        if (flag) return { flag, source: "api" };
      } else if (meta) {
        // Cache the negative result too, so we never re-query a team whose
        // country the API does not provide.
        await saveTeamMeta(sql, meta);
      }
    } catch {
      // Lookup failures (budget, network) never block the lineup.
    }
  }

  // 6) Unverifiable: omit the flag.
  return { flag: "", source: "none" };
}
