/**
 * Country-name to flag-emoji conversion for DynaSport lineup posts.
 *
 * Club countries are resolved DYNAMICALLY (see teamMeta.ts): verified metadata
 * from the API response, then a Neon cache keyed by stable API team ID, then a
 * budget-guarded /teams lookup. A missing country never blocks a lineup post.
 *
 * This module only converts a VERIFIED country name into a flag - it never
 * guesses a club's country from its name, its players or the competition host.
 */

const ISO_BY_COUNTRY: Record<string, string> = {
  afghanistan: "af", albania: "al", algeria: "dz", angola: "ao", argentina: "ar", armenia: "am",
  australia: "au", austria: "at", azerbaijan: "az", bahrain: "bh", bangladesh: "bd", belarus: "by",
  belgium: "be", benin: "bj", bolivia: "bo", "bosnia and herzegovina": "ba", bosnia: "ba",
  botswana: "bw", brazil: "br", bulgaria: "bg", "burkina faso": "bf", burundi: "bi", cameroon: "cm",
  canada: "ca", "cape verde": "cv", "cabo verde": "cv", "central african republic": "cf", chad: "td",
  chile: "cl", china: "cn", "china pr": "cn", colombia: "co", comoros: "km", congo: "cg",
  "congo dr": "cd", "dr congo": "cd", "democratic republic of congo": "cd", "costa rica": "cr",
  croatia: "hr", cuba: "cu", curacao: "cw", cyprus: "cy", "czech republic": "cz", czechia: "cz",
  denmark: "dk", "dominican republic": "do", ecuador: "ec", egypt: "eg", "el salvador": "sv",
  england: "gb-eng", "equatorial guinea": "gq", eritrea: "er", estonia: "ee", eswatini: "sz",
  ethiopia: "et", "faroe islands": "fo", finland: "fi", france: "fr", gabon: "ga", gambia: "gm",
  georgia: "ge", germany: "de", ghana: "gh", gibraltar: "gi", greece: "gr", guatemala: "gt",
  guinea: "gn", "guinea-bissau": "gw", haiti: "ht", honduras: "hn", "hong kong": "hk",
  hungary: "hu", iceland: "is", india: "in", indonesia: "id", iran: "ir", iraq: "iq",
  ireland: "ie", "republic of ireland": "ie", israel: "il", italy: "it", "ivory coast": "ci",
  "cote d'ivoire": "ci", "côte d'ivoire": "ci", jamaica: "jm", japan: "jp", jordan: "jo",
  kazakhstan: "kz", kenya: "ke", kosovo: "xk", kuwait: "kw", kyrgyzstan: "kg", latvia: "lv",
  lebanon: "lb", lesotho: "ls", liberia: "lr", libya: "ly", liechtenstein: "li", lithuania: "lt",
  luxembourg: "lu", madagascar: "mg", malawi: "mw", malaysia: "my", mali: "ml", malta: "mt",
  mauritania: "mr", mauritius: "mu", mexico: "mx", moldova: "md", mongolia: "mn", montenegro: "me",
  morocco: "ma", mozambique: "mz", myanmar: "mm", namibia: "na", nepal: "np", netherlands: "nl",
  "new zealand": "nz", nicaragua: "ni", niger: "ne", nigeria: "ng", "north macedonia": "mk",
  "northern ireland": "gb-nir", norway: "no", oman: "om", pakistan: "pk", palestine: "ps",
  panama: "pa", "papua new guinea": "pg", paraguay: "py", peru: "pe", philippines: "ph",
  poland: "pl", portugal: "pt", qatar: "qa", romania: "ro", russia: "ru", rwanda: "rw",
  "saudi arabia": "sa", scotland: "gb-sct", senegal: "sn", serbia: "rs", "sierra leone": "sl",
  singapore: "sg", slovakia: "sk", slovenia: "si", somalia: "so", "south africa": "za",
  "south korea": "kr", "korea republic": "kr", "south sudan": "ss", spain: "es", "sri lanka": "lk",
  sudan: "sd", suriname: "sr", sweden: "se", switzerland: "ch", syria: "sy", tanzania: "tz",
  thailand: "th", togo: "tg", "trinidad and tobago": "tt", tunisia: "tn", turkey: "tr",
  turkiye: "tr", türkiye: "tr", uganda: "ug", ukraine: "ua", "united arab emirates": "ae",
  uae: "ae", "united states": "us", usa: "us", uruguay: "uy", uzbekistan: "uz", venezuela: "ve",
  vietnam: "vn", wales: "gb-wls", yemen: "ye", zambia: "zm", zimbabwe: "zw",
};

/** Home-nation flags are not expressible as two-letter regional indicators. */
const SUBDIVISION_FLAGS: Record<string, string> = {
  "gb-eng": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "gb-sct": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "gb-wls": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "gb-nir": "🇬🇧",
  xk: "🇽🇰",
};

function toRegionalIndicator(code: string): string {
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + code.toUpperCase().charCodeAt(0) - 65,
    base + code.toUpperCase().charCodeAt(1) - 65,
  );
}

function flagForIso(iso: string): string {
  if (SUBDIVISION_FLAGS[iso]) return SUBDIVISION_FLAGS[iso];
  if (!/^[a-z]{2}$/.test(iso)) return "";
  return toRegionalIndicator(iso);
}

/**
 * Convert a VERIFIED country name (as returned by API-Football, e.g. the
 * `country` field of /teams, or a national team's own name) into a flag emoji.
 *
 * This is the only accepted country->flag conversion. It never guesses:
 * an unrecognised country yields "" and the post is published without a flag.
 *
 * Special cases per the DynaSport rules:
 *  - England / Scotland / Wales use the Unicode subdivision flags
 *    (🏴󠁧󠁢󠁥󠁮󠁧󠁿 🏴󠁧󠁢󠁳󠁣󠁴󠁿 🏴󠁧󠁢󠁷󠁬󠁳󠁿) with 🇬🇧 as the safe fallback for
 *    renderers that cannot display subdivision sequences.
 *  - Northern Ireland has no subdivision sequence and uses 🇬🇧.
 */
export function flagForCountry(countryName: string | null | undefined): string {
  if (typeof countryName !== "string") return "";
  const key = countryName
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const iso = ISO_BY_COUNTRY[key];
  if (!iso) return "";
  return flagForIso(iso);
}

/**
 * Flag for a team when the team itself IS a nation (a national team whose
 * verified name is the country name). Only used for national teams - never
 * for clubs, whose country must come from verified team metadata.
 */
export function flagForNationalTeam(teamName: string | null | undefined): string {
  return flagForCountry(teamName);
}

/**
 * Whether a team name is an exact, unambiguous country name. Used ONLY when
 * the fixture is an international competition (league country "World"), where
 * the participating teams are national teams by definition.
 */
export function isCountryName(teamName: string | null | undefined): boolean {
  if (typeof teamName !== "string") return false;
  const key = teamName.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  return Boolean(ISO_BY_COUNTRY[key]);
}

export { SUBDIVISION_FLAGS };
