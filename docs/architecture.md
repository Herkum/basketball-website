# Architecture

```
Browser (public)  --> CloudFront --> S3 (static site: HTML/JS/CSS)
Public site       --> API Gateway (GET, no auth)  --> Lambda (Python) --> DynamoDB
Browser (admin)   --> Google Sign-In --> Cognito User Pool (Google IdP) --> gets JWT
Admin SPA         --> API Gateway (JWT authorizer, POST/PUT/DELETE) --> Lambda --> DynamoDB
Admin SPA         --> Lambda (presigned URL) --> browser uploads image directly to S3
```

## Frontend

Plain HTML/JS/CSS — no build step, framework, or bundler. Public pages sit
at `frontend/` root (`index`, `rosters`, `roster`, `schedule`, `news`,
`coaches`, `contact`, `sponsors`, `photos`, `standings`, `regional-leagues`,
`mission`, `games-online`, `store`, `donate`, `sponsorships` `.html`) and
share `site.js`/`site.css`. `frontend/admin/` is the separate admin SPA
(`app.js`/`style.css`). `shared.js` holds helpers both use (`mapsUrl`,
`defaultSeason`, `matchupPrefix`, the standings helpers, `SCHOOL_COLORS`).

## Public site

- **Layout**: a full-width `.site-header` bar (static HTML in every page —
  edit the HTML to change the brand; no Content Block drives it), then
  `.layout` = `#site-sidebar` + `.central-column > main`, then
  `#site-footer`. Header, layout, and footer are all capped at 1120px (the
  220px sidebar + 900px column) so they line up. Every `initXPage()`
  first calls `initLayout()`, which fetches blocks/rosters/contacts/
  standings in parallel, builds the sidebar, and returns that data for the
  page to reuse.
- **Sidebar**: a Varsity record card (`.record-card`, Overall vs. League)
  read off our own row in `/standings` — matched by `school` against the
  Logo Content Block's `title`, the same "which row is us" match used site-
  wide; Standings, not Schedule, is the source of records. Below it the
  nav, a fixed structure (`NAV_STRUCTURE` in `site.js`) by explicit
  request: Home, Store, Donate top-level, then Media / Basketball / Booster
  groups of generator sub-links, Rosters followed by one link per team
  (`roster.html?team=<id>`). Labels come from each generator's Content
  Block `title` (falling back to the generator name), so pages can be
  renamed freely; only grouping/order is hardcoded. A top-level entry with
  `href` links out in a new tab instead of to its page (Store → the
  promo-ops team store); a group item can also be a plain `{label, href}`.
  The `special`/NoIndex flag does **not** affect the nav. The footer shows
  the first `Physical Address` Contact and the Logo block's `league_name`.
- **Phone widths (≤720px)**: the sidebar hides behind a Menu button
  (`initNavToggle()`, toggles `body.nav-open`). Page-level tables sit in a
  `.table-scroll` wrapper so they scroll in their own box — give any new
  page-level `<table>` the same wrapper. Justified paragraphs go left-
  aligned. Regional Leagues trims further so its tables fit outright
  (scoped by `.regional-leagues`, so Standings is unaffected): no `#`
  column, badges, League column (Ranking), or Pct columns (`.col-pct`,
  Leagues), plus smaller names/tighter cells. Because hidden cells break
  fixed colspans, `syncGroupSpans()` resizes `buildStandingsTable`'s
  "Overall"/"League" labels to their visible columns (`data-group`) on
  build and whenever `PHONE_QUERY` flips.
- **Visual style**: the "Classical" design system
  (`designer/classical-dcb8c44c-.../readme.md`); `site.css`'s `:root` tokens
  are copied from its `styles.css` (`--muted`/`--border`/`--bg`/`--text` are
  aliases onto them). Cormorant Garamond headings, Lora body, warm near-
  white ground, near-black text, one bronze accent (`--color-accent`) used
  for stroke/underline/text only, never a filled block; body text
  justifies. Deliberate exceptions, on request (the sidebar and titles
  blended into the grey): the header bar, record card, and nav group
  labels are black with yellow text; `#page-title` is a white plate with a
  black left bar and yellow underline; `.section-heading h2` gets the
  black bar; the Home `.stat-row` is a white card with a W/L badge.
  `.plate` (sepia filter + matted border) wraps every real photo except
  40×40 player-row thumbnails — the system's signature treatment, so the
  warm/desaturated look is intended. Other shared classes: `.eyebrow`,
  `.section-divider` (via `sectionDivider(title, children)`), `.nums`,
  `.result-win`/`.result-loss`; `filter-row` buttons are accent-outlined.
- **Content Blocks → pages**: a block's `generator` picks the page it
  drives; `findBlockByGenerator()` looks blocks up by generator (never by
  title) and the page renders `title` as its `<h1>`/nav label and `body` as
  plain intro text. `GENERATOR_PAGES`/`pageForGenerator()` map generators to
  files. Exceptions: **Mission Statement** (`initMissionPage`) and
  **Store/Sponsorships/Donate/Games Online** (`initHtmlBlockPage`) render
  `body` as raw HTML — they hold admin-authored markup or pasted embeds
  (store widget, donate iframe, Hudl links). **Logo** drives no page; its
  `title` is our school name for row matching and `league_name` labels the
  footer/Home standings. **Home** has no generator and is found by title
  (`findBlock`).
- **Home** (`initHomePage`): title from the Home block, a season eyebrow,
  and Varsity/JV/Frosh buttons over a `.stat-row` (Last Result / Next
  Game / Upcoming, computed client-side from `/schedule/<season>`; Next
  Game links to the venue's directions; "Full schedule" sits on
  Upcoming's header line). Then the News/Events feed (events
  nearest-first, then news newest-first):
  - `.news-top`: the lead story (2/3 — a full-width title over a small
    `.plate` photo beside the date and excerpt) and the second item as a
    compact card (1/3, `.news-top-side`). The lead card opens the full
    story on click/Enter; it's a focusable `role="link"`, not an `<a>`,
    because its excerpt can hold the post's own links.
  - `.news-carousel`: every remaining item (CSS scroll-snap; ‹ › buttons
    step one card, disable at the ends, and hide when everything fits;
    3 cards per view on desktop, ~1.5 on phones).
  - Each compact `.news-card` is a photo — or, with none, the story's
    opening text in the same 16:9 box (`.news-card-text`) — plus title and
    date; the whole card opens `openNewsModal()`, calling
    `stopPropagation()` so the lightbox doesn't also open.
  - Then `.home-split`: the shortened standings card (`.standings-mini`,
    overall W/L only, in Standings' own order — `compareStandingsRows`,
    league record first — so the two never disagree) and a random Sponsor
    Spotlight. Last, full width, by request:
    the Home block's body (the league blurb). Mission Statement isn't on
    Home; it has its own page.
- **Standings**: the public page and the admin's League Standings table
  build the same layout from the `shared.js` helpers (`parseRecord`,
  `compareStandingsRows`, `standingsPlaces`, `formatPct`, `formatDiff`,
  `diffClass`, `parseStreak`) so they can't drift: tied places ("T2"), our
  row highlighted, Pct **recomputed from W-L** (MaxPreps has reported a
  stale .000 for a 1-0 team, so the scraped/hand-edited `*_pct` fields are
  never shown), brighter green/red diffs and streak badges. The public
  table is `buildStandingsTable()` (also used by Regional Leagues) and
  shows League PF/PA only as a tooltip. School shields: `schoolInitials()`
  colored by the hand-sampled `SCHOOL_COLORS` map, else — given a Rankings
  team row — MaxPreps' `color1`/`color2` via `badgeColorsFromTeam()`
  (initials forced black/white below 3:1 contrast), else a plain outline;
  our row is always header yellow.
- **Regional Leagues** (`initRegionalLeaguesPage`): `GET /rankings` as three
  tabs remembered in the URL hash. **Ranking** (`#ranking`): every tracked
  team, sortable by any header (ratings high-to-low first, names/ranks
  low-to-high, unplayed teams last, SRS rank breaks ties). **Leagues**
  (`#leagues`): one `buildStandingsTable` per league, A–Z, schools linking
  to MaxPreps. **School Map** (`#map`, `buildSchoolMap`): Leaflet 1.9.4 on
  OpenStreetMap, loaded from cdnjs with SRI by this page only (no API key,
  unlike Google Maps). Built on first show — Leaflet measures its
  container, and a hidden panel is 0×0 — and the map needs a view
  (`fitBounds`) before any marker is styled or Leaflet throws on
  `bringToFront`. Pins are one neutral ink color; a league `<select>` in
  the tab row (shown only on this tab) drives the returned `applyFilter`,
  highlighting that league in bronze and dimming the rest (not ten league
  hues — unreadable, and the system is single-accent). Our school is
  yellow. Popups: record/SRS, address, Directions, MaxPreps.
- **Schedule** (`initSchedulePage`): the same team-filtered games as a
  month-grouped table (`renderTable`) or a read-only month calendar
  (`buildCalendar`, mirroring the admin's), switched by a List/Calendar
  toggle through `renderView()`.
- **Rosters**: `rosters.html` is a card index; `roster.html?team=<id>`
  (`initRosterDetailPage`) shows one team's photo, coaches, and players.
  The Coaches page derives each coach's team(s) from Rosters' `coach_ids`.
- **News**: `/news` returns everything (the admin needs past/future posts);
  visibility is filtered client-side by `isNewsActive()` — see `News` in
  content-schemas.md. The story popup (`openNewsModal()`, opened by any
  Home news card) is up to 64rem wide with a 360px photo and scrolling
  text; on phones it stacks, with extra top padding so the photo clears
  the close ×. A full article (`news.html` or the popup) also shows its
  linked album's photos: `fetchNewsPhotoIndex()` fetches `/albums` once
  and only the linked albums' `/photos`; `buildPhotoCarousel()` is a
  scrolling strip of 96×96 thumbnails (140px in the popup, where it sits
  below the text, always in view) opening `openPhotoModal()` (titled by
  the caption). Thumbnails call `stopPropagation()` so the document-level
  `initImageLightbox` doesn't open a second, caption-less popup.
  News photos are always shown whole (`object-fit: contain`, natural
  shape with a height cap; Home's cards keep a 16:9 box with the spare
  space in the `.plate` mat color). New uploads are square-cropped by the
  admin, but older posts' photos come in other shapes, and a fixed-ratio
  box with `cover` clipped them. Coach/team photos stay square crops.

## Admin SPA

A metadata-driven rewrite (structure from `designer/Basketball Website
Admin.dc.html`, styled on the same Classical tokens) in `admin/app.js`:

- `renderGenericSection(container, meta, ctx)` — the shared list engine
  (search, click-to-sort, drag-to-reorder disabled while sorted, empty
  state, Edit/Delete), configured per section by `contentBlocksMeta()`,
  `newsMeta()`, `coachesMeta()`, `contactsMeta()`, `sponsorsMeta()`,
  `rostersMeta()`, `albumsMeta()`, `locationsMeta()`, `usersMeta()`, and the
  drill-downs `playersMeta(team, back)` (Rosters → Players) and
  `photosMeta(album, back)` (Photos → album). Reorder is off for News,
  Players, and Users (no `order` field).
- `openModal({fields, initialValues, onSave, validate})` — the shared form
  dialog. Field types: `text`/`textarea`/`select`/`checkbox`/`multi`/`file`/
  `number`/`date`/`email`; `visibleIf(form)` for conditional fields;
  `validate(values)` for cross-field rules (required fields are checked
  generically). `openConfirm()` and `showToast()` replace every native
  dialog (see gotchas).
- **Image fields**: cropped client-side in `openImageCropDialog()` (drag/zoom
  to a square), then uploaded straight to S3 via a presigned URL from the
  `uploads` Lambda (`images/uploads/<uuid>.<ext>`, served by CloudFront).
  `raw: true` skips cropping (album photos keep their natural shape).
- **Nav**: Content / Teams / Season / Administration (`NAV_GROUPS`).
  `initDashboard()` loads the signed-in user's Users row (`getCurrentEmail()`
  decodes the id_token) and `hasSectionAccess()`/`SECTION_PERMISSION` hide
  tabs they lack permission for. That's convenience only — the Lambdas
  enforce permissions (see `AdminAllowlist` in content-schemas.md).
- **Bespoke sections** (still using `openModal`/`openConfirm`/`showToast`):
  Schedule (`renderScheduleSection` — Season loader, team filter, List/
  Calendar toggle) and League Standings (`renderStandingsSection` — a
  singleton cache with no per-row endpoint, so Add/Edit/Delete each build
  the whole new `rows` array and `PUT /standings`). Its one "Refresh from
  MaxPreps" panel starts the rankings refresh (`POST /rankings`), which
  also rewrites this table, then polls and reloads the table when done.

## Backend & API

- **API Gateway HTTP API**, one Lambda per resource (`rosters`, `players`,
  `schedule`, `news`, `content_blocks`, `coaches`, `contacts`, `sponsors`,
  `albums`, `photos`, `locations`, `users`), each CRUD on its own table.
  Adding a keyed-list resource takes one entry in `local.functions`
  (`infra/lambda.tf`), a table (`infra/dynamodb.tf`), and `local.api_routes`
  (`infra/api.tf`). `standings`, `rankings`, and `uploads` are singleton
  actions with bespoke routes in `api.tf` (`GET`/`PUT /standings`,
  `GET`/`POST /rankings`, `POST /uploads`) but deploy through the same
  `local.functions`. The `rankings` refresh is the only MaxPreps scrape:
  it also writes our league's table to the Standings cache (its
  `extra_env` gives it `STANDINGS_TABLE_NAME`, and the
  `rankings_standings_write` policy in `api.tf` lets it read/replace
  that one row). Routes are per real method, never `ANY` (see gotchas).
- **Public reads**: GET routes are `authorization_type = "NONE"` (`api.tf`'s
  route locals: `public = m == "GET" ? lookup(r, "public_get", true) :
  false`) — `/users` opts out with `public_get = false`; every write is
  JWT-protected. Deliberate and approved — it's
  exactly the content the public site shows. Don't re-lock it casually.
- **Auth**: Cognito federates Google; the admin does Authorization Code +
  PKCE against the Hosted UI (no client secret in the browser). The
  `post_auth_allowlist` trigger rejects emails not in `AdminAllowlist`.
  Session length is the app client's `id_token_validity` (2 hours,
  `infra/cognito.tf`) — `auth.js` stores only the id_token and never uses a
  refresh token. Since the dashboard never reloads,
  `scheduleSessionTimeout()` sets a timer to return to the login screen
  the moment the token expires.
- **Infra**: Terraform under `infra/`, local state (`infra/terraform.tfstate`)
  — move to an S3 backend before anyone else works on it.
