# Content schemas

- `Rosters` (PK `team_id`): `name`, `description` (free-text textarea, a
  short paragraph about the team, rendered on that team's `roster.html`
  page), `image` (CloudFront URL, cropped the same way as coach photos),
  `coach_ids` (list of coach IDs — many-to-many with Coaches, displayed by
  cross-referencing on the client since DynamoDB has no joins), `order`
  (drag-to-reorder, same pattern as Coaches)
- `Players` (PK `team_id`, SK `player_id`): `first_name`, `last_name`,
  `number`, `height`, `year` (one of `Freshman`/`Sophomore`/`Junior`/`Senior`
  — see `PLAYER_YEARS` in `app.js`), `profile`, `image` (cropped the same
  way as coach/team photos). Listed via the Rosters tab's "Players" button
  for a given team, not its own top-level tab.
- `Schedule` (PK `season`, SK `game_id`): `date`, `time` (free text, not
  `type="time"` — schedules routinely say "TBA"), `opponent`, `home_away`,
  `location` (free text, human-readable venue name/description, e.g. "Oaks
  Christian HS" — this is the text shown to the public, not itself
  resolvable by Maps), `address` (free text street address; used to build
  the Google Maps search link — `mapsUrl()`/
  `https://www.google.com/maps/search/?api=1&query=...` — no geocoding, so
  it only needs to be something Maps can resolve, not precise lat/long;
  the public schedule links `location` as the display text with `address`
  as the href, falling back to plain text if `address` is blank).
  `location`/`address` only appear in the admin's edit dialog for Away
  games (Home is always the same gym, so re-entering it every time would
  be pointless data entry) — both fields carry `visibleIf: (f) =>
  f.home_away === "Away"` in the field metadata (`renderScheduleSection`'s
  `fields()` in `app.js`), but their stored values are hidden, not
  cleared, so a Home game's already-backfilled `address` is preserved
  across edits. `team_id` (which roster this game belongs to, a `<select>`
  populated from `/rosters`), `is_league` (boolean checkbox, "League Game"
  — not every opponent counts against the league record shown in the
  public sidebar's record box; tournaments and non-league games leave
  this unchecked), `our_score`, `opponent_score`.
  `renderScheduleSection` in `app.js` is bespoke, not on the generic list
  engine (see "Admin UI" in architecture.md) — it needs a Season load
  control, a team-filter, and a List/Calendar toggle that both views
  share. Defaults to `defaultSeason()` on load instead of a blank
  type-a-season-and-click-Load screen. The List view is a sortable table
  (client-side sort, no drag-reorder — games have no `order` field, they
  sort by date); the Calendar view (`paintCalendar` in `app.js`) shows a
  month grid — each game is a clickable chip on its date, and clicking a
  day or a chip opens the same shared Create/Edit dialog used everywhere
  else. `calYear`/`calMonth` re-center on the filtered set's earliest game
  whenever a new season is loaded via the Season/Load control.
- `News` (PK `post_id`): `title`, `body` (textarea), `is_event` (boolean
  checkbox, "Event" — an upcoming item like a clinic or meeting, meant to
  be visible as soon as it's announced, vs. ordinary News which reports on
  something already happening/announced now), `published_date`, `end_date`
  — both are `<input type="date">`. The two types take **opposite**
  constraints on `published_date`: plain News can't be in the future (it's
  retrospective/immediate — `max` = today, no `min`), an Event must be in
  the future (`min` = tomorrow, no `max`) — `updatePublishedConstraints()`
  in `app.js` swaps the attribute pair when the Event checkbox changes.
  `end_date` must always be strictly after whatever `published_date`
  currently holds regardless of type (its `min` attribute updates live
  when `published_date` changes). Enforced both via the native HTML
  `min`/`max` attributes and a JS check on submit as a fallback. `image`
  (cropped the same way as every other photo field). Custom
  `renderNewsSection` in `app.js` — the cross-field date logic and image
  cropper don't fit a generic builder. Public-site visibility
  (`isNewsActive()` in `site.js`, used by `news.html` and the Home page's
  News feed) differs by type: plain News needs `published_date <= today <=
  end_date`; an Event skips the `published_date` gate entirely and shows
  until `end_date` passes, so an Event is visible immediately even though
  its `published_date` is necessarily still in the future. Sort order also
  differs and is intentionally opposite: Events sort nearest-date-first
  (what's coming up soonest matters most), News sorts newest-first — see
  `initNewsPage`'s separate "Upcoming Events"/"News" sections and Home's
  combined feed (`activeEvents` ascending, `activeArticles` descending,
  concatenated so the nearest event or else the latest news leads).
- `ContentBlocks` (PK `block_id`): `title`, `body` (textarea), `image`
  (cropped photo), `special` (boolean checkbox — flags a block as excluded
  from the public site's sidebar nav, see "Content Blocks → page mapping"
  above), `generator` (dropdown: None/Coaches/Rosters/Schedule/News/Contact
  Us/Sponsors/Photos/Standings/Logo/Mission Statement — which dedicated public page this
  block drives, see same section; "Logo" doesn't drive a page, it's the
  sidebar's brand block, see "Sidebar brand/record/footer" above),
  `league_name` (free text, admin form shows this field only when
  Generator is "Logo" — the league name shown in the sidebar footer and
  atop the Home page's standings teaser),
  `order` (drag-to-reorder, same pattern as Coaches). Uses the generic
  `contentBlocksMeta()`/`renderGenericSection()` engine (see "Admin UI" in
  architecture.md) — its Body field is the one place `html: true` triggers
  the Write/Preview tab toggle, and `league_name` is the one field using
  `visibleIf` (shown only when Generator is "Logo").
- `Coaches` (PK `coach_id`): `name`, `title`, `email` (rendered as a
  `mailto:` link on the public Coaches page), `profile`, `image` (a
  CloudFront URL to the cropped photo in S3), `order` (integer,
  drag-to-reorder in the admin UI; the `coaches` Lambda sorts GET-list
  results by this field, and defaults it to a timestamp on create so new
  coaches land at the end; reordering rewrites `order` sequentially,
  0-based, for every coach)
- `Contacts` (PK `contact_id`): `kind` (one of `Program`/`School`/
  `Boosters`/`Social` — see `CONTACT_KINDS` in `app.js`, a fixed
  `<select>`; shown as a small eyebrow label above the contact's name on
  the public page), `label` (free text, e.g. "General Info"), `role` (free
  text sub-label, e.g. "Head Coach, Varsity" — shown under the label in
  place of `type` when set), `type` (one of `Email`/`Physical Address`/
  `Instagram`/`Phone` — see `CONTACT_TYPES` in `app.js`; it's a fixed
  `<select>`, not free text, so adding a new contact type means updating
  that array; `Phone` renders as a `tel:` link, stripping everything but
  leading `+` and digits from `value` for the href), `value` (free-text
  textarea — holds an email, a full mailing address, an @handle, or a
  phone number depending on `type`), `order` (drag-to-reorder, same
  pattern as Coaches). `renderContactsSection` in `app.js`. The public
  Contact page (`initContactPage` in `site.js`) pulls the `Physical
  Address` contact out of the flat list into its own "gym" section
  (address split into street/city-state-zip lines, a `mapsUrl()`-linked
  "Directions" button, and a purely decorative `.gym-photo-placeholder`
  — there's no image field on Contacts, this is a design placeholder
  copied from the mockup, not backed by real data) — every other contact
  renders as a `.contact-grid` of `.contact-card`s (kind eyebrow / label /
  role / value link), matching the design mockup's two-column contact
  list + gym-block layout.
- `Sponsors` (PK `sponsor_id`): `name`, `kind` (free text business
  category, e.g. "Orthodontics · Thousand Oaks"), `website` (free text
  URL), `tier` (one of `Banner`/`Court`/`Friend of the Program` — see
  `SPONSOR_TIERS` in `app.js`, a fixed `<select>` like `CONTACT_TYPES`),
  `order` (drag-to-reorder). `renderSponsorsSection` in `app.js` is a
  direct copy of `renderContactsSection`'s shape. Public `sponsors.html`
  groups sponsors by `tier` (fixed order Banner → Court → Friend of the
  Program); the home page's sponsor strip lists `/sponsors` names instead
  of the old free-text Content Block body.
- `Albums` (PK `album_id`): `title`, `date_label` (free text — a month or
  a date range, e.g. "November" or "Dec 20–22", not a real date type since
  events don't cleanly fit one), `order` (drag-to-reorder). Individual
  photos live in the separate `Photos` table below, mirroring the
  Rosters/Players split. The admin's Photos tab shows the album list, and
  a "Photos" button per album opens a nested panel scoped to that
  `album_id` (`renderPhotosSection` in `app.js`) — same pattern as
  Rosters' "Players" button.
- `Photos` (PK `album_id`, SK `photo_id`): `image` (CloudFront URL from
  the shared `/uploads` presigned-URL flow), `caption` (free text),
  `order` (drag-to-reorder). Unlike every other image field, photo upload
  skips `createImageField`'s square-crop canvas entirely — `uploadImageBlob()`
  is called directly on the raw selected file — since these are candid
  event photos at their natural aspect ratio, not avatar crops. Public
  `photos.html` renders one section per album (title + date label) with a
  photo grid below, sorted by `order`.
- `Standings` (PK `cache_id`, always the literal string `"current"` — a
  singleton cache row, not a keyed list): `source_url` (the MaxPreps
  league standings page to scrape — editable in the admin's League
  Standings tab, so a season URL change needs no redeploy), `updated_at`
  (unix timestamp), `rows` (list of maps: `rank`, `school`,
  `league_record`, `league_pct`, `league_pf`, `league_pa`,
  `overall_record`, `overall_pct`, `overall_pf`, `overall_pa`, `streak`,
  `link` — a URL to that school's own site, admin-set, never scraped).
  `backend/functions/standings/handler.py` is a screen-scraper, not CRUD,
  with three actions instead: `GET` (public) serves the cached row
  instantly — no live scraping on read, per the user's explicit ask.
  `POST` (JWT, the admin's "Refresh Now" button) fetches `source_url` via
  `urllib.request` and parses the table with plain regex (confirmed
  server-rendered, no JS needed; see the handler's docstring for the
  exact markup shape it expects), then overwrites the cache — merging
  each new row's `link` forward from the previous cache by matching
  `school` case-insensitively, since `link` only ever comes from the
  admin, never from MaxPreps, and would otherwise be wiped out by every
  refresh. Returns a 502 with the error message on fetch/parse failure
  rather than silently no-oping — but a MaxPreps markup change that still
  "parses" as zero rows won't trigger that; this is an inherent
  screen-scraping fragility, not a bug to fix generically. `PUT` (JWT) is
  the admin's "Save Changes" action for manually editing any field
  (including fixing a scrape error) — persists the given `rows` array
  as-is with no scraping involved, but a later Refresh Now will still
  overwrite non-`link` fields with whatever MaxPreps reports next. An
  event with no `requestContext` (a direct/EventBridge invoke rather than
  an API Gateway call) is treated as an implicit refresh (same as POST)
  using the last saved `source_url` — no scheduled trigger exists yet
  (refresh is manual-only for now), this just means adding one later
  needs no handler changes.
- `AdminAllowlist` (PK `email`): admin emails permitted to log in. Manage
  with `scripts/seed_allowlist.py add|remove|list <email>` (uses the
  `.venv` in the repo root — `pip install boto3` into it if missing).

## Seed / backfill scripts

`scripts/seed_rosters.py` (same `.venv`) creates Varsity/Junior
Varsity/Frosh teams with 15 generated players each and assigns every
existing coach to every team — reusable for resetting test data, but it
always creates new teams rather than upserting, so delete the old ones
first if reseeding.

`scripts/add_team_photos.py` (same `.venv`, needs Pillow — `pip install
Pillow` if missing) generates a simple colored placeholder image (team
initials on a solid background) for any roster missing a photo and uploads
it directly via boto3/S3, bypassing the presigned-URL Lambda since it
already has AWS credentials. Skips rosters that already have an `image`.
Real team photos should replace these later through the admin UI's normal
upload/crop flow.

`scripts/seed_schedule.py` (same `.venv`) seeded the Varsity boys 2026-2027
schedule (season key `"2026-2027"`) from
https://www.nphsathletics.org/varsity/basketball-boys/schedule-results,
scraped 2026-09-12 while the season hadn't started yet (0-0-0 record), so
every game has blank `our_score`/`opponent_score`. It predates the
`time`/`address`/`team_id` fields, so `scripts/backfill_schedule_time_team.py`
added `time` (scraped alongside the original dates, just not stored yet at
that point) and `team_id` (linked to the "Varsity" roster) after the fact —
`address` is still blank for all of these since the scrape only had
"Gym"/"TBA"/tournament venue names, not real street addresses.

`scripts/seed_jv_frosh_schedule.py` (same `.venv`) did the same for Junior
Varsity and Frosh/Soph, scraped 2026-09-12 from
https://www.nphsathletics.org/lower/basketball-boys-junior-varsity/schedule-results/
and .../basketball-boys-frosh-soph/schedule-results/ — written after the
schema already had `time`/`address`/`team_id`, so it sets them directly
rather than needing a separate backfill. Linked to the "Junior Varsity" and
"Frosh" rosters by name.

None of these scripts re-run automatically — re-scrape and re-run (or edit
through the admin UI) as scores come in or the schedule changes.

`scripts/backfill_addresses.py` (same `.venv`) filled in `address` for 78/82
games: Newbury Park High School's address (`456 N Reino Rd, Newbury Park,
CA 91320`) for every Home game, and each opponent's real, web-verified
street address for Away games. The 4 "San Gabriel Tournament" games are
still blank — the host site couldn't be confirmed, so it was left blank
rather than guessed; fill it in through the admin UI once known. The
opponent→address mapping lives in the script itself if more venues need
adding later.

`scripts/seed_news.py` (same `.venv`, needs Pillow) created 4 placeholder
News posts with generated photos (same style as `add_team_photos.py`) and
valid future published/end dates. Real copy and photos should replace these
through the admin UI.
