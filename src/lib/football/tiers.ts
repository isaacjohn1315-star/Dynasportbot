/**
 * Two-tier competition classification.
 *
 * Tier 1: full live coverage (goals, assists, cards, subs, VAR, statuses,
 *         starting XI when budget permits).
 * Tier 2: NOT covered by the platform. Every non-Tier-1 competition - and any
 *         unknown/unlisted one - is excluded from all processing and output.
 *
 * Matching is country-aware because API-Football reuses generic league names
 * (e.g. "Premier League" in England, Ghana, Kenya, Egypt... vs Israel).
 */

export type Tier = 1 | 2;

/**
 * Sentinel: rule only applies to international competitions, i.e. fixtures
 * whose API country is "World" (or empty). Used to stop generic youth
 * patterns from promoting domestic youth/reserve leagues.
 */
const INTERNATIONAL = ["\u0000international-only"] as const;

interface TierRule {
  pattern: RegExp;
  /**
   * API country names (normalized). `null` = country-agnostic,
   * `INTERNATIONAL` = only when the fixture's country is World/empty.
   */
  countries: readonly string[] | null;
}

/* ------------------------------ International ------------------------------ */

const WORLD: readonly string[] | null = null;
const C = (s: string) => s.toLowerCase();
const list = (...names: string[]) => names.map(C) as readonly string[];

const TIER1_RULES: TierRule[] = [
  // FIFA / international tournaments (men + women + youth + club world)
  { pattern: /fifa club world cup|club world cup/i, countries: WORLD },
  { pattern: /^world cup( .? women.*)?$/i, countries: WORLD },
  { pattern: /world cup.*u(20|17)|u(20|17).*world cup/i, countries: WORLD },
  { pattern: /intercontinental cup/i, countries: WORLD },
  { pattern: /confederations cup/i, countries: WORLD },
  { pattern: /olympics/i, countries: WORLD },
  { pattern: /euro(pean)? championship/i, countries: WORLD },
  { pattern: /euro.*u(21|19|17)|u(21|19|17).*euro/i, countries: WORLD },
  { pattern: /copa america/i, countries: WORLD },
  { pattern: /cup of nations|afcon/i, countries: WORLD },
  { pattern: /asian cup/i, countries: WORLD },
  { pattern: /gold cup/i, countries: WORLD },
  { pattern: /nations league/i, countries: WORLD },
  { pattern: /youth league/i, countries: WORLD },
  // Qualifiers for major international tournaments (explicitly Tier 1).
  { pattern: /world cup.*qualif|qualif.*world cup/i, countries: WORLD },
  { pattern: /euro.*qualif|qualif.*euro/i, countries: WORLD },
  { pattern: /cup of nations.*qualif|qualif.*cup of nations/i, countries: WORLD },
  { pattern: /asian cup.*qualif|qualif.*asian cup/i, countries: WORLD },
  { pattern: /gold cup.*qualif|qualif.*gold cup/i, countries: WORLD },

  // Continental club competitions (all Tier 1 regardless of confederation)
  { pattern: /champions league|champions cup/i, countries: WORLD },
  { pattern: /europa league/i, countries: WORLD },
  { pattern: /conference league/i, countries: WORLD },
  { pattern: /copa libertadores/i, countries: WORLD },
  { pattern: /copa sudamericana/i, countries: WORLD },
  { pattern: /recopa/i, countries: WORLD },
  { pattern: /leagues cup/i, countries: WORLD },
  { pattern: /afc (champions league )?(two|2)/i, countries: WORLD },
  { pattern: /afc challenge league|afc cup/i, countries: WORLD },
  { pattern: /ofc champions/i, countries: WORLD },
  { pattern: /caf super cup|african super cup/i, countries: WORLD },
  { pattern: /uefa super cup/i, countries: WORLD },

  // Europe - England
  { pattern: /^premier league/i, countries: list("England") },
  { pattern: /^championship/i, countries: list("England") },
  { pattern: /^league (one|two)/i, countries: list("England") },
  { pattern: /fa cup|community shield/i, countries: list("England") },
  { pattern: /^(efl |league |carabao )?cup$/i, countries: list("England") },
  { pattern: /women.*super league|^wsl\b/i, countries: WORLD },
  { pattern: /women.*(fa )?cup/i, countries: list("England") },

  // Spain
  { pattern: /^la liga/i, countries: list("Spain") },
  { pattern: /segunda divisi|la liga 2/i, countries: list("Spain") },
  { pattern: /copa del rey/i, countries: list("Spain") },
  { pattern: /super cup/i, countries: list("Spain") },
  { pattern: /liga f\b|primera divisi.*femenina|femenina/i, countries: list("Spain") },
  { pattern: /copa de la reina/i, countries: list("Spain") },

  // Italy
  { pattern: /^serie [ab]/i, countries: list("Italy") },
  { pattern: /coppa italia/i, countries: list("Italy") },
  { pattern: /super cup/i, countries: list("Italy") },
  { pattern: /femminile/i, countries: list("Italy") },

  // Germany ("Bundesliga", "1. Bundesliga", "2. Bundesliga", "2 Bundesliga")
  { pattern: /^[12]?\s*\.?\s*bundesliga/i, countries: list("Germany") },
  { pattern: /dfb.pokal/i, countries: list("Germany") },
  { pattern: /super cup/i, countries: list("Germany") },
  { pattern: /frauen/i, countries: list("Germany") },

  // France
  { pattern: /^ligue [12]/i, countries: list("France") },
  { pattern: /coupe de france/i, countries: list("France") },
  { pattern: /troph|super cup/i, countries: list("France") },
  { pattern: /f[ée]minine/i, countries: list("France") },

  // Netherlands
  { pattern: /eredivisie/i, countries: list("Netherlands") },
  { pattern: /eerste divisie/i, countries: list("Netherlands") },
  { pattern: /knvb|beker/i, countries: list("Netherlands") },
  { pattern: /super cup|johan crui?j?ff/i, countries: list("Netherlands") },

  // Portugal
  { pattern: /primeira liga|liga portugal|segunda liga/i, countries: list("Portugal") },
  { pattern: /ta[cç]a/i, countries: list("Portugal") },
  { pattern: /league cup/i, countries: list("Portugal") },
  { pattern: /super cup/i, countries: list("Portugal") },

  // Belgium
  { pattern: /pro league|challenger pro/i, countries: list("Belgium") },
  { pattern: /^(belgian )?cup|croky/i, countries: list("Belgium") },

  // Turkey
  { pattern: /s[uü]per lig|super lig/i, countries: list("Turkey") },
  { pattern: /^1\.?\s?lig/i, countries: list("Turkey") },
  { pattern: /cup/i, countries: list("Turkey") },

  // Scotland
  { pattern: /premiership/i, countries: list("Scotland") },
  { pattern: /^championship/i, countries: list("Scotland") },
  { pattern: /scottish cup|league cup|^fa cup|cup/i, countries: list("Scotland") },

  // Other Europe - top flights
  { pattern: /bundesliga/i, countries: list("Austria") },
  { pattern: /super league/i, countries: list("Switzerland") },
  { pattern: /super league 1?|super league/i, countries: list("Greece") },
  { pattern: /premier league/i, countries: list("Ukraine") },
  { pattern: /superliga/i, countries: list("Denmark") },
  { pattern: /eliteserien/i, countries: list("Norway") },
  { pattern: /allsvenskan/i, countries: list("Sweden") },
  { pattern: /czech liga|first league|1\. liga|fortuna/i, countries: list("Czech-Republic", "Czechia") },
  { pattern: /ekstraklasa/i, countries: list("Poland") },
  { pattern: /^hnl|super sport hnl/i, countries: list("Croatia") },
  { pattern: /super liga|superliga/i, countries: list("Serbia") },
  { pattern: /liga i|liga 1|superliga/i, countries: list("Romania") },
  { pattern: /premier league/i, countries: list("Russia") },

  // South America
  { pattern: /^serie [ab]/i, countries: list("Brazil") },
  { pattern: /copa do brasil/i, countries: list("Brazil") },
  { pattern: /brasileir|a1 women|feminino/i, countries: list("Brazil") },
  { pattern: /liga profesional|primera divisi|primera nacional/i, countries: list("Argentina") },
  { pattern: /copa argentina|trofeo de campeones|copa de la liga/i, countries: list("Argentina") },
  { pattern: /^primera [ab]/i, countries: list("Colombia") },
  { pattern: /liga pro|serie [ab]/i, countries: list("Ecuador") },
  { pattern: /division profesional|primera divisi/i, countries: list("Paraguay") },
  { pattern: /primera divisi/i, countries: list("Uruguay") },
  { pattern: /primera divisi/i, countries: list("Chile") },
  { pattern: /primera divisi|liga 1/i, countries: list("Peru") },
  { pattern: /primera divisi|divisi.*profesional/i, countries: list("Bolivia") },
  { pattern: /primera divisi|futve|liga futve/i, countries: list("Venezuela") },

  // North & Central America
  { pattern: /major league soccer|^mls\b/i, countries: list("USA") },
  { pattern: /usl championship|usl league one/i, countries: list("USA") },
  { pattern: /open cup/i, countries: list("USA") },
  { pattern: /nwsl|women.*soccer/i, countries: list("USA") },
  { pattern: /liga mx/i, countries: list("Mexico") },
  { pattern: /expansi|liga de expansion/i, countries: list("Mexico") },
  { pattern: /premier league|canadian championship/i, countries: list("Canada") },
  { pattern: /primera divisi|liga fpd/i, countries: list("Costa-Rica") },
  { pattern: /liga nacional/i, countries: list("Honduras") },
  { pattern: /liga nacional/i, countries: list("Guatemala") },
  { pattern: /primera divisi|liga pepsi|liga mayor/i, countries: list("El-Salvador") },
  { pattern: /lpf|liga paname/i, countries: list("Panama") },
  { pattern: /premier league/i, countries: list("Jamaica") },

  // Africa
  { pattern: /npfl|premier league|professional football/i, countries: list("Nigeria") },
  { pattern: /national league/i, countries: list("Nigeria") },
  { pattern: /fa cup|aicteo cup/i, countries: list("Nigeria") },
  { pattern: /premier league/i, countries: list("Egypt") },
  { pattern: /egypt.*cup|egyptian cup/i, countries: list("Egypt") },
  { pattern: /botola/i, countries: list("Morocco") },
  { pattern: /throne cup|tr.o?ne|coupe du/i, countries: list("Morocco") },
  { pattern: /premier soccer league|psl|betway premiership|first division/i, countries: list("South-Africa") },
  { pattern: /fa cup|nedbank|mtn8|telkom/i, countries: list("South-Africa") },
  { pattern: /ligue 1|ligue professionnelle/i, countries: list("Algeria") },
  { pattern: /ligue 1|ligue professionnelle/i, countries: list("Tunisia") },
  { pattern: /premier league/i, countries: list("Ghana") },
  { pattern: /premier league|ligi kuu/i, countries: list("Tanzania") },
  { pattern: /premier league|fkf/i, countries: list("Kenya") },
  { pattern: /premier league|super league|star times/i, countries: list("Uganda") },
  { pattern: /super league|mtn super/i, countries: list("Zambia") },
  { pattern: /girabola/i, countries: list("Angola") },
  { pattern: /ligue 1/i, countries: list("Ivory-Coast", "Cote-D-Ivoire", "Cote-D'Ivoire") },
  { pattern: /ligue 1/i, countries: list("Senegal") },
  { pattern: /elite (one|un)/i, countries: list("Cameroon") },

  // Asia
  { pattern: /pro league|saudi professional/i, countries: list("Saudi-Arabia") },
  { pattern: /division 1|first division|yelo league/i, countries: list("Saudi-Arabia") },
  { pattern: /king.?s? cup|crown prince|super cup|women/i, countries: list("Saudi-Arabia") },
  { pattern: /stars league|qsl|qatar cup/i, countries: list("Qatar") },
  { pattern: /pro league|arabian gulf|president/i, countries: list("United-Arab-Emirates") },
  { pattern: /persian gulf|pro league|azadegan/i, countries: list("Iran") },
  { pattern: /j1|j2|j\.? league/i, countries: list("Japan") },
  { pattern: /emperor/i, countries: list("Japan") },
  { pattern: /k.?league/i, countries: list("South-Korea", "Korea-Republic") },
  { pattern: /super league|fa cup/i, countries: list("China") },
  { pattern: /indian super league|i-league|super cup|durand/i, countries: list("India") },
  { pattern: /a.?league|australia cup|ffa cup/i, countries: list("Australia") },
  { pattern: /thai league/i, countries: list("Thailand") },
  { pattern: /super league|liga super/i, countries: list("Malaysia") },
  { pattern: /liga 1|liga indonesia/i, countries: list("Indonesia") },
  { pattern: /v.?league/i, countries: list("Vietnam") },
  { pattern: /super league|superliga|olympic uz/i, countries: list("Uzbekistan") },

  // Oceania
  { pattern: /national league|chatham cup/i, countries: list("New-Zealand") },

  // Generic youth INTERNATIONAL tournaments (U17/U19/U20/U21 continental + world).
  // Restricted to international competitions so that domestic youth/reserve
  // leagues (e.g. "Bundesliga U19", "Premier League 2") stay Tier 2.
  { pattern: /\bu-?(17|19|20|21)\b/i, countries: INTERNATIONAL },
];

/**
 * Never Tier 1, whatever else matches:
 * - qualifiers / playoffs / promotion-relegation mini-competitions
 * - reserve, youth, academy, B-team and "Premier League 2"-style competitions
 *   that reuse a senior competition's name
 * Genuine youth INTERNATIONAL tournaments are matched before this via the
 * INTERNATIONAL youth rule, so they are unaffected.
 */
const EXCLUDE_ALWAYS = /friendl/i;
const EXCLUDE_NON_SENIOR =
  /\b(reserves?|reserve league|youth|academy|juniors?|primavera|u-?\d{2}|sub-?\d{2})\b|\bii\b|\b(b|c)\s*team\b|\bteam\s*b\b/i;
/** "Premier League 2", "Liga 2 ... U20" style numeric suffixes on a senior name. */
const EXCLUDE_SUFFIX_LEAGUE2 = /^(premier league|bundesliga|serie a|la liga|eredivisie)\s*2\b/i;

/**
 * Supplementary allow-list of stable API-Football league IDs for the biggest
 * competitions. Names can be renamed or re-spelled by the provider; IDs are
 * stable. This is additive only - it can promote to Tier 1 but never demote,
 * so a stale entry can never silently disable coverage.
 */
const TIER1_LEAGUE_IDS = new Set<number>([
  // International (country "World")
  1, // FIFA World Cup
  2, // UEFA Champions League
  3, // UEFA Europa League
  4, // Euro Championship
  5, // UEFA Nations League
  6, // Africa Cup of Nations
  7, // Asian Cup
  9, // Copa America
  11, // CONMEBOL Sudamericana
  12, // CAF Champions League
  13, // CONMEBOL Libertadores
  15, // FIFA Club World Cup
  16, // CONCACAF Champions League
  17, // AFC Champions League
  19, // African Nations Championship
  20, // CONCACAF Gold Cup
  21, // Confederations Cup
  22, // CONCACAF Gold Cup qualification
  26, // International Champions Cup
  29, // World Cup - Qualification Africa
  30, // World Cup - Qualification Asia
  31, // World Cup - Qualification CONCACAF
  32, // World Cup - Qualification Europe
  34, // World Cup - Qualification South America
  480, // Olympics Men
  524, // UEFA Youth League
  531, // UEFA Super Cup
  536, // CAF Super Cup
  541, // CONMEBOL Recopa
  772, // Leagues Cup (CONCACAF)
  848, // UEFA Europa Conference League

  // England
  39, 40, 41, 42, 45, 48, 528,
  // France
  61, 62, 65, 66,
  // Germany
  78, 79, 81, 529,
  // Italy
  135, 136, 137, 547,
  // Spain
  140, 141, 143, 556,
  // Netherlands
  88, 89, 90,
  // Portugal
  94, 95, 96, 97, 550,
  // Belgium
  144, 145, 147,
  // Turkey
  203, 204, 206, 551,
  // Scotland
  179, 180, 181, 185,
  // Brazil
  71, 72, 73,
  // Argentina
  128, 129, 130,
  // USA / Mexico / Canada
  253, 255, 257, 262, 263, 264, 495,
  // Saudi Arabia / Qatar / UAE / Japan / South Korea / China
  307, 308, 504, 305, 301, 98, 99, 292, 293, 169,
  // Africa
  233, 234, // Egypt Premier League / Egypt Cup
  200, 201, // Morocco Botola / Throne Cup
  288, 289, // South Africa PSL / First Division
  399, 400, // Nigeria NPFL (NPFL / NNL)
  186, // Algeria Ligue 1
  202, // Tunisia Ligue 1
  // Other Europe
  218, 207, 197, 333, 119, 103, 113, 345, 106, 210, 283, 235,
]);

/**
 * Normalize a competition name for matching:
 * strip accents, collapse punctuation/whitespace, lowercase.
 * ("Botola Pro", "Primera División", "1. Bundesliga", "Süper Lig" ...)
 */
function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´]/g, "'")
    .replace(/[^a-z0-9'\- ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCountry(value: string | null | undefined): string {
  return normalizeName(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Classify a competition. NEVER throws: any unexpected input (null, undefined,
 * numbers, objects, exotic unicode) safely degrades to Tier 2 (excluded), so
 * an unknown competition can never crash or stop the automation.
 */
export function classifyCompetition(
  leagueName: string | null | undefined,
  country: string | null | undefined,
  leagueId?: number | null,
): Tier {
  try {
    if (typeof leagueId === "number" && Number.isFinite(leagueId) && TIER1_LEAGUE_IDS.has(leagueId)) {
      return 1;
    }

    const raw = typeof leagueName === "string" ? leagueName : "";
    const name = normalizeName(raw);
    if (!name) return 2;
    if (EXCLUDE_ALWAYS.test(name)) return 2;
    if (EXCLUDE_SUFFIX_LEAGUE2.test(name)) return 2;

    const normalizedCountry = normalizeCountry(country);
    const isInternational =
      normalizedCountry === "" || normalizedCountry === "world" || normalizedCountry === "international";

    // Domestic reserve/youth competitions reuse senior names - keep them Tier 2.
    if (!isInternational && EXCLUDE_NON_SENIOR.test(name)) return 2;

    for (const rule of TIER1_RULES) {
      if (rule.countries === INTERNATIONAL) {
        if (!isInternational) continue;
      } else if (rule.countries !== null && !rule.countries.includes(normalizedCountry)) {
        continue;
      }
      if (rule.pattern.test(name)) return 1;
    }
    return 2;
  } catch {
    // Defensive: classification must never break the run.
    return 2;
  }
}

/**
 * Single platform-wide eligibility predicate.
 * Only Tier 1 (popular, high-interest) competitions are covered; everything
 * else is excluded from processing, publishing and reporting.
 */
export function isEligibleCompetition(
  leagueName: string | null | undefined,
  country: string | null | undefined,
  leagueId?: number | null,
): boolean {
  return classifyCompetition(leagueName, country, leagueId) === 1;
}
