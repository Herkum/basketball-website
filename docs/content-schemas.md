# Content schemas

One DynamoDB table per resource. Drag-reorderable lists carry `order`
(integer; the Lambda sorts GET-list results by it and defaults it to a
timestamp on create so new items land last; reordering rewrites it 0-based
— and every edit must echo it back, see gotchas). Fixed `<select>` value
lists live as constants in `admin/app.js`.

- **`Rosters`** (PK `team_id`): `name`, `description` (shown on the team's
  `roster.html`), `image` (cropped), `coach_ids` (many-to-many with Coaches,
  joined client-side), `order`.
- **`Players`** (PK `team_id`, SK `player_id`): `first_name`, `last_name`,
  `number`, `height`, `year` (`PLAYER_YEARS`: Freshman/Sophomore/Junior/
  Senior), `profile`, `image` (cropped). Admin: Rosters → a team's Players
  button. No `order`.
- **`Schedule`** (PK `season` e.g. `2026-2027`, SK `game_id`): `date`, `time`
  (free text — "TBA" is common), `team_id` (a roster), `opponent`,
  `home_away` (`Home`/`Away`/`Neutral`; `matchupPrefix()` in `shared.js`
  renders Away as "at Opponent", Home/Neutral as "vs Opponent"),
  `location_id` (a `Locations` row), `location`/`address` (a copy of that
  row's name/address written at save time), `is_league` (checkbox; nothing
  on the public site reads it today), `our_score`, `opponent_score`.
  - The location fields only appear in the admin form for Away/Neutral
    games (`visibleIf`); Home is always our gym. They're hidden, not
    cleared, so a Home game keeps any stored address. No free-text venue —
    add a `Locations` row first.
  - `location_id` is the source of truth: the admin list
    (`gameLocationText`/`gameAddressText`) and the public pages
    (`gameLocation()` on Schedule, `gameAddress()` on Home) resolve it
    against a live `/locations` fetch, falling back to the stored copy only
    when there's no match. So renaming a Location updates every linked
    game with no re-save. The address only needs to be something Google
    Maps can search (`mapsUrl()`); there's no geocoding.
  - Admin (`renderScheduleSection`, bespoke): loads `defaultSeason()`,
    team filter, sortable List view (no reorder — games sort by date) and
    a Calendar view (`paintCalendar`; click a day or chip to add/edit) that
    re-centers on the earliest game when a season is loaded.
- **`News`** (PK `post_id`): `title`, `body` (simple HTML allowed — a link,
  bold; rendered as markup by `newsBodyNode()` with typed line breaks kept,
  tag-stripped by `newsPlainText()` on carousel cards; the admin's Story
  field has the Write/Preview toggle), `is_event` (an upcoming item
  like a clinic, vs. a report on something now), `published_date`,
  `end_date`, `image` (cropped). Date rules, checked on Save by
  `newsMeta().validate`: plain News can't be future-dated, an Event must
  be (strictly after today), and `end_date` must be after
  `published_date`. Public visibility (`isNewsActive()`): News shows while
  `published_date <= today <= end_date`; an Event skips the
  published-date check and shows until `end_date`. Events sort
  nearest-first, News newest-first (`news.html` has separate sections;
  Home concatenates events then news). No `order`.
- **`ContentBlocks`** (PK `block_id`): `title`, `body`, `image` (cropped),
  `special` (admin-only search-engine NoIndex hint; doesn't affect the
  nav), `generator` (`CONTENT_BLOCK_GENERATORS`: none, Coaches, Rosters,
  Schedule, News, Contact Us, Sponsors, Photos, Standings, Regional
  Leagues, Logo, Mission Statement, Store, Sponsorships, Donate, Games
  Online — which page the block drives; see "Content Blocks → pages" in
  architecture.md), `league_name` (form shows it only for the Logo
  generator), `order`. Body is an `html: true` field (Write/Preview
  toggle), like News's Story.
- **`Coaches`** (PK `coach_id`): `name`, `title`, `email` (a `mailto:` link
  publicly), `profile`, `image` (cropped), `order`.
- **`Contacts`** (PK `contact_id`): `kind` (`CONTACT_KINDS`: Program/
  School/Boosters/Social — the card's eyebrow), `label` (e.g. "General
  Info"), `role` (e.g. "Head Coach, Varsity"; shown under the label),
  `type` (`CONTACT_TYPES`: Email/Physical Address/Instagram/Phone/Website),
  `value` (the email, address, @handle, number, or URL), `order`.
  `contactValueNode()` in `site.js` switches on `type` to render `value`
  (Phone → `tel:` with only `+`/digits; Website → link, `https://` added
  if missing), so a new type needs both the constant and that function.
  The Contact page (`initContactPage`) lifts the `Physical Address`
  contact into a "gym" block (address lines, Directions button, and a
  decorative `.gym-photo-placeholder` — Contacts have no image) and shows
  the rest as `.contact-card`s.
- **`Sponsors`** (PK `sponsor_id`): `name`, `kind` (business category,
  e.g. "Orthodontics · Thousand Oaks"), `website`, `tier`
  (`SPONSOR_TIERS`: Banner/Court/Friend of the Program — `sponsors.html`
  groups by tier in that order), `order`. Home shows one at random as the
  Sponsor Spotlight.
- **`Albums`** (PK `album_id`): `title`, `date_label` (free text, e.g.
  "Dec 20–22"), `description`, `order`, `linked` (optional `{ref, label}`:
  `ref` is `news:<post_id>` or `schedule:<season>:<game_id>`, `label` is
  cached display text). The admin's "Link to News/Event or Game" field is
  a `<datalist>` autocomplete (`buildLinkSearchField`/`albumLinkOptions`)
  over `/news` plus the current season's games. The public site reads
  only `news:` links (the article photo carousel). Admin: Photos tab →
  an album's Photos button.
- **`Photos`** (PK `album_id`, SK `photo_id`): `image` (uploaded uncropped —
  `raw: true`), `caption`, `order`. `photos.html` shows one section per
  album.
- **`Locations`** (PK `location_id`): `name`, `address`, `order`. Season →
  Locations in the admin, gated on `Edit Season`. Picked by Schedule's
  Away/Neutral games; the public Schedule and Home resolve games'
  `location_id` against `/locations`.
- **`Standings`** (PK `cache_id` = `"current"`, a singleton): `source_url`
  (MaxPreps league page, editable in the admin so a new season needs no
  redeploy), `updated_at`, `rows` (`rank`, `school`, `league_record`/
  `_pct`/`_pf`/`_pa`, `overall_record`/`_pct`/`_pf`/`_pa`, `streak`, `link`
  — `link` is admin-set, never scraped). `standings/handler.py` is a
  screen-scraper: `GET` (public) serves the cache, never scraping live;
  `POST` (JWT, the admin's "Refresh from source") fetches `source_url`,
  regex-parses the server-rendered table (markup shape in the docstring),
  and overwrites the cache, carrying each school's `link` forward by
  case-insensitive name match; `PUT` (JWT, the admin's Add/Edit/Delete
  school dialogs) saves `rows` as given — a later refresh still
  overwrites everything but `link`. A fetch/parse error returns 502, but
  a markup change that parses as zero rows won't — inherent to scraping.
  An invoke with no `requestContext` refreshes from the saved
  `source_url`; no schedule triggers it today.
- **`Rankings`** (PK `cache_id`, four singleton rows): regional SRS ratings
  across `TRACKED_LEAGUES` in `rankings/handler.py` (Marmonte, Coastal
  Canyon, Channel, Citrus Coast, Tri-Valley, Frontier, Mission, Gold
  Coast, West Valley, Valley Mission).
  - **`"current"`**: `teams` (tracked teams only — `name`, `league`,
    `section`, `record`, `games`, `avg_margin`, `sos`, `srs`/`srs_rank`,
    `url`, MaxPreps' own `league_*`/`overall_*`/`streak` table numbers,
    `address`/`lat`/`lng`, `color1`/`color2`), `leagues`, `settings`,
    `game_count` (games involving a tracked team), `rated_game_count`/
    `rated_team_count` (everything in the solve), `updated_at`,
    `warnings`. `record` is computed from the scraped games, so it can
    differ slightly from MaxPreps' `overall_record`.
  - **`"games"`**: every scraped game, compact list-of-lists, for debugging;
    trimmed to tracked teams' games (`truncated`) near DynamoDB's 400KB
    limit.
  - **`"geo"`**: Nominatim geocode cache (`team_id` → `{address, lat, lng}`),
    re-geocoded only when a school's scraped address changes (Nominatim
    policy: ≤1 req/s, identifying User-Agent, cache results). The address
    is the first schema.org `PostalAddress` on the team's MaxPreps schedule
    page; `geocode()` tries the street, a simplified street, "<name>
    School, city", then the ZIP centroid. Unplaceable schools are left off
    the map and noted in `warnings`.
  - **`"refresh"`**: the refresh lock (`started_at`), below.
  - **Leagues** are found via one seed school each, not a hardcoded league
    URL, so a new season needs no code change; a seed that moves to another
    league is reported in `warnings`.
  - **SRS**: least-squares, each margin capped at 15, home court fixed at
    3 pts (none for neutral games — tournaments, or both schedules
    disagreeing on home/away), plus one phantom 0-margin game per team as
    a ridge prior so early ratings stay finite. Solved over the whole
    season, so beating a team that later improves keeps gaining credit.
    Solved by conjugate gradient (`_solve_srs_system`) — no numpy in the
    runtime, and dense elimination doesn't scale to the high hundreds of
    teams. Outside opponents' schedules are scraped one level out (most-
    connected first) so they're rated from real results; their opponents
    enter the solve unscraped. New outside scrapes stop 2 min before the
    900s timeout (noted in `warnings`); a refresh where over half the
    schedule scrapes fail raises rather than overwrite the cache.
  - **Refresh**: `GET /rankings` (public) serves the cache plus
    `refresh_started_at` while a run is live. Refreshes come from the daily
    EventBridge rule (`cron(0 12 * * ? *)`), `aws lambda invoke
    --function-name basketball-website-rankings --payload '{}' out.json`,
    or the admin's "Refresh rankings" button (League Standings tab). A
    scrape takes minutes — past API Gateway's 30s — so `POST /rankings`
    (JWT, `Edit Season`) re-invokes the Lambda asynchronously and returns
    202. Every refresh holds the `"refresh"` lock (conditional put,
    cleared in a `finally`, stale after 16 min), so a second POST gets 409;
    the admin polls until it clears. Async retries are off
    (`maximum_retry_attempts = 0`) so a failure doesn't re-scrape twice.
- **`AdminAllowlist`** (PK `email`; admin Administration → Users,
  `usersMeta()`/`users` Lambda): `first_name`, `last_name`, `permissions`
  (any of `Admin`/`Edit Season`/`Edit Rosters`/`Edit Contacts`/`Edit
  Content`; `Admin` implies all). Having a row is what lets someone sign in
  (`post_auth_allowlist`). A row with **no** `permissions` attribute
  (bootstrap rows, or pre-permissions) counts as `Admin` so existing admins
  weren't locked out; an explicit empty list means none. Every write
  endpoint checks the caller's row via `_caller_permissions()` (duplicated
  per handler — see "Not yet done" in CLAUDE.md) for its section's
  permission or `Admin`. `/users` is JWT-only and `Admin`-only, except a
  user may read their own row (the admin UI needs it at login). The
  Lambda refuses to remove the last `Admin`. Bootstrap with
  `scripts/seed_allowlist.py add|remove|list <email>` (repo `.venv`;
  `pip install boto3` if missing).

## Scripts

The one-off seed/backfill scripts that first populated these tables are
gone — DynamoDB is the record now, and most weren't safe to re-run.
`scripts/seed_allowlist.py` is the only script left (see `AdminAllowlist`).
