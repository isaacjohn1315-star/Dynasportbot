/**
 * DynaSport approved competition registry (single source of truth).
 *
 * Resolution order for every fixture:
 *   1. Stable API-Football league ID (preferred - survives renames/new seasons)
 *   2. Country-scoped name/alias match (handles official naming variations and
 *      competitions whose ID is not verified here)
 *   3. Approved-parent qualification/playoff phases, only when the provider
 *      itself identifies the relationship (league name or round)
 * Anything else is rejected with a recorded reason.
 *
 * League IDs below are the long-standing API-Football identifiers. Where an ID
 * could not be verified without burning live API quota, the entry is matched by
 * country-scoped name only (`ids: []`) - never by an invented ID.
 */

export type Confederation = "FIFA" | "UEFA" | "CONMEBOL" | "CONCACAF" | "CAF" | "AFC" | "OFC" | "DOM";

export interface CompetitionRule {
  /** Canonical display key (deduplicated, corrected spelling). */
  key: string;
  /** Verified API-Football league IDs. Empty = resolve by name+country only. */
  ids: number[];
  /**
   * Country names as API-Football reports them. `["World"]` for
   * international competitions. Empty = any country (use sparingly).
   */
  countries: string[];
  /** Lowercase name aliases/variants, matched after normalization. */
  aliases: string[];
  confederation: Confederation;
  /** Qualification / preliminary phases of this competition are approved too. */
  allowQualifiers?: boolean;
}

const D = (
  key: string,
  ids: number[],
  countries: string[],
  aliases: string[],
  confederation: Confederation = "DOM",
  allowQualifiers = false,
): CompetitionRule => ({ key, ids, countries, aliases, confederation, allowQualifiers });

/* ------------------------------ Domestic leagues ------------------------------ */
const DOMESTIC_LEAGUES: CompetitionRule[] = [
  D("Premier League", [39], ["England"], ["premier league", "english premier league", "epl"]),
  D("EFL Championship", [40], ["England"], ["championship", "efl championship"]),
  D("English League One", [41], ["England"], ["league one", "efl league one"]),
  D("English League Two", [42], ["England"], ["league two", "efl league two"]),
  D("La Liga", [140], ["Spain"], ["la liga", "laliga", "primera division", "primera división"]),
  D("Spanish Segunda División", [141], ["Spain"], ["segunda division", "segunda división", "la liga 2", "laliga2", "laliga hypermotion"]),
  D("Bundesliga", [78], ["Germany"], ["bundesliga", "1. bundesliga", "1 bundesliga"]),
  D("German 2. Bundesliga", [79], ["Germany"], ["2. bundesliga", "2 bundesliga", "bundesliga 2"]),
  D("Serie A", [135], ["Italy"], ["serie a"]),
  D("Italian Serie B", [136], ["Italy"], ["serie b"]),
  D("Ligue 1", [61], ["France"], ["ligue 1"]),
  D("French Ligue 2", [62], ["France"], ["ligue 2"]),
  D("Major League Soccer", [253], ["USA"], ["major league soccer", "mls"]),
  D("Campeonato Brasileiro Série A", [71], ["Brazil"], ["serie a", "série a", "brasileirao serie a", "campeonato brasileiro serie a"]),
  D("Brazilian Série B", [72], ["Brazil"], ["serie b", "série b", "brasileirao serie b", "campeonato brasileiro serie b"]),
  D("Liga MX", [262], ["Mexico"], ["liga mx", "primera division", "liga bbva mx"]),
  D("Primeira Liga", [94], ["Portugal"], ["primeira liga", "liga portugal", "liga portugal betclic"]),
  D("Eredivisie", [88], ["Netherlands"], ["eredivisie"]),
  D("Saudi Pro League", [307], ["Saudi-Arabia"], ["pro league", "saudi pro league", "roshn saudi league"]),
  D("Turkish Süper Lig", [203], ["Turkey"], ["super lig", "süper lig", "trendyol super lig"]),
  D("Argentine Primera División", [128], ["Argentina"], ["liga profesional argentina", "primera division", "primera división", "torneo betano"]),
  D("Egyptian Premier League", [233], ["Egypt"], ["premier league", "egyptian premier league"]),
  D("South African Premiership", [288], ["South-Africa"], ["premier soccer league", "premiership", "betway premiership", "psl"]),
  D("Nigeria Premier Football League", [399], ["Nigeria"], ["npfl", "premier league", "nigeria premier football league", "professional football league"]),
  D("J.League", [98], ["Japan"], ["j1 league", "j. league", "j league", "j1"]),
  D("K League 1", [292], ["South-Korea", "Korea-Republic"], ["k league 1", "k-league 1", "k league1"]),
  D("Indian Super League", [323], ["India"], ["indian super league", "super league", "isl"]),
  D("Australian A-League Men", [188], ["Australia"], ["a-league", "a league", "a-league men", "isuzu ute a-league"]),
];

/* --------------------- Major international (national teams) --------------------- */
const INTERNATIONAL: CompetitionRule[] = [
  D("FIFA World Cup", [1], ["World"], ["world cup", "fifa world cup"], "FIFA", true),
  D("UEFA European Championship", [4], ["World"], ["euro championship", "uefa european championship", "european championship", "euro"], "UEFA", true),
  D("Africa Cup of Nations", [6], ["World"], ["africa cup of nations", "afcon", "cup of nations"], "CAF", true),
  D("Copa América", [9], ["World"], ["copa america", "copa américa"], "CONMEBOL", true),
  D("CONCACAF Gold Cup", [22], ["World"], ["gold cup", "concacaf gold cup"], "CONCACAF", true),
  D("AFC Asian Cup", [7], ["World"], ["asian cup", "afc asian cup"], "AFC", true),
  D("OFC Nations Cup", [], ["World"], ["ofc nations cup", "oceania nations cup"], "OFC", true),
  D("FIFA Arab Cup", [860], ["World"], ["arab cup", "fifa arab cup"], "FIFA"),
  D("UEFA Nations League", [5], ["World"], ["uefa nations league", "nations league"], "UEFA", true),
  D("CONCACAF Nations League", [536], ["World"], ["concacaf nations league"], "CONCACAF", true),
  D("International Friendlies", [10], ["World"], ["friendlies", "international friendlies", "friendlies clubs"], "FIFA"),
  D("Olympic Football Tournament", [480], ["World"], ["olympics men", "olympic games", "football olympics", "olympics"], "FIFA", true),
  D("FIFA Intercontinental Playoffs", [], ["World"], ["world cup - play-offs", "intercontinental play-offs", "inter-confederation play-offs"], "FIFA"),
];

/* ------------------------- International club competitions ------------------------- */
const CLUB_INTERNATIONAL: CompetitionRule[] = [
  D("UEFA Champions League", [2], ["World"], ["uefa champions league", "champions league"], "UEFA", true),
  D("UEFA Europa League", [3], ["World"], ["uefa europa league", "europa league"], "UEFA", true),
  D("UEFA Conference League", [848], ["World"], ["uefa europa conference league", "conference league", "uefa conference league"], "UEFA", true),
  D("FIFA Club World Cup", [15], ["World"], ["fifa club world cup", "club world cup"], "FIFA"),
  D("FIFA Intercontinental Cup", [], ["World"], ["intercontinental cup", "fifa intercontinental cup"], "FIFA"),
  D("UEFA Super Cup", [531], ["World"], ["uefa super cup"], "UEFA"),
  D("Copa Libertadores", [13], ["World"], ["copa libertadores", "conmebol libertadores"], "CONMEBOL", true),
  D("Copa Sudamericana", [11], ["World"], ["copa sudamericana", "conmebol sudamericana"], "CONMEBOL", true),
  D("Recopa Sudamericana", [541], ["World"], ["recopa sudamericana", "conmebol recopa"], "CONMEBOL"),
  D("CONCACAF Champions Cup", [16], ["World"], ["concacaf champions cup", "concacaf champions league"], "CONCACAF", true),
  D("AFC Champions League Elite", [17], ["World"], ["afc champions league", "afc champions league elite"], "AFC", true),
  D("AFC Champions League Two", [18], ["World"], ["afc champions league two", "afc cup"], "AFC", true),
  D("AFC Challenge League", [], ["World"], ["afc challenge league"], "AFC"),
  D("CAF Champions League", [12], ["World"], ["caf champions league"], "CAF", true),
  D("CAF Confederation Cup", [20], ["World"], ["caf confederation cup"], "CAF", true),
  D("ASEAN Club Championship", [], ["World"], ["asean club championship", "mitsubishi electric cup", "aff club championship"], "AFC"),
  D("Leagues Cup", [772], ["World"], ["leagues cup"], "CONCACAF"),
];

/* -------------------------- Domestic cups and super cups -------------------------- */
const DOMESTIC_CUPS: CompetitionRule[] = [
  D("FA Cup", [45], ["England"], ["fa cup"]),
  D("EFL Cup", [48], ["England"], ["league cup", "efl cup", "carabao cup"]),
  D("FA Community Shield", [528], ["England"], ["community shield", "fa community shield"]),
  D("Copa del Rey", [143], ["Spain"], ["copa del rey"]),
  D("Supercopa de España", [556], ["Spain"], ["super cup", "supercopa de espana", "supercopa"]),
  D("Coppa Italia", [137], ["Italy"], ["coppa italia"]),
  D("Supercoppa Italiana", [547], ["Italy"], ["super cup", "supercoppa italiana", "supercoppa"]),
  D("DFB-Pokal", [81], ["Germany"], ["dfb pokal", "dfb-pokal"]),
  D("DFL-Supercup", [529], ["Germany"], ["super cup", "dfl supercup", "dfl-supercup", "supercup"]),
  D("Coupe de France", [66], ["France"], ["coupe de france"]),
  D("Trophée des Champions", [526], ["France"], ["trophee des champions", "trophée des champions", "super cup"]),
  D("Taça de Portugal", [96], ["Portugal"], ["taca de portugal", "taça de portugal"]),
  D("Supertaça Cândido de Oliveira", [550], ["Portugal"], ["super cup", "supertaca candido de oliveira", "supertaça cândido de oliveira"]),
  D("KNVB Cup", [90], ["Netherlands"], ["knvb beker", "knvb cup"]),
  D("Johan Cruyff Shield", [89], ["Netherlands"], ["super cup", "johan cruijff schaal", "johan cruyff shield"]),
  D("Copa do Brasil", [73], ["Brazil"], ["copa do brasil"]),
  D("US Open Cup", [257], ["USA"], ["us open cup", "usl championship cup", "lamar hunt us open cup"]),
  D("Campeones Cup", [], ["World", "USA"], ["campeones cup"], "CONCACAF"),
  D("Copa Argentina", [130], ["Argentina"], ["copa argentina"]),
];

/* ------------------------------ Women's competitions ------------------------------ */
const WOMENS: CompetitionRule[] = [
  D("FIFA Women's World Cup", [8], ["World"], ["world cup - women", "fifa women's world cup", "womens world cup"], "FIFA", true),
  D("UEFA Women's Nations League", [1040], ["World"], ["uefa women's nations league", "womens nations league"], "UEFA", true),
  D("UEFA Women's Champions League", [525], ["World"], ["uefa women's champions league", "womens champions league"], "UEFA", true),
  D("Women's Africa Cup of Nations", [], ["World"], ["women's africa cup of nations", "womens africa cup of nations", "wafcon"], "CAF", true),
  D("UEFA Women's European Championship", [743], ["World"], ["uefa women's euro", "womens euro", "european championship - women"], "UEFA", true),
  D("Women's Olympic Football Tournament", [524], ["World"], ["olympics women", "olympic games women", "football olympics women"], "FIFA", true),
  D("Women's Super League", [699], ["England"], ["women's super league", "wsl", "fa women's super league"]),
  D("National Women's Soccer League", [254], ["USA"], ["nwsl", "nwsl women", "national women's soccer league"]),
  D("Liga F", [142], ["Spain"], ["liga f", "primera division women", "primera división femenina"]),
  D("Frauen-Bundesliga", [82], ["Germany"], ["frauen bundesliga", "frauen-bundesliga", "bundesliga women"]),
  D("A-League Women", [189], ["Australia"], ["a-league women", "a league women", "w-league"]),
  D("AFC Women's Asian Cup", [], ["World"], ["afc women's asian cup", "womens asian cup"], "AFC", true),
];

/* ---------------------------- Youth / age-group ---------------------------- */
const YOUTH: CompetitionRule[] = [
  D("UEFA European Under-21 Championship", [38], ["World"], ["uefa u21 championship", "euro championship - u21", "u21 championship"], "UEFA", true),
  D("UEFA European Under-19 Championship", [498], ["World"], ["uefa u19 championship", "euro championship - u19"], "UEFA", true),
  D("UEFA European Under-17 Championship", [499], ["World"], ["uefa u17 championship", "euro championship - u17"], "UEFA", true),
  D("FIFA U-20 World Cup", [490], ["World"], ["world cup - u20", "u20 world cup", "fifa u20 world cup"], "FIFA"),
  D("FIFA U-17 World Cup", [491], ["World"], ["world cup - u17", "u17 world cup", "fifa u17 world cup"], "FIFA"),
  D("CAF U-20 Africa Cup of Nations", [], ["World"], ["africa cup of nations u20", "u20 africa cup of nations"], "CAF", true),
  D("CAF U-17 Africa Cup of Nations", [], ["World"], ["africa cup of nations u17", "u17 africa cup of nations"], "CAF", true),
  D("Africa U-23 Cup of Nations", [], ["World"], ["africa cup of nations u23", "u23 africa cup of nations"], "CAF", true),
  D("AFC U-23 Asian Cup", [], ["World"], ["afc u23 asian cup", "u23 asian cup"], "AFC", true),
  D("CONCACAF U-20 Championship", [], ["World"], ["concacaf u20 championship", "concacaf championship u20"], "CONCACAF", true),
];

/* ------------------------------ Friendlies / other ------------------------------ */
const OTHER: CompetitionRule[] = [
  D("Club Friendlies", [667], ["World"], ["club friendlies", "friendlies clubs"], "FIFA"),
  D("Pre-Season Friendlies", [], ["World"], ["pre-season friendlies", "friendlies pre-season"], "FIFA"),
  D("All-Star Matches", [], ["World", "USA"], ["all-star", "mls all-star", "all star game"], "FIFA"),
];

export const COMPETITION_RULES: CompetitionRule[] = [
  ...DOMESTIC_LEAGUES,
  ...INTERNATIONAL,
  ...CLUB_INTERNATIONAL,
  ...DOMESTIC_CUPS,
  ...WOMENS,
  ...YOUTH,
  ...OTHER,
];

/**
 * Requested entries that could NOT be mapped to a verified provider record.
 * Reported rather than guessed - see the completion report.
 */
export const UNRESOLVED_REQUESTS: string[] = [
  "Copa América Qualifiers (CONMEBOL runs no separate qualifying competition)",
  "Regional Club Tournaments (generic category - no specific provider record)",
  "National Team Friendlies (covered by International Friendlies, league 10)",
  "Continental Super Cups (covered individually: UEFA Super Cup, CAF/Recopa, Campeones Cup)",
  "Youth International Friendlies (not enabled - provider classification unreliable)",
];

/** Total approved competition records. */
export const APPROVED_COUNT = COMPETITION_RULES.length;

/* --------------------------------- Matching --------------------------------- */

export function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeCountry(value: unknown): string {
  return normalizeName(value).replace(/\s+/g, "-");
}

const ID_INDEX = new Map<number, CompetitionRule>();
for (const rule of COMPETITION_RULES) for (const id of rule.ids) ID_INDEX.set(id, rule);

/** Never approved, whatever else matches. */
const BLOCKED = /\b(reserves?|u ?\d{2} league|academy|youth league|primavera|b team|test)\b/;

/** Provider phrases that mark an official qualification / playoff phase. */
const QUALIFIER_PHRASE = /\b(qualification|qualifiers?|qualifying|preliminary|play ?offs?|promotion relegation)\b/;

export interface MatchResult {
  approved: boolean;
  rule?: CompetitionRule;
  /** Internal reason recorded when a fixture is rejected. */
  reason?: string;
  matchedBy?: "id" | "name" | "qualifier";
}

/**
 * Resolve a fixture's competition against the approved registry.
 * Never throws: unexpected input is rejected with a reason.
 */
export function matchCompetition(
  leagueName: unknown,
  country: unknown,
  leagueId?: unknown,
): MatchResult {
  try {
    // 1) Stable league ID (survives renames and new seasons).
    if (typeof leagueId === "number" && Number.isFinite(leagueId)) {
      const byId = ID_INDEX.get(leagueId);
      if (byId) return { approved: true, rule: byId, matchedBy: "id" };
    }

    const name = normalizeName(leagueName);
    if (!name) return { approved: false, reason: "missing competition name" };
    if (BLOCKED.test(name)) return { approved: false, reason: `blocked competition tier: "${name}"` };

    const ctry = normalizeCountry(country);
    const isQualifierPhase = QUALIFIER_PHRASE.test(name);
    // Base name with the qualification suffix stripped, e.g.
    // "world cup qualification europe" -> "world cup"
    const baseName = name
      .replace(/\b(qualification|qualifiers?|qualifying|preliminary|play ?offs?|promotion relegation)\b.*$/, "")
      .replace(/\b(uefa|caf|conmebol|concacaf|afc|ofc)\b\s*$/, "")
      .trim();

    for (const rule of COMPETITION_RULES) {
      const countryOk =
        rule.countries.length === 0 || rule.countries.some((c) => normalizeCountry(c) === ctry);
      if (!countryOk) continue;

      for (const alias of rule.aliases) {
        const a = normalizeName(alias);
        if (!a) continue;

        /**
         * 2) EXACT official-name match only.
         * Loose prefix/suffix matching is deliberately not used: it would
         * admit similarly named but unrelated competitions such as
         * "Premier League 2" or "Serie A Femminile".
         */
        if (name === a) {
          if (isQualifierPhase && !rule.allowQualifiers) {
            return { approved: false, reason: `qualifier phase not approved for "${rule.key}"` };
          }
          return {
            approved: true,
            rule,
            matchedBy: isQualifierPhase ? "qualifier" : "name",
          };
        }

        // 3) Approved qualification/preliminary phase of an approved parent.
        if (isQualifierPhase && rule.allowQualifiers && baseName && baseName === a) {
          return { approved: true, rule, matchedBy: "qualifier" };
        }
      }
    }

    return {
      approved: false,
      reason: `not in the approved allowlist: "${String(leagueName)}" (${String(country ?? "unknown country")})`,
    };
  } catch (error) {
    return { approved: false, reason: `classification error: ${String(error).slice(0, 120)}` };
  }
}

export function isApprovedCompetition(
  leagueName: unknown,
  country: unknown,
  leagueId?: unknown,
): boolean {
  return matchCompetition(leagueName, country, leagueId).approved;
}
