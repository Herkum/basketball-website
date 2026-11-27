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
from datetime import date, datetime, timedelta
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

# The tracked leagues. `path` is the league's MaxPreps standings page for
# the current season - configuration, updated once a year (the leagueid
# can't be derived, but it never changes mid-season), so finding the
# leagues costs no MaxPreps requests. If a path is for another season (or
# missing), that league falls back to a lookup through its `seed` school's
# standings page - cached for the season - and a warning says to update
# the path. `league` is the slug we expect; a mismatch is reported in
# `warnings` rather than silently tracking the wrong league.
# `standings: True` marks our own league: its table is also written to the
# League Standings cache.
TRACKED_LEAGUES = [
    {
        "league": "marmonte",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/marmonte/?leagueid=2fda6028-d8f2-4f0d-8976-34ff5fb10837",
        "seed": "/ca/newbury-park/newbury-park-panthers/",
        "standings": True,
    },
    {
        "league": "coastal-canyon",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/coastal-canyon/?leagueid=870f4db5-dd65-4b3e-9ab6-e62c6149fec4",
        "seed": "/ca/simi-valley/simi-valley-pioneers/",
    },
    {
        "league": "channel",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/channel/?leagueid=d70ed787-1723-4efe-97b3-e3332ff86d99",
        "seed": "/ca/ventura/ventura-cougars/",
    },
    {
        "league": "citrus-coast",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/citrus-coast/?leagueid=4ffeabb6-00b5-498b-a554-78899f5a9ad5",
        "seed": "/ca/fillmore/fillmore-flashes/",
    },
    {
        "league": "tri-valley",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/tri-valley/?leagueid=d64e1d2c-0762-4473-89f7-9cfed9188547",
        "seed": "/ca/ventura/st-bonaventure-seraphs/",
    },
    {
        "league": "frontier",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/frontier/?leagueid=db644ceb-5f36-4099-a10b-c4e0ecfa29fb",
        "seed": "/ca/santa-barbara/laguna-blanca-owls/",
    },
    {
        "league": "mission",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/mission/?leagueid=eb09aa39-754a-44f2-bc3e-19eebb10655a",
        "seed": "/ca/chatsworth/sierra-canyon-trailblazers/",
    },
    {
        "league": "gold-coast",
        "section": "Southern",
        "path": "/ca/basketball/26-27/league/gold-coast/?leagueid=9fc3ae48-02f6-42ee-933d-d76028952c5e",
        "seed": "/ca/calabasas/viewpoint-patriots/",
    },
    {
        "league": "west-valley",
        "section": "LA City",
        "path": "/ca/basketball/26-27/league/west-valley/?leagueid=bb3f8ff0-e3d4-40e5-b356-56b84dc60b17",
        "seed": "/ca/chatsworth/chatsworth-charter-chancellors/",
    },
    {
        "league": "valley-mission",
        "section": "LA City",
        "path": "/ca/basketball/26-27/league/valley-mission/?leagueid=cdeae5c3-a904-440c-b25b-1eb62de35321",
        "seed": "/ca/canoga-park/canoga-park-hunters/",
    },
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

# Pause before every MaxPreps request - deliberately slow, to keep the load
# on MaxPreps light. With the scrape cache a normal run fetches only a
# handful of pages; a run that has to fetch everything (an empty cache, a
# {"full": true} invoke) is bounded by the deadline below - outside
# opponents' schedules it can't reach in time fall back to their cached
# copies and are picked up on later runs.
FETCH_DELAY_SECONDS = 5

# Scrape cache - MaxPreps is only re-fetched when something can have
# changed (see _schedule_due/_league_due). A finished game's score never
# changes, so each team's parsed schedule lives in its own "sched#<team>"
# row and a league's table in a "league#<slug>" row:
#   - a schedule is re-fetched once a listed game's score should be in
#     (SCORES_IN_BY_HOUR the morning after the game) but isn't on the
#     cached copy, for up to PENDING_SCORE_DAYS - scores are often entered
#     a day or two late - which also picks up moved/added games; a
#     schedule with no upcoming games left is re-checked weekly (games
#     added after a team's last known one, e.g. playoffs) - until its
#     season is over (didn't make the playoffs, or lost in them; see
#     _season_over), after which it's never fetched again;
#   - a league table is re-fetched when one of its teams has a new result,
#     or weekly;
#   - once a score is overdue, the page is re-tried at most every
#     LATE_SCORE_RETRY_SECONDS;
#   - an admin-started ("manual") refresh treats any game dated today or
#     earlier as due - so a score entered tonight shows up tonight - but
#     never re-fetches a page fetched in the last MANUAL_MIN_SECONDS;
#   - league locations are configuration (TRACKED_LEAGUES `path`), and
#     addresses/colors ride along on the schedule row (static).
# A direct invoke with {"full": true} ignores all of it.
SCHEDULE_RECHECK_DAYS = 7
LEAGUE_RECHECK_DAYS = 7
PENDING_SCORE_DAYS = 5
LATE_SCORE_RETRY_SECONDS = 6 * 3600
MANUAL_MIN_SECONDS = 10 * 60
# Games are dated in local (Pacific) time; some run past 10pm and scores
# are entered after that, so a game's score is only expected by this hour
# (Pacific) the next morning. The daily refresh runs just after it.
SCORES_IN_BY_HOUR = 9
PACIFIC_OFFSET_HOURS = -8
# Days (Pacific, ISO) with no games anywhere - holidays. The daily
# scheduled refresh the morning after one has no new scores to find, so it
# skips; anything it would have re-checked (weekly rechecks, overdue
# scores) just waits a day. Admin and CLI refreshes still run.
NO_GAME_DATES = {"2026-11-26", "2026-12-24", "2026-12-25"}

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


_fetch_count = 0


def _fetch(path):
    global _fetch_count
    _fetch_count += 1
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


def _now_pacific():
    return datetime.utcnow() + timedelta(hours=PACIFIC_OFFSET_HOURS)


def _season_label(today):
    """MaxPreps' season slug, e.g. "26-27" - seasons run Nov-Mar, so July
    onward is the season starting that year."""
    y = today.year % 100
    return f"{y:02d}-{(y + 1) % 100:02d}" if today.month >= 7 else f"{(y - 1) % 100:02d}-{y:02d}"


def _load_caches():
    """Every scrape-cache row ("league_paths", "league#*", "sched#*"),
    keyed by cache_id - one scan of this small table."""
    caches, kwargs = {}, {}
    while True:
        resp = table.scan(**kwargs)
        for it in resp["Items"]:
            cid = it["cache_id"]
            if cid == "league_paths" or cid.startswith(("league#", "sched#")):
                caches[cid] = it
        if "LastEvaluatedKey" not in resp:
            return caches
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def _cached_schedule(cache):
    """A "sched#" row back to scrape_schedule's shape (DynamoDB hands
    numbers back as Decimal)."""
    views = [
        {**v, "points_for": int(v["points_for"]), "points_against": int(v["points_against"]), "away": bool(v["away"])}
        for v in cache.get("views", [])
    ]
    return views, cache.get("address"), dict(cache.get("colors") or {}), list(cache.get("scheduled", []))


def _save_schedule(team_id, views, address, colors, scheduled):
    table.put_item(
        Item={
            "cache_id": f"sched#{team_id}",
            "fetched_on": _now_pacific().date().isoformat(),
            "fetched_at": int(time.time()),
            "views": views,
            "address": address,
            "colors": colors,
            "scheduled": scheduled,
        }
    )


def _playoff_start(caches):
    """The earliest playoff date (MaxPreps' "**" games) on any cached
    schedule - None until the playoffs begin."""
    dates = [
        c["date"]
        for cid, cache in caches.items()
        if cid.startswith("sched#")
        for c in list(cache.get("scheduled", [])) + list(cache.get("views", []))
        if c.get("kind") == "playoff"
    ]
    return date.fromisoformat(min(dates)) if dates else None


def _season_over(cache, playoff_start):
    """Once the playoffs have begun, a team with nothing left to play is
    done for the season - never fetched again - when either:
      - its last game was a regular-season game and its page has been
        fetched since the playoffs began (so a newly added first playoff
        game would have shown up): it didn't make the playoffs; or
      - its last game was a playoff loss and its page has been re-checked
        at least SCHEDULE_RECHECK_DAYS after it - one more look because CIF
        State regionals take some section-playoff losers (runners-up),
        whose state game gets added a few days after the section ends."""
    if not playoff_start:
        return False
    fetched_on = date.fromisoformat(cache["fetched_on"])
    views = sorted(cache.get("views", []), key=lambda v: v["date"])
    if not views or views[-1].get("kind") != "playoff":
        return fetched_on > playoff_start
    last = views[-1]
    lost = int(last["points_for"]) < int(last["points_against"])
    return lost and (fetched_on - date.fromisoformat(last["date"])).days >= SCHEDULE_RECHECK_DAYS


def _schedule_due(cache, now, full, manual=False, playoff_start=None):
    """Whether a team's schedule page needs fetching again (see the scrape
    cache notes at the top). `now` is naive Pacific time."""
    if full or not cache:
        return True
    today = now.date()
    # Games added after a team's last known game (CIF playoffs, a late
    # tournament) are invisible until something re-fetches the page. A team
    # with upcoming games gets re-fetched anyway as each one finishes, so
    # only a schedule with nothing left to play is re-checked weekly.
    if (today - date.fromisoformat(cache["fetched_on"])).days >= SCHEDULE_RECHECK_DAYS:
        has_upcoming = any(date.fromisoformat(c["date"]) >= today for c in cache.get("scheduled", []))
        if not has_upcoming and not _season_over(cache, playoff_start):
            return True
    fetched_at = int(cache.get("fetched_at", 0))
    fetched = datetime.utcfromtimestamp(fetched_at) + timedelta(hours=PACIFIC_OFFSET_HOURS)
    since_fetch = time.time() - fetched_at
    done = {v["contest_id"] for v in cache.get("views", [])}
    for c in cache.get("scheduled", []):
        if c["contest_id"] in done:
            continue
        d = date.fromisoformat(c["date"])
        if (today - d).days > PENDING_SCORE_DAYS or d > today:
            continue
        if manual:
            if since_fetch >= MANUAL_MIN_SECONDS:
                return True
            continue
        scores_due = datetime(d.year, d.month, d.day) + timedelta(days=1, hours=SCORES_IN_BY_HOUR)
        if now < scores_due:
            continue
        # Not fetched since the score became due, or still missing and the
        # last try is old enough to try again.
        if fetched < scores_due or since_fetch >= LATE_SCORE_RETRY_SECONDS:
            return True
    return False


def _save_league(slug, path, members):
    table.put_item(
        Item={
            "cache_id": f"league#{slug}",
            "path": path,
            "fetched_on": _now_pacific().date().isoformat(),
            "fetched_at": int(time.time()),
            "members": members,
        }
    )


def _league_due(cache, league_path, member_ids, teams_with_new_games, today, full):
    if full or not cache or cache.get("path") != league_path:
        return True
    if (today - date.fromisoformat(cache["fetched_on"])).days >= LEAGUE_RECHECK_DAYS:
        return True
    return any(t in teams_with_new_games for t in member_ids)


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
    (the month and day aren't zero-padded - "12-1-2026", "1-5-2027" - and
    the opponent link uses its own state, e.g. "/az/gilbert/...", for an
    out-of-state game; both have to match or the game is silently dropped)
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
    # Every listed contest, played or not - the scrape cache uses the dates
    # to know when this schedule next needs re-checking.
    scheduled = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        contest = re.search(r"/(\d{1,2})-(\d{1,2})-(\d{4})/\?c=([a-f0-9-]+)", row_html)
        if contest:
            cm, cd, cy, cid = contest.groups()
            listed_name = re.search(r'class="name">([^<]*)</span>', row_html)
            listed_stars = len(listed_name.group(1)) - len(listed_name.group(1).rstrip("*")) if listed_name else 0
            scheduled.append(
                {
                    "date": f"{cy}-{int(cm):02d}-{int(cd):02d}",
                    "contest_id": cid,
                    "kind": {1: "league", 2: "playoff", 3: "tournament"}.get(listed_stars, "nonleague"),
                }
            )
        result = re.search(r'class="result ([WL])">[WL]</span>\s*<span class="score">(\d+)-(\d+)', row_html)
        opponent = re.search(
            r'href="(/[a-z]{2}/[a-z0-9-]+/[a-z0-9-]+/)basketball/"><span class="hat">([^<]*)</span>.*?class="name">([^<]*)</span>',
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
                "date": f"{year}-{int(month):02d}-{int(day):02d}",
                "opponent_id": opponent.group(1),
                "opponent_name": name.rstrip("*").strip(),
                "away": opponent.group(2).strip() == "@",
                "kind": {1: "league", 2: "playoff", 3: "tournament"}.get(stars, "nonleague"),
                "points_for": high if outcome == "W" else low,
                "points_against": low if outcome == "W" else high,
            }
        )
    # A contest can appear in more than one row (e.g. a tournament block).
    scheduled = list({c["contest_id"]: c for c in scheduled}.values())
    return games, address, colors, scheduled


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


def _refresh(deadline, full=False, manual=False):
    """`deadline` is a time.time() after which no new outside-opponent
    schedule scrapes start (see OUTSIDE_SCRAPE_RESERVE_SECONDS). `full`
    ignores the scrape cache and re-fetches everything; `manual` (an
    admin-started refresh) checks every game dated today or earlier."""
    global _fetch_count
    _fetch_count = 0
    now = _now_pacific()
    today = now.date()
    warnings = []
    caches = _load_caches()
    playoff_start = _playoff_start(caches)

    # League locations: the configured `path` when it's for this season;
    # otherwise one seed-school lookup, cached for the season, plus a
    # warning to update the path.
    season = _season_label(today)
    paths_row = caches.get("league_paths") or {}
    paths = dict(paths_row.get("paths") or {}) if paths_row.get("season") == season and not full else {}
    paths_changed = False
    league_specs = []
    for spec in TRACKED_LEAGUES:
        configured = spec.get("path") or ""
        if f"/{season}/league/" in configured:
            league_specs.append((spec, configured, spec["league"]))
            continue
        warnings.append(f"league {spec['league']}: no configured path for {season} - looked up via its seed school; update TRACKED_LEAGUES")
        hit = paths.get(spec["seed"])
        if not hit:
            try:
                league_path, slug = find_league_path(spec["seed"])
            except Exception as exc:
                warnings.append(f"league {spec['league']}: {exc}")
                continue
            hit = {"path": league_path, "slug": slug}
            paths[spec["seed"]] = hit
            paths_changed = True
        if hit["slug"] != spec["league"]:
            warnings.append(f"seed {spec['seed']} is now in '{hit['slug']}', expected '{spec['league']}'")
        league_specs.append((spec, hit["path"], hit["slug"]))
    if paths_changed:
        table.put_item(Item={"cache_id": "league_paths", "season": season, "updated_at": int(time.time()), "paths": paths})

    # League membership + MaxPreps' table numbers: from cache when we have
    # it (re-fetched below if a member has a new result).
    league_members = {}
    leagues_fetched = set()
    for spec, league_path, slug in league_specs:
        cache = caches.get(f"league#{slug}")
        # Only trust a cached table that came from this league's current
        # page (a corrected leagueid or a new season's path means refetch).
        if cache and not full and cache.get("path") == league_path:
            league_members[slug] = [dict(m) for m in cache.get("members", [])]
            continue
        try:
            league_members[slug] = scrape_league(league_path)
        except Exception as exc:
            warnings.append(f"league {spec['league']}: {exc}")
            continue
        _save_league(slug, league_path, league_members[slug])
        leagues_fetched.add(slug)

    tracked = {}
    leagues = []
    for spec, league_path, slug in league_specs:
        if slug not in league_members:
            continue
        leagues.append(
            {"league": slug, "name": _league_display_name(slug), "section": spec["section"], "url": MAXPREPS + league_path}
        )
        for member in league_members[slug]:
            tracked.setdefault(member["team_id"], {**member, "league": slug, "section": spec["section"]})

    if not tracked:
        raise RuntimeError("no tracked teams found - every league scrape failed: " + "; ".join(warnings))

    # Tracked teams' schedules, re-fetched only when due. A failed fetch
    # falls back to the cached copy.
    def fetch_schedule(team_id, cache):
        """Fetches and caches a schedule. Raises on a failed fetch, and
        treats an empty page as one when the cache had contests (an error
        or consent page, or a markup change) - so it's never saved over
        good data and frozen there until the weekly recheck."""
        views, address, colors_, scheduled = scrape_schedule(team_id)
        if not scheduled and cache and cache.get("scheduled"):
            raise ValueError("schedule page came back with no games - kept the cached copy")
        _save_schedule(team_id, views, address, colors_, scheduled)
        return views, address, colors_

    def load_schedule(team_id):
        """(views, address, colors, fetched?, has_new_games?, failed?)."""
        cache = caches.get(f"sched#{team_id}")
        if not _schedule_due(cache, now, full, manual, playoff_start):
            views, address, colors_, _ = _cached_schedule(cache)
            return views, address, colors_, False, False, False
        try:
            views, address, colors_ = fetch_schedule(team_id, cache)
        except Exception as exc:
            if not cache:
                raise
            warnings.append(f"schedule {team_id}: {exc} - using the cached copy")
            views, address, colors_, _ = _cached_schedule(cache)
            return views, address, colors_, False, False, True
        old = {v["contest_id"] for v in (cache or {}).get("views", [])}
        return views, address, colors_, True, any(v["contest_id"] not in old for v in views), False

    views_by_team = {}
    addresses = {}
    colors = {}
    teams_with_new_games = set()
    stats_fetched = stats_cached = failures = 0
    for team_id in tracked:
        try:
            views, address, colors[team_id], fetched, new_games, failed = load_schedule(team_id)
        except Exception as exc:
            failures += 1
            warnings.append(f"schedule {team_id}: {exc}")
            continue
        # A fallback to the cached copy still counts toward the
        # mostly-failed check below (e.g. MaxPreps blocking us).
        failures += failed
        views_by_team[team_id] = views
        if address and address.get("street"):
            addresses[team_id] = address
        stats_fetched += fetched
        stats_cached += not fetched
        if new_games:
            teams_with_new_games.add(team_id)
    # Refuse to overwrite a good cache with a mostly-failed scrape.
    if failures > len(tracked) / 2:
        raise RuntimeError(f"{failures}/{len(tracked)} schedule scrapes failed: " + "; ".join(warnings[-5:]))

    # Cached league tables are re-fetched only when a member has a new
    # result (or weekly), refreshing MaxPreps' own table numbers.
    for spec, league_path, slug in league_specs:
        if slug in leagues_fetched or slug not in league_members:
            continue
        member_ids = [m["team_id"] for m in league_members[slug]]
        if not _league_due(caches.get(f"league#{slug}"), league_path, member_ids, teams_with_new_games, today, full):
            continue
        try:
            members = scrape_league(league_path)
        except Exception as exc:
            warnings.append(f"league {spec['league']}: {exc}")
            continue
        _save_league(slug, league_path, members)
        leagues_fetched.add(slug)
        league_members[slug] = members
        for member in members:
            if member["team_id"] in tracked:
                tracked[member["team_id"]].update(member)

    # Our League Standings follow our league's table - rewritten only when
    # it was actually re-fetched this run.
    for spec, league_path, slug in league_specs:
        if spec.get("standings") and slug in leagues_fetched:
            _write_standings(league_members[slug], MAXPREPS + league_path, warnings)

    # Outside opponents, one level out: their schedules give them real
    # ratings (and so give tracked teams real strength-of-schedule credit)
    # instead of the prior's "assume average". Their own opponents - two
    # levels out - enter the solve too but aren't scraped further. Outside
    # teams are rated, never ranked or returned. Same cache rules; a failed
    # or skipped fetch falls back to the cached copy, else that team is
    # just seen from its tracked opponents' schedules.
    connections = {}
    for views in views_by_team.values():
        for v in views:
            if v["opponent_id"] not in tracked:
                connections[v["opponent_id"]] = connections.get(v["opponent_id"], 0) + 1
    outside = sorted(connections, key=lambda t: (-connections[t], t))
    skipped = 0
    for team_id in outside:
        cache = caches.get(f"sched#{team_id}")
        if not _schedule_due(cache, now, full, manual, playoff_start):
            views_by_team[team_id] = _cached_schedule(cache)[0]
            stats_cached += 1
            continue
        if time.time() > deadline:
            skipped += 1
            if cache:
                views_by_team[team_id] = _cached_schedule(cache)[0]
            continue
        try:
            views = fetch_schedule(team_id, cache)[0]
        except Exception as exc:
            warnings.append(f"outside schedule {team_id}: {exc}")
            if cache:
                views_by_team[team_id] = _cached_schedule(cache)[0]
            continue
        views_by_team[team_id] = views
        stats_fetched += 1
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
    # Teams with no games yet sit at the prior's exact 0.0, so ranking them
    # would take numbers mid-table that the public page (which lists them
    # last, unranked) then skips - rank them after every team that's played.
    played_ids = [t for t in tracked if stats[t]["wins"] + stats[t]["losses"]]
    srs_rank = _rank([(t, srs.get(t, 0.0)) for t in played_ids])
    unplayed_ids = sorted((t for t in tracked if t not in srs_rank), key=lambda t: tracked[t]["name"])
    for i, t in enumerate(unplayed_ids):
        srs_rank[t] = len(played_ids) + i + 1

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
        # How much MaxPreps this run actually touched (see the scrape cache).
        "scrape_stats": {
            "full": full,
            "manual": manual,
            "pages_fetched": _fetch_count,
            "schedules_fetched": stats_fetched,
            "schedules_from_cache": stats_cached,
            "leagues_fetched": len(leagues_fetched),
            "playoff_start": playoff_start.isoformat() if playoff_start else None,
        },
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
        # The EventBridge rule passes its own scheduled event (source
        # "aws.events") as the payload.
        yesterday = (_now_pacific() - timedelta(days=1)).date().isoformat()
        if event.get("source") == "aws.events" and yesterday in NO_GAME_DATES:
            print(f"skipped: no games were played {yesterday}")
            return {"skipped": True, "reason": f"no games were played {yesterday}"}
        # Hold the lock for the whole run, so runs never overlap. The
        # admin's POST already took it and then invoked us with
        # source=admin; any other run (the schedule, a CLI invoke - or a
        # CLI retry of one) must take it itself and skips if a refresh is
        # already running, rather than scraping the same pages twice.
        if event.get("source") != "admin" and not _take_refresh_lock():
            lock = table.get_item(Key={"cache_id": REFRESH_LOCK_ID}).get("Item") or {}
            print(f"skipped: a refresh is already running (started_at={lock.get('started_at')})")
            return {"skipped": True, "reason": "a refresh is already running", "refresh_started_at": lock.get("started_at")}
        try:
            # {"full": true} (a manual invoke) ignores the scrape cache.
            item = _refresh(
                time.time() + remaining - OUTSIDE_SCRAPE_RESERVE_SECONDS,
                full=bool(event.get("full")),
                # POST /rankings (the admin's button) passes source=admin.
                manual=event.get("source") == "admin",
            )
        finally:
            table.delete_item(Key={"cache_id": REFRESH_LOCK_ID})
        return {
            "scrape_stats": item["scrape_stats"],
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
