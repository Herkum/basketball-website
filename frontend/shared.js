// Small helpers shared between the public site (site.js) and the admin SPA
// (admin/app.js) — business rules like the season-boundary date and the
// Google Maps URL template, not just incidental code, so they live in one
// place instead of two copies that can silently drift.

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Basketball seasons span a calendar-year boundary (roughly Nov-Feb), so
// "this season" from July onward is year-(year+1); before that it's
// (year-1)-year.
function defaultSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/* ------------------------------ Standings ------------------------------ */
// Used by both the public Standings page / Home teaser / sidebar record box
// (site.js) and the admin's League Standings table (admin/app.js), so the
// two always sort, rank, and format the same scraped rows identically.

// Standings rows store records as "W-L" strings (from the MaxPreps
// scrape) - parse one back into numbers for sorting/comparison.
function parseRecord(str) {
  const [wins, losses] = (str || "0-0").split("-").map(Number);
  return { wins: wins || 0, losses: losses || 0 };
}

// Best league record first, then best overall record as a tiebreaker -
// used instead of the scraped `rank` field, which this site doesn't show.
function compareStandingsRows(a, b) {
  const aLeague = parseRecord(a.league_record);
  const bLeague = parseRecord(b.league_record);
  if (aLeague.wins !== bLeague.wins) return bLeague.wins - aLeague.wins;
  if (aLeague.losses !== bLeague.losses) return aLeague.losses - bLeague.losses;
  const aOverall = parseRecord(a.overall_record);
  const bOverall = parseRecord(b.overall_record);
  if (aOverall.wins !== bOverall.wins) return bOverall.wins - aOverall.wins;
  return aOverall.losses - bOverall.losses;
}

// Win percentage recomputed from the W-L string rather than read from the
// scraped `*_pct` fields - MaxPreps sometimes reports a stale .000 for a
// team that already has a win (e.g. a 1-0 team), and a 0-0 team reads
// better as a dash than as ".000". Formatted the conventional way (".667",
// "1.000") with no leading zero.
function formatPct(record) {
  const { wins, losses } = parseRecord(record);
  const games = wins + losses;
  if (!games) return "—";
  const pct = (wins / games).toFixed(3);
  return pct.startsWith("0") ? pct.slice(1) : pct;
}

function formatDiff(pf, pa) {
  const diff = (Number(pf) || 0) - (Number(pa) || 0);
  return diff > 0 ? `+${diff}` : String(diff);
}

// Same green/red as the streak badges - positive differential green,
// negative red, zero left neutral.
function diffClass(diff) {
  if (diff.startsWith("+")) return "diff-pos";
  if (diff.startsWith("-")) return "diff-neg";
  return "";
}

// Standard competition ranking over compareStandingsRows' order - teams
// with identical league and overall records share a place ("T-1"), and
// the next distinct team skips ahead (1, 1, 3), like any printed standings.
function standingsPlaces(sortedRows) {
  const places = [];
  sortedRows.forEach((row, i) => {
    if (i > 0 && compareStandingsRows(sortedRows[i - 1], row) === 0) {
      places.push(places[i - 1]);
    } else {
      places.push(i + 1);
    }
  });
  const counts = places.reduce((acc, p) => ({ ...acc, [p]: (acc[p] || 0) + 1 }), {});
  return places.map((p) => ({ place: p, tied: counts[p] > 1 }));
}

// "2W"/"1L" from the scrape -> {isWin, count, label: "W2"}; null for
// anything without a W/L or a zero count (e.g. "0" before a team has
// played), which callers render as a plain dash.
function parseStreak(streak) {
  const match = /^(\d+)\s*([WL])$/i.exec((streak || "").trim());
  if (!match || match[1] === "0") return null;
  const isWin = match[2].toUpperCase() === "W";
  return { isWin, count: Number(match[1]), label: `${isWin ? "W" : "L"}${match[1]}` };
}

// Monogram for a school's shield badge in the standings tables - first
// letter of each word, like the header's Logo fallback ("Newbury Park" ->
// "NP", "Agoura" -> "A"), capped at 3 letters for long names.
function schoolInitials(name) {
  return (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase())
    .join("")
    .slice(0, 3);
}

// School colors for the standings shield badges, keyed by lowercased
// `school` as the MaxPreps scrape spells it. bg = shield fill (the
// school's primary color), fg = initials (its secondary color), border =
// outline (the fill color again when the secondary is white, so the
// shield doesn't lose its edge on the light page). A school missing from
// this map falls back to the plain outlined badge; our own row (matched
// by the Logo block title) is styled separately in CSS with the site
// header's yellow, so Newbury Park isn't listed here.
const SCHOOL_COLORS = {
  // Hex values sampled from each school's own athletics site.
  "thousand oaks": { bg: "#108141", fg: "#ffffff", border: "#108141" }, // toathletics.com green & white
  westlake: { bg: "#2e3192", fg: "#f26522", border: "#f26522" }, // westlakeathletics.com blue & orange
  "oaks christian": { bg: "#820729", fg: "#ffffff", border: "#820729" }, // oakschristian.org red & white
  agoura: { bg: "#f4bf00", fg: "#002dec", border: "#002dec" }, // agouraathletics.net gold & blue
  calabasas: { bg: "#e0c9a0", fg: "#000000", border: "#000000" }, // calabasasathletics.net gold & black
};

// WCAG relative luminance / contrast ratio for "#rrggbb" colors.
function colorLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [colorLuminance(a), colorLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Shield colors from a team's MaxPreps school colors (color1/color2,
// "#rrggbb" - see Rankings in docs/content-schemas.md), for schools not
// in the hand-sampled SCHOOL_COLORS map. Same conventions as that map:
// fill = primary, initials = secondary, outline = secondary unless it's
// near-white (then the fill again, so the shield keeps its edge on the
// light page). MaxPreps pairs are often two darks (navy/gray, red/black)
// whose initials would be unreadable, so below 3:1 the initials switch
// to whichever of black/white reads better on the fill, while the
// outline still carries the secondary color.
function badgeColorsFromTeam(color1, color2) {
  const valid = (c) => /^#[0-9a-f]{6}$/i.test(c || "");
  if (!valid(color1)) return null;
  const bg = color1;
  const secondary = valid(color2) ? color2 : "#ffffff";
  const nearWhite = (c) => colorLuminance(c) > 0.85;
  let border = nearWhite(secondary) ? bg : secondary;
  // A near-white fill with a near-white outline would vanish entirely.
  if (nearWhite(border)) border = "#201f1d";
  let fg = secondary;
  if (contrastRatio(bg, fg) < 3) fg = contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#000000") ? "#ffffff" : "#000000";
  return { bg, fg, border };
}

// Inline CSS custom properties for a school's badge ("" when unknown) -
// .school-badge reads --badge-bg/--badge-fg/--badge-border with neutral
// fallbacks. The hand-sampled SCHOOL_COLORS entry wins when there is one;
// otherwise `team` (any object with MaxPreps color1/color2, e.g. a
// Rankings team row) supplies them.
function schoolBadgeStyle(name, team) {
  const colors = SCHOOL_COLORS[(name || "").trim().toLowerCase()] || badgeColorsFromTeam(team?.color1, team?.color2);
  return colors ? `--badge-bg:${colors.bg};--badge-fg:${colors.fg};--badge-border:${colors.border}` : "";
}
