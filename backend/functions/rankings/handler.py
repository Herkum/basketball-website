"""Regional power rankings: scrapes every team in a fixed set of MaxPreps
leagues, then rates them with a capped-margin Simple Rating System (SRS)
so teams that never play each other can still be ranked
through common opponents.

A screen-scraper, not CRUD: `GET` (public) serves the cached result
instantly, and a direct/EventBridge invoke (no `requestContext`) does the
actual scrape + recompute. It's also the only MaxPreps scrape on the site:
our own league's table (the `standings: True` entry in TRACKED_LEAGUES) is
written to the League Standings cache as part of every refresh (see
`_write_standings`) - the `standings` Lambda just serves and hand-edits it. A full scrape fetches
anywhere from ~100 to a few hundred MaxPreps pages (see "outside opponents"
in `_refresh`) and takes minutes, far past API Gateway's 30s integration
timeout - so the admin's `POST` (JWT) doesn't scrape itself: it re-invokes
this same function asynchronously (`InvocationType="Event"`) and returns
202 right away. A `"refresh"` lock row (`started_at`) keeps a second POST
from starting an overlapping scrape while one is running; `GET` reports it
as `refresh_started_at` so the admin can show progress.
"""

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
users_table = dynamodb.Table(os.environ["USERS_TABLE_NAME"])
# Our own league's table also feeds the League Standings cache (see
# _write_standings) - one MaxPreps scrape serves both.
standings_table = dynamodb.Table(os.environ["STANDINGS_TABLE_NAME"])
lambda_client = boto3.client("lambda")

CACHE_ID = "current"
REFRESH_LOCK_ID = "refresh"
REQUIRED_PERMISSION = "Edit Season"
# A lock older than this is from a run that died without clearing it (the
# Lambda's own 900s timeout kills it before the `finally` runs), so a new
# POST may take it over.
REFRESH_LOCK_STALE_SECONDS = 16 * 60
MAXPREPS = "https://www.maxpreps.com"

# One member school per tracked league. Each refresh follows that school's
# standings page to its *current-season* league page and takes the league's
# membership from there, so a new season (or a realignment) needs no code
# change as long as the seed school is still in a league with that slug.
# `league` is the slug we expect - a mismatch is reported in `warnings`
# rather than silently tracking the wrong league. `standings: True` marks
# our own league: its table is also written to the League Standings cache.
TRACKED_LEAGUES = [
    {"league": "marmonte", "section": "Southern", "seed": "/ca/newbury-park/newbury-park-panthers/", "standings": True},
    {"league": "coastal-canyon", "section": "Southern", "seed": "/ca/simi-valley/simi-valley-pioneers/"},
    {"league": "channel", "section": "Southern", "seed": "/ca/ventura/ventura-cougars/"},
    {"league": "citrus-coast", "section": "Southern", "seed": "/ca/fillmore/fillmore-flashes/"},
    {"league": "tri-valley", "section": "Southern", "seed": "/ca/ventura/st-bonaventure-seraphs/"},
    {"league": "frontier", "section": "Southern", "seed": "/ca/santa-barbara/laguna-blanca-owls/"},
    {"league": "mission", "section": "Southern", "seed": "/ca/chatsworth/sierra-canyon-trailblazers/"},
    {"league": "gold-coast", "section": "Southern", "seed": "/ca/calabasas/viewpoint-patriots/"},
    {"league": "west-valley", "section": "LA City", "seed": "/ca/chatsworth/chatsworth-charter-chancellors/"},
    {"league": "valley-mission", "section": "LA City", "seed": "/ca/canoga-park/canoga-park-hunters/"},
]

# Margins beyond this count as this many points, so running up the score
# on a weak opponent doesn't inflate a rating.
MARGIN_CAP = 15
# SRS home-court edge in points. Fixed rather than fitted - early in the
# season there aren't enough games to estimate it without it swinging wildly.
HOME_COURT_POINTS = 3.0
# Ridge prior: every team gets this many phantom 0-margin games against an
# average (0-rated) team. Keeps ratings finite while the schedule graph is
# still disconnected early in the season, and shrinks small samples toward 0.
SRS_PRIOR_GAMES = 1.0

FETCH_DELAY_SECONDS = 0.3

# Outside opponents (teams a tracked team played that aren't in a tracked
# league) get their own schedules scraped too, one level out, so they're
# rated from their real results instead of being assumed average. That's
# up to a few hundred extra pages late in the season, so stop starting new
# outside scrapes once the Lambda is within this many seconds of its
# timeout - leaving room for geocoding, the rating solve, and the writes.
# Outside teams are scraped most-connected first, so a cut-off run drops
# the least useful ones.
OUTSIDE_SCRAPE_RESERVE_SECONDS = 120
# DynamoDB's item limit is 400KB; past this the "games" debug row keeps
# only games involving a tracked team.
GAMES_ROW_MAX_BYTES = 350_000

# School coordinates for the public School Map tab, looked up from each
# school's MaxPreps street address via OpenStreetMap's Nominatim geocoder.
# Its usage policy: at most 1 request/second, an identifying User-Agent,
# and cache the results - so coordinates live in their own "geo" row and a
# school is only re-geocoded when its address changes (in practice: once).
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_USER_AGENT = "basketball-website-rankings/1.0 (+https://dt3ujgqjdxxfm.cloudfront.net)"
GEOCODE_DELAY_SECONDS = 1.1


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def _http_get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _fetch(path):
    time.sleep(FETCH_DELAY_SECONDS)
    return _http_get(MAXPREPS + path)


def _unescape(text):
    return text.replace("&amp;", "&").replace("&#x27;", "'").replace("&quot;", '"').strip()


def _strip_tags(html_fragment):
    return re.sub(r"<[^>]+>", "", html_fragment).strip()


# --- scraping ---


def find_league_path(school_path):
    """A school's standings page links to its current league page, e.g.
    /ca/basketball/26-27/league/channel/?leagueid=<uuid>."""
    html = _fetch(school_path + "basketball/standings/")
    match = re.search(r'href="(/ca/basketball/[0-9-]+/league/([a-z0-9-]+)/\?leagueid=[a-f0-9-]+)"', html)
    if not match:
        raise ValueError(f"no league link on {school_path}")
    return _unescape(match.group(1)), match.group(2)


def scrape_league(league_path):
    """A MaxPreps league standings page - server-rendered, no JS needed.
    Each row is <tr><td>rank</td><td class="school-details">...
    <a href=".../ca/<city>/<school>/basketball/" class="school-link">
    <span class="school-name">Name</span>...</td><td>league W-L</td>
    <td>league pct</td><td>league PF</td><td>league PA</td>
    <td>overall W-L</td><td>overall pct</td><td>overall PF</td>
    <td>overall PA</td><td>streak</td></tr> (streak cells hold an inline
    comment, e.g. "3<!-- -->L", that _strip_tags removes). Returns each
    member's school path, name, and MaxPreps' own table numbers - shown on
    the Regional Leagues page's per-league tables, and for our league,
    written to the League Standings cache too. Fragile by nature: a markup
    change silently yields fewer/no rows."""
    html = _fetch(league_path)
    tbody = html[html.find("<tbody") : html.find("</tbody>")]
    members = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody, re.S):
        match = re.search(
            r'href="https://www\.maxpreps\.com(/ca/[a-z0-9-]+/[a-z0-9-]+/)basketball/" class="school-link">'
            r'<span class="school-name">(.*?)</span>',
            row_html,
        )
        cells = [_strip_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row_html, re.S)]
        if not match or len(cells) < 11:
            continue
        members.append(
            {
                "team_id": match.group(1),
                "name": _unescape(match.group(2)),
                "rank": cells[0],
                "league_record": cells[2],
                "league_pct": cells[3],
                "league_pf": cells[4],
                "league_pa": cells[5],
                "overall_record": cells[6],
                "overall_pct": cells[7],
                "overall_pf": cells[8],
                "overall_pa": cells[9],
                "streak": cells[10],
            }
        )
    return members


def _write_standings(members, source_url, warnings):
    """Writes our league's table to the League Standings cache (the
    `standings` table's "current" row, same row shape it always had).
    `link` is admin-set, never scraped, so it's carried forward from the
    previous cache by case-insensitive school name. A table that parses as
    zero rows (a MaxPreps markup change) keeps the previous standings
    rather than wiping them. Failures only warn - the rankings refresh
    carries on either way."""
    try:
        if not members:
            warnings.append("standings: our league's table parsed as zero rows - kept the previous standings")
            return
        cached = standings_table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {}
        links = {(r.get("school") or "").lower(): r.get("link", "") for r in cached.get("rows", [])}
        fields = ("rank", "league_record", "league_pct", "league_pf", "league_pa",
                  "overall_record", "overall_pct", "overall_pf", "overall_pa", "streak")
        rows = [
            {"school": m["name"], **{f: m.get(f, "") for f in fields}, "link": links.get(m["name"].lower(), "")}
            for m in members
        ]
        standings_table.put_item(
            Item={"cache_id": CACHE_ID, "source_url": source_url, "updated_at": int(time.time()), "rows": rows}
        )
    except Exception as exc:
        warnings.append(f"standings write: {exc}")


# Slugs whose real name isn't just the title-cased words.
LEAGUE_NAME_OVERRIDES = {"tri-valley": "Tri-Valley"}


def _league_display_name(slug):
    return LEAGUE_NAME_OVERRIDES.get(slug) or " ".join(word.capitalize() for word in slug.split("-"))


def scrape_schedule(team_id):
    """Parses a team's varsity schedule page. Each game row looks like:
      <a ... href="/ca/basketball/game/<slug>/11-16-2026/?c=<contest uuid>">
      <span class="hat">vs|@</span> ... <span class="name">Opponent***</span>
      <span class="result W|L">W</span> <span class="score">55-30</span>
    The score is always winner-first regardless of W/L. Trailing asterisks
    on the opponent name mark the game type (* league, ** playoffs,
    *** tournament). Unplayed games have no result span and are skipped.

    Also returns the school's own street address - the page's first
    schema.org PostalAddress (JSON-LD) is the team's school; later ones
    belong to opponents - and its MaxPreps school colors: the page's
    embedded team records each carry `teamCanonicalUrl` followed shortly by
    `"color1":"222222","color2":"FFC005"` (hex, no #; blank/null when
    unset), and we take the record whose URL is this team's own.
    """
    html = _fetch(team_id + "basketball/schedule/")
    address = None
    match = re.search(r'"address":(\{"@type":"PostalAddress"[^}]*\})', html)
    if match:
        try:
            raw = json.loads(match.group(1))
            address = {
                "name": (raw.get("name") or "").strip(),
                "street": (raw.get("streetAddress") or "").strip(),
                "city": (raw.get("addressLocality") or "").strip(),
                "state": (raw.get("addressRegion") or "").strip(),
                "zip": (raw.get("postalCode") or "").strip(),
            }
        except ValueError:
            pass

    colors = {}
    own = re.search(r'"teamCanonicalUrl":"https://www\.maxpreps\.com' + re.escape(team_id) + r'basketball/"(.{0,1500})', html, re.S)
    if own:
        # Stop at the next team record so a team with no colors of its own
        # can't pick up a neighbouring opponent's.
        record = own.group(1).split('"teamCanonicalUrl"')[0]
        for key in ("color1", "color2"):
            hex_match = re.search(r'"' + key + r'":"([0-9A-Fa-f]{6})"', record)
            if hex_match:
                colors[key] = "#" + hex_match.group(1).lower()
    games = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        contest = re.search(r"/(\d{2})-(\d{2})-(\d{4})/\?c=([a-f0-9-]+)", row_html)
        result = re.search(r'class="result ([WL])">[WL]</span>\s*<span class="score">(\d+)-(\d+)', row_html)
        opponent = re.search(
            r'href="(/ca/[a-z0-9-]+/[a-z0-9-]+/)basketball/"><span class="hat">([^<]*)</span>.*?class="name">([^<]*)</span>',
            row_html,
            re.S,
        )
        if not (contest and result and opponent):
            continue
        month, day, year, contest_id = contest.groups()
        outcome, high, low = result.group(1), int(result.group(2)), int(result.group(3))
        name = _unescape(opponent.group(3))
        stars = len(name) - len(name.rstrip("*"))
        games.append(
            {
                "contest_id": contest_id,
                "date": f"{year}-{month}-{day}",
                "opponent_id": opponent.group(1),
                "opponent_name": name.rstrip("*").strip(),
                "away": opponent.group(2).strip() == "@",
                "kind": {1: "league", 2: "playoff", 3: "tournament"}.get(stars, "nonleague"),
                "points_for": high if outcome == "W" else low,
                "points_against": low if outcome == "W" else high,
            }
        )
    return games, address, colors


def _address_line(address):
    return ", ".join(p for p in [address["street"], address["city"], f"{address['state']} {address['zip']}".strip()] if p)


def geocode(address, team_name):
    """Nominatim lookup, most to least precise, stopping at the first hit:
    1. the structured street address as MaxPreps has it;
    2. the same with periods and a leading direction word dropped - OSM
       often stores "20801 West Rinaldi St." as just "Rinaldi Street";
    3. the school by name in its city - MaxPreps' official name, then
       "<team name> School" (OSM knows "Oaks Christian School" and "Cate
       School", not MaxPreps' "Oaks Christian High School" or their street
       addresses);
    4. the ZIP code's centroid (close enough for a regional map pin).
    Returns (lat, lng) or None."""
    street = address["street"]
    simplified = re.sub(r"^(\d+\s+)(?:north|south|east|west)\s+", r"\1", street.replace(".", ""), flags=re.I)
    structured = {"city": address["city"], "state": address["state"], "postalcode": address["zip"]}
    school_names = list(dict.fromkeys(filter(None, [address["name"], f"{team_name} School"])))
    attempts = [
        {"street": street, **structured},
        {"street": simplified, **structured} if simplified != street else None,
        *({"q": f"{name}, {address['city']}, {address['state']}"} for name in school_names),
        {"postalcode": address["zip"]} if address["zip"] else None,
    ]
    for params in filter(None, attempts):
        time.sleep(GEOCODE_DELAY_SECONDS)
        query = urllib.parse.urlencode({**params, "countrycodes": "us", "format": "jsonv2", "limit": 1})
        results = json.loads(_http_get(f"{NOMINATIM_URL}?{query}", {"User-Agent": NOMINATIM_USER_AGENT}))
        if results:
            return float(results[0]["lat"]), float(results[0]["lon"])
    return None


def resolve_locations(addresses, names, warnings):
    """team_id -> {address, lat, lng}, reusing the cached "geo" row for any
    school whose address hasn't changed and geocoding the rest. Saves the
    row back only if something new was looked up."""
    cached = (table.get_item(Key={"cache_id": "geo"}).get("Item") or {}).get("locations", {})
    locations = {}
    changed = False
    for team_id, address in addresses.items():
        line = _address_line(address)
        hit = cached.get(team_id)
        if hit and hit.get("address") == line:
            locations[team_id] = hit
            continue
        try:
            coords = geocode(address, names[team_id])
        except Exception as exc:
            warnings.append(f"geocode {team_id}: {exc}")
            continue
        if not coords:
            warnings.append(f"geocode {team_id}: no match for '{line}'")
            continue
        locations[team_id] = {"address": line, "lat": _dec(coords[0], 5), "lng": _dec(coords[1], 5)}
        changed = True
    if changed:
        table.put_item(Item={"cache_id": "geo", "updated_at": int(time.time()), "locations": {**cached, **locations}})
    return locations


def merge_games(views_by_team):
    """Each game between two tracked teams shows up on both schedules -
    dedupe by MaxPreps contest id. Home/away: tournament games are treated
    as neutral, and if both sides list the other as "vs" (MaxPreps does
    this for some neutral-site games) it's neutral too; otherwise the team
    not marked "@" is home."""
    games = {}
    for team_id, views in views_by_team.items():
        for view in views:
            # Normalize to a fixed orientation (team_a < team_b) so both
            # schedules' copies of the same game compare equal.
            a, b = sorted([team_id, view["opponent_id"]])
            flipped = a != team_id
            game = games.setdefault(
                view["contest_id"],
                {
                    "contest_id": view["contest_id"],
                    "date": view["date"],
                    "kind": view["kind"],
                    "team_a": a,
                    "team_b": b,
                    "score_a": view["points_against"] if flipped else view["points_for"],
                    "score_b": view["points_for"] if flipped else view["points_against"],
                    "a_home_votes": [],
                },
            )
            # True = team_a is home, False = team_b is home, per this view.
            this_side_home = not view["away"]
            game["a_home_votes"].append(this_side_home if not flipped else not this_side_home)

    merged = []
    for game in games.values():
        votes = game.pop("a_home_votes")
        if game["kind"] == "tournament" or (len(votes) == 2 and votes[0] != votes[1]):
            game["home"] = None
        else:
            game["home"] = game["team_a"] if votes[0] else game["team_b"]
        merged.append(game)
    merged.sort(key=lambda g: (g["date"], g["contest_id"]))
    return merged


# --- ratings ---


def _capped(margin):
    return max(-MARGIN_CAP, min(MARGIN_CAP, margin))


def _solve_srs_system(n, edges, rhs):
    """Conjugate gradient for (SRS_PRIOR_GAMES * I + L) x = rhs, where L is
    the schedule graph's Laplacian (one edge per game). That matrix is
    symmetric positive definite (thanks to the prior), so CG converges, and
    each iteration costs O(teams + games) without ever building the dense
    n x n matrix - with outside opponents' schedules included, n reaches
    the high hundreds late in the season, where dense elimination in plain
    Python would take minutes (no numpy in the Lambda runtime)."""

    def matvec(x):
        y = [SRS_PRIOR_GAMES * v for v in x]
        for i, j in edges:
            d = x[i] - x[j]
            y[i] += d
            y[j] -= d
        return y

    x = [0.0] * n
    r = rhs[:]
    p = r[:]
    rs = sum(v * v for v in r)
    tolerance = 1e-12 * max(rs, 1.0)
    for _ in range(max(n, 1) * 2):
        if rs <= tolerance:
            break
        ap = matvec(p)
        alpha = rs / sum(pi * api for pi, api in zip(p, ap))
        x = [xi + alpha * pi for xi, pi in zip(x, p)]
        r = [ri - alpha * api for ri, api in zip(r, ap)]
        rs_new = sum(v * v for v in r)
        p = [ri + (rs_new / rs) * pi for ri, pi in zip(r, p)]
        rs = rs_new
    return x


def compute_srs(games):
    """Least-squares fit of rating_home - rating_away + home_edge ≈
    capped margin, over every game, with a ridge prior (see
    SRS_PRIOR_GAMES). A rating is points better than an average team on a
    neutral floor, so rating_a - rating_b predicts a head-to-head margin."""
    teams = sorted({g["team_a"] for g in games} | {g["team_b"] for g in games})
    index = {t: i for i, t in enumerate(teams)}
    edges = []
    rhs = [0.0] * len(teams)
    for g in games:
        i, j = index[g["team_a"]], index[g["team_b"]]
        edge = 0.0 if g["home"] is None else (HOME_COURT_POINTS if g["home"] == g["team_a"] else -HOME_COURT_POINTS)
        target = _capped(g["score_a"] - g["score_b"]) - edge
        edges.append((i, j))
        rhs[i] += target
        rhs[j] -= target
    ratings = _solve_srs_system(len(teams), edges, rhs)
    return dict(zip(teams, ratings))


def _rank(values):
    """1..n ranking, highest value first (ties broken arbitrarily)."""
    ordered = sorted(values, key=lambda kv: -kv[1])
    return {team: place for place, (team, _) in enumerate(ordered, start=1)}


def _dec(value, places=2):
    return Decimal(str(round(value, places)))


# --- refresh ---


def _refresh(deadline):
    """`deadline` is a time.time() after which no new outside-opponent
    schedule scrapes start (see OUTSIDE_SCRAPE_RESERVE_SECONDS)."""
    warnings = []
    tracked = {}
    leagues = []
    for spec in TRACKED_LEAGUES:
        try:
            league_path, slug = find_league_path(spec["seed"])
            if slug != spec["league"]:
                warnings.append(f"seed {spec['seed']} is now in '{slug}', expected '{spec['league']}'")
            members = scrape_league(league_path)
        except Exception as exc:
            warnings.append(f"league {spec['league']}: {exc}")
            continue
        # Written now, not at the end, so our League Standings update even
        # if the long schedule/rating stage below fails.
        if spec.get("standings"):
            _write_standings(members, MAXPREPS + league_path, warnings)
        leagues.append(
            {"league": slug, "name": _league_display_name(slug), "section": spec["section"], "url": MAXPREPS + league_path}
        )
        for member in members:
            tracked.setdefault(member["team_id"], {**member, "league": slug, "section": spec["section"]})

    if not tracked:
        raise RuntimeError("no tracked teams found - every league scrape failed: " + "; ".join(warnings))

    views_by_team = {}
    addresses = {}
    colors = {}
    failures = 0
    for team_id in tracked:
        try:
            views_by_team[team_id], address, colors[team_id] = scrape_schedule(team_id)
            if address and address["street"]:
                addresses[team_id] = address
        except Exception as exc:
            failures += 1
            warnings.append(f"schedule {team_id}: {exc}")
    # Refuse to overwrite a good cache with a mostly-failed scrape.
    if failures > len(tracked) / 2:
        raise RuntimeError(f"{failures}/{len(tracked)} schedule scrapes failed: " + "; ".join(warnings[-5:]))

    # Outside opponents, one level out: their schedules give them real
    # ratings (and so give tracked teams real strength-of-schedule credit)
    # instead of the prior's "assume average". Their own opponents - two
    # levels out - enter the solve too but aren't scraped further. Outside
    # teams are rated, never ranked or returned. A failed outside scrape is
    # only a warning: that team just falls back to being seen from its
    # tracked opponents' schedules, as before.
    connections = {}
    for views in views_by_team.values():
        for v in views:
            if v["opponent_id"] not in tracked:
                connections[v["opponent_id"]] = connections.get(v["opponent_id"], 0) + 1
    outside = sorted(connections, key=lambda t: (-connections[t], t))
    skipped = 0
    for team_id in outside:
        if time.time() > deadline:
            skipped += 1
            continue
        try:
            views_by_team[team_id], _, _ = scrape_schedule(team_id)
        except Exception as exc:
            warnings.append(f"outside schedule {team_id}: {exc}")
    if skipped:
        warnings.append(f"ran short on time - skipped {skipped}/{len(outside)} outside opponents' schedules")

    games = merge_games(views_by_team)
    srs = compute_srs(games)
    locations = resolve_locations(addresses, {t: v["name"] for t, v in tracked.items()}, warnings)

    # Names for untracked opponents (only seen from the other side).
    names = {team_id: t["name"] for team_id, t in tracked.items()}
    for views in views_by_team.values():
        for v in views:
            names.setdefault(v["opponent_id"], v["opponent_name"])

    stats = {t: {"wins": 0, "losses": 0, "margin": 0, "opponents": []} for t in tracked}
    for g in games:
        for us, them, ours, theirs in (
            (g["team_a"], g["team_b"], g["score_a"], g["score_b"]),
            (g["team_b"], g["team_a"], g["score_b"], g["score_a"]),
        ):
            if us in stats:
                s = stats[us]
                s["wins" if ours > theirs else "losses"] += 1
                s["margin"] += _capped(ours - theirs)
                s["opponents"].append(them)

    # Rank only tracked teams - untracked opponents are rated (they still
    # link tracked teams together) but are mostly one- or two-game samples.
    srs_rank = _rank([(t, srs.get(t, 0.0)) for t in tracked])

    teams = []
    for team_id, t in tracked.items():
        s = stats[team_id]
        played = s["wins"] + s["losses"]
        teams.append(
            {
                "team_id": team_id,
                "name": t["name"],
                "league": t["league"],
                "league_name": _league_display_name(t["league"]),
                "section": t["section"],
                # `record` is computed from the games we scraped (what the
                # ratings are based on); the league_*/overall_*/streak
                # fields below are MaxPreps' own league-table numbers, shown
                # as-is in the per-league standings tables.
                "record": f"{s['wins']}-{s['losses']}",
                "league_record": t["league_record"],
                "league_pf": t["league_pf"],
                "league_pa": t["league_pa"],
                "overall_record": t["overall_record"],
                "overall_pf": t["overall_pf"],
                "overall_pa": t["overall_pa"],
                "streak": t["streak"],
                "games": played,
                "avg_margin": _dec(s["margin"] / played if played else 0, 1),
                "sos": _dec(sum(srs.get(o, 0.0) for o in s["opponents"]) / played if played else 0),
                "srs": _dec(srs.get(team_id, 0.0)),
                "srs_rank": srs_rank[team_id],
                "url": f"{MAXPREPS}{team_id}basketball/",
                # address/lat/lng for the School Map tab - absent when the
                # school's address couldn't be scraped or geocoded.
                **locations.get(team_id, {}),
                # color1/color2 (MaxPreps school colors, "#rrggbb") for the
                # standings shield badges - absent when MaxPreps has none.
                **colors.get(team_id, {}),
            }
        )
    teams.sort(key=lambda t: t["srs_rank"])

    item = {
        "cache_id": CACHE_ID,
        "updated_at": int(time.time()),
        "as_of": date.today().isoformat(),
        "settings": {
            "margin_cap": MARGIN_CAP,
            "home_court_points": _dec(HOME_COURT_POINTS, 1),
            "srs_prior_games": _dec(SRS_PRIOR_GAMES, 1),
        },
        "leagues": leagues,
        # Games involving a tracked team (what the page reports), vs. every
        # game in the rating solve, outside opponents' included.
        "game_count": sum(1 for g in games if g["team_a"] in tracked or g["team_b"] in tracked),
        "rated_game_count": len(games),
        "rated_team_count": len({g["team_a"] for g in games} | {g["team_b"] for g in games}),
        "teams": teams,
        "warnings": warnings,
    }
    table.put_item(Item=item)

    # Games go in their own row so the public `current` row stays small;
    # stored compactly (team ids indexed into `team_ids`) to stay well under
    # DynamoDB's 400KB item limit for a full season.
    def games_row(subset):
        team_ids = sorted({g["team_a"] for g in subset} | {g["team_b"] for g in subset})
        idx = {t: i for i, t in enumerate(team_ids)}
        return {
            "cache_id": "games",
            "updated_at": item["updated_at"],
            "team_ids": team_ids,
            "team_names": [names.get(t, t) for t in team_ids],
            # [date, contest_id, kind, team_a idx, team_b idx, score_a, score_b, home idx or -1]
            "games": [
                [
                    g["date"],
                    g["contest_id"],
                    g["kind"],
                    idx[g["team_a"]],
                    idx[g["team_b"]],
                    g["score_a"],
                    g["score_b"],
                    -1 if g["home"] is None else idx[g["home"]],
                ]
                for g in subset
            ],
        }

    row = games_row(games)
    if len(json.dumps(row)) > GAMES_ROW_MAX_BYTES:
        row = games_row([g for g in games if g["team_a"] in tracked or g["team_b"] in tracked])
        row["truncated"] = True
    table.put_item(Item=row)
    return item


def _caller_permissions(event):
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt", {}).get("claims", {})
    email = (claims.get("email") or "").lower()
    if not email:
        return set()
    item = users_table.get_item(Key={"email": email}).get("Item")
    if item is None:
        return set()
    permissions = item.get("permissions")
    if permissions is None:
        return {"Admin"}
    return set(permissions)


def _take_refresh_lock():
    """Atomically claim the refresh lock; False if a live run holds it."""
    now = int(time.time())
    try:
        table.put_item(
            Item={"cache_id": REFRESH_LOCK_ID, "started_at": now},
            ConditionExpression="attribute_not_exists(cache_id) OR started_at < :stale",
            ExpressionAttributeValues={":stale": now - REFRESH_LOCK_STALE_SECONDS},
        )
        return True
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        return False


def _start_async_refresh(event):
    perms = _caller_permissions(event)
    if "Admin" not in perms and REQUIRED_PERMISSION not in perms:
        return _response(403, {"error": "forbidden"})
    if not _take_refresh_lock():
        lock = table.get_item(Key={"cache_id": REFRESH_LOCK_ID}).get("Item") or {}
        return _response(409, {"error": "a refresh is already running", "refresh_started_at": lock.get("started_at")})
    try:
        lambda_client.invoke(
            FunctionName=os.environ["AWS_LAMBDA_FUNCTION_NAME"],
            InvocationType="Event",
            Payload=json.dumps({"source": "admin"}).encode(),
        )
    except Exception as exc:
        table.delete_item(Key={"cache_id": REFRESH_LOCK_ID})
        return _response(502, {"error": f"could not start refresh: {exc}"})
    return _response(202, {"refresh_started_at": int(time.time())})


def handler(event, context):
    # Direct/EventBridge/async-from-POST invoke (no requestContext) =
    # refresh. Let failures raise so they show up as Lambda errors in
    # CloudWatch rather than returning a 200-shaped error nobody reads.
    if "requestContext" not in event:
        remaining = context.get_remaining_time_in_millis() / 1000 if context else 900
        # Hold the lock for the whole run (a scheduled run takes it too, so
        # an admin POST during it is refused rather than overlapping).
        table.put_item(Item={"cache_id": REFRESH_LOCK_ID, "started_at": int(time.time())})
        try:
            item = _refresh(time.time() + remaining - OUTSIDE_SCRAPE_RESERVE_SECONDS)
        finally:
            table.delete_item(Key={"cache_id": REFRESH_LOCK_ID})
        return {
            "teams": len(item["teams"]),
            "games": item["game_count"],
            "rated_games": item["rated_game_count"],
            "rated_teams": item["rated_team_count"],
            "warnings": item["warnings"],
        }

    method = event["requestContext"]["http"]["method"]
    if method == "GET":
        item = table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {"updated_at": None, "teams": []}
        lock = table.get_item(Key={"cache_id": REFRESH_LOCK_ID}).get("Item")
        if lock and lock["started_at"] >= int(time.time()) - REFRESH_LOCK_STALE_SECONDS:
            item["refresh_started_at"] = lock["started_at"]
        return _response(200, item)

    if method == "POST":
        return _start_async_refresh(event)

    return _response(400, {"error": "unsupported request"})
