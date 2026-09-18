# Architecture

```
Browser (public)  --> CloudFront --> S3 (static site: HTML/JS/CSS)
Public site       --> API Gateway (GET, no auth)  --> Lambda (Python) --> DynamoDB
Browser (admin)   --> Google Sign-In --> Cognito User Pool (Google IdP) --> gets JWT
Admin SPA         --> API Gateway (JWT authorizer, POST/PUT/DELETE) --> Lambda --> DynamoDB
Admin SPA         --> Lambda (presigned URL) --> browser uploads image directly to S3
```

- **Frontend**: plain HTML/JS/CSS, no build step, no framework, no bundler.
  Public site pages live at `frontend/` root (`index.html`, `rosters.html`,
  `roster.html`, `schedule.html`, `news.html`, `coaches.html`,
  `contact.html`, `sponsors.html`, `photos.html`, `standings.html`,
  `mission.html`) sharing `site.js`/
  `site.css`; `frontend/admin/` is the separate admin SPA with its own
  `app.js`/`style.css`.
- **Public site layout**: `#site-header` sits *above* `.layout` as a full-
  width bar (spans over the sidebar too, not just the central column) —
  its own inner wrapper (`.site-header-inner`) is what's width-capped and
  centered (`max-width: 1400px`) to line up with `.layout`'s matching cap,
  so the header's content aligns with the sidebar/central-column boundary
  below it without the bar itself looking clipped on wide viewports.
  Below that, `.layout` is the sidebar + central-column row (`#site-sidebar`
  + `.central-column` > `<main>`, see any page's HTML). `initLayout()` in
  `site.js` builds both the header (the brand block — see below) and the
  sidebar nav, and is called by every `initXPage()` before it renders its
  own content. The nav is a fixed structure (`NAV_STRUCTURE` in `site.js`),
  not purely `order`-driven like the admin's nav groups — Home and Store
  are top-level links, then three hardcoded group headers (Media,
  Basketball, Booster) each list a fixed set of generators as indented
  sub-links (`.sub-link`), Rosters' per-team links nesting one level
  deeper still (`.sub-link--team`). Each link's own label still comes from
  its Content Block's `title` (falling back to the generator's own name if
  that block doesn't exist yet, e.g. before Store/Sponsorships/Donate are
  created in the admin) so the admin can rename any page freely — only the
  grouping/ordering itself is hardcoded now. This was a deliberate,
  explicit change (not something to casually redo elsewhere) — the
  `special`/NoIndex flag no longer controls sidebar inclusion at all
  (every generator in `NAV_STRUCTURE` always gets a link); it's still
  surfaced in the admin as a search-engine NoIndex hint, just no longer
  tied to nav visibility.
- **Public site visual style**: follows the real "Classical" design
  system (`designer/classical-dcb8c44c-cb34-4501-a2e9-cf858d85b40d/`,
  see its `readme.md` for the full spec) rather than an earlier guess —
  `site.css`'s `:root` tokens (`--color-*`/`--font-*`/`--space-*`/
  `--radius-*`/`--shadow-*`) are copied from that bundle's `styles.css`.
  Cormorant Garamond for headings, Lora for body, a warm near-white
  ground (`--color-bg` #f3f2f2), near-black text, and a single bronze
  accent (`--color-accent` #b68235, used as stroke/underline/text only —
  never a filled block, per the system's explicit "don't"). `--muted`/
  `--border`/`--bg`/`--text` are kept as compatibility aliases that
  forward to the real tokens, so existing rules didn't need a full
  rename. Body paragraphs justify (`text-align: justify`) per the
  system's editorial direction. The sidebar/header lost their solid navy
  fill for `--color-surface`/page-background + hairline borders — the
  system has no vertical-nav component, but "no filled blocks" still
  applies to whatever skins the existing sidebar/central-column
  structure (that structure itself predates this system and stays).
  `.plate` is adopted verbatim from the bundle: a sepia/desaturated
  filter (`sepia(0.22) saturate(0.82) contrast(1.05)`) plus a matted
  border, wrapped around every real photo (team/coach/news/gallery
  images) except the small 40×40 inline player-row thumbnails, where the
  mat would overwhelm the image — this is the system's signature photo
  treatment, not a bug, and noticeably warms/desaturates every uploaded
  photo. Reusable classes: `.eyebrow` (retuned to the system's
  `.card-kicker` spec — 10px, tracked, accent-colored), `.section-divider`
  (now a true 1px hairline, not a heavy black rule, matching the
  system's `.hr` — wraps teams on Rosters, months on Schedule, tiers on
  Sponsors, albums on Photos, built via the `sectionDivider(title,
  children)` helper in `site.js`), `.nums` (tabular-nums), `.result-win`/
  `.result-loss` (score color coding). Buttons (Schedule's filter row)
  are accent-outlined with a tinted hover/active state, never solid-fill,
  per the system's `.btn`/`.btn-primary` direction. The Coaches page
  cross-references `/rosters`' `coach_ids` client-side to show an eyebrow
  of which team(s) a coach is on — inverse of a relationship Rosters
  already owns, not a new field.
- **Header brand block + sidebar record/footer** (`initLayout()`, every
  page): a "Logo" Content Block (`generator: "Logo"`, `special: true`/
  NoIndex — created once via `scripts/set_logo_block_and_reorder.py`)
  drives the brand block rendered inside the full-width header bar (see
  "Public site layout" above) — its `image` is the logo (falls back to a
  monogram of the first letter of each word in `title`, e.g. "Newbury
  Park" → "NP", when no image is set), `title` is the short site name,
  `body` is the tagline, and a `league_name` field (admin-only input on
  the Content Blocks form, shown only when Generator is "Logo") feeds the
  sidebar footer and the Home page standings heading. There is no more
  separate "Header" Content Block — it used to hold the site-name text
  shown in a plain header bar, but once the brand block moved into the
  header that text was redundant with the Logo block's own `title`, so
  the Header block was deleted; if `logoBlock` is ever missing entirely
  (e.g. mid-setup on a fresh site), the header falls back to a plain
  "Basketball" `.site-title` label rather than looking up any block by
  name. At the top of the sidebar (now the first thing there, since the
  brand block moved out of it) sits a W-L record box (Overall vs. League)
  read directly off our own row in `/standings` (matched by `school`
  against the Logo block's `title`, same matching used for the Home
  page's standings highlight) — Standings is the authoritative source for
  records site-wide, not a client-side computation from Schedule.
  (Schedule's `is_league` checkbox — "not every opponent is a league
  game, tournaments and non-league games aren't" — still exists on the
  admin form but nothing on the public site currently reads it; it was
  the sidebar record's original data source before this changed to read
  from Standings instead.) The sidebar footer pulls the first `Physical
  Address` Contact's `value` plus the Logo block's `league_name`.
- **Home page**: `initHomePage` in `site.js` sets the page title from the
  Home Content Block's own `title` (not a hardcoded "Welcome") and shows
  a `${defaultSeason()} Season` eyebrow under it. Builds a `.stat-row`
  (Last Result / Next Game / Then) computed client-side from
  `/schedule/<season>` — Last Result is the most recent game with both
  scores set, no new endpoint; Next Game's second meta line shows
  "Home · <gym contact label>" or "At <opponent's Location>" for away
  games. Directly below `.stat-row` comes the News/Events feed (events
  nearest-date-first, then news newest-first, concatenated into one list),
  rendering its first item as a lead article (`.news-lead` — text beside a
  `.plate` photo, an excerpt, a "Read the recap →" link) and up to 3 more
  as a `.news-grid` of smaller cards underneath — this mirrors the design
  mockup's actual News section structure (which lives on its Home page,
  not a separate page in the mockup) rather than the flatter single-
  paragraph callout an earlier pass on this page used. The Home block's
  body text comes after that, still deliberately placed below the fold
  rather than at the top of the page (a specific request, not mockup
  fidelity — the mockup puts its intro paragraph directly under the H1
  instead) — it was originally positioned right under `.stat-row` before
  the News feed moved in ahead of it, so it's now stat row → News → body
  text → standings. Mission Statement is **not** shown on Home at all
  anymore — it has its own dedicated page (see Content Blocks → page
  mapping). The standings section (last on the page) shows the **full**
  `/standings` list (not a top-N teaser), sorted by
  `compareStandingsRows()` (best League record first, Overall record as
  the tiebreaker — parsed from the scraped "W-L" strings — since the
  scraped `rank` field isn't used anywhere on this site), with no Rank
  column, and highlights whichever row's `school` matches the Logo
  block's `title` (`.standings-row-us`) — this is how the site knows "the
  row for us" without a separate flag on the scraped data. Its heading
  uses the Logo block's `league_name` with a "Varsity Standings" eyebrow.
- **Schedule page List/Calendar toggle**: `initSchedulePage` in `site.js`
  can render the same filtered games as either the month-grouped table
  (`renderTable`) or a month calendar grid (`buildCalendar`, read-only
  chips — no click-to-edit like the admin's calendar), switched by a
  `filter-row`-styled toggle; both share the same team filter state
  (`currentTeamId`) and re-render through one `renderView()` dispatcher.
  `buildCalendar` mirrors the admin's own calendar
  (`renderScheduleSection` in `admin/app.js`) — same month-grid
  construction, centered on the earliest game in the filtered set —
  restyled to the public site's tokens (`.calendar-*` classes in
  `site.css`) instead of the admin's.
- **Public API**: every GET route is `authorization_type = "NONE"` (see
  `infra/api.tf` — `item_routes`/`list_routes` locals set `public = m ==
  "GET"` and the two `aws_apigatewayv2_route` resources branch on it);
  every POST/PUT/DELETE route stays JWT-protected. This was a deliberate,
  explicitly-approved change (not something to casually redo elsewhere) —
  it makes all *read* access to Rosters/Players/Schedule/News/Coaches/
  Contacts/ContentBlocks public, which is correct since that's exactly the
  content the public site displays. `/uploads` (POST-only, admin image
  upload) was untouched.
- **Content Blocks → page mapping**: each Content Block has a `generator`
  field (dropdown in the admin — see `CONTENT_BLOCK_GENERATORS` in
  `admin/app.js` for the full list) that drives a dedicated public page.
  `findBlockByGenerator(blocks, generator)` in `site.js` looks one up by
  that field (not by title, so the admin can rename a block freely) and
  renders its `body` as the page's intro and its `title` as the page's
  `<h1>` and sidebar label. `GENERATOR_PAGES`/`pageForGenerator()` map a
  generator value to its HTML file (`Rosters`→`rosters.html`,
  `Schedule`→`schedule.html`, etc.; no/unrecognized generator falls back
  to `index.html`). Blocks with no generator (`Home`) are plain text
  sections rendered only on the home page, still looked up there by title
  via `findBlock(blocks, title)` since there's no dedicated page for them
  to be a generator of. Store/Sponsorships/Donate are the one exception to
  "renders `body` as the page's intro" — `initHtmlBlockPage()` renders
  their `body` as raw HTML (`innerHTML`, not text) instead, since those
  three are meant to hold an admin-pasted embed (a store widget, a
  donate button/iframe, a sponsorship pitch) rather than plain copy.
- **Rosters get their own sidebar entries + pages**: `initLayout()` also
  fetches `/rosters` and, right after the "Rosters" sidebar link, injects
  one indented sub-link per team (`.sub-link` in `site.css`) pointing at
  `roster.html?team=<team_id>`. `rosters.html`/`initRostersPage` is just a
  lightweight card-grid index; `roster.html`/`initRosterDetailPage` renders
  one team's photo/coaches/full player table, reading `team` from the query
  string. Both the "Rosters" parent link and the matching team sub-link are
  marked active when on `roster.html`.
- **News "active" filtering is client-side only**: `site.js`'s
  `initNewsPage`/`initHomePage` filter to `published_date <= today <=
  end_date` after fetching `/news` in full. The Lambda deliberately returns
  everything unfiltered — the admin UI needs to see and edit past/future
  posts too, so filtering can't happen server-side without breaking that.
- **News/Event photo carousel**: a full News/Event article (`news.html`'s
  own posts, and the Home page's "Full Article" modal via `openNewsModal`)
  shows a photo carousel at the end when an Album is linked to that post
  (Albums' `linked.ref === "news:<post_id>"`, see Albums in
  content-schemas.md — previously admin-only metadata nothing on the
  public site read). `fetchNewsPhotoIndex()` builds a post_id -> photos[]
  lookup by fetching `/albums` once and only fetching `/photos/<album_id>`
  for albums actually linked to a post, not every album.
  `buildPhotoCarousel(photos)` is a horizontally-scrolling strip of small
  (96×96) thumbnails (`.photo-carousel`, `overflow-x: auto`) — not one
  image stretched to the article's width — clicking any thumbnail calls
  `openPhotoModal(photo)`, a dedicated full-size popup (mirrors
  `openCoachModal`/`openNewsModal`'s modal chrome) whose own `<h2>` title
  is the photo's `caption`, per explicit request, rather than a generic
  "Photo" label. Each thumbnail still carries `.plate` (same sepia
  treatment as every other on-page photo) but its click handler calls
  `stopPropagation()`, since without it the document-level lightbox
  listener (`initImageLightbox`) would also catch the same click and open
  its own plain, caption-less popup on top of/behind this one.
- **Auth**: Cognito User Pool federates with Google as an IdP. The SPA does
  Authorization Code + PKCE against Cognito's Hosted UI (no client secret in
  the browser). A Cognito post-authentication Lambda trigger
  (`backend/functions/post_auth_allowlist`) checks the authenticated email
  against the `AdminAllowlist` DynamoDB table and rejects sign-in if absent.
  Session length is the Cognito app client's `id_token_validity` (2 hours,
  `infra/cognito.tf`) — `auth.js` only ever stores the `id_token` and never
  requests/uses a refresh token, so this is the real "how long is an admin
  logged in for" knob, not `refresh_token_validity`. Because the admin
  dashboard is a single page that's never reloaded during normal use,
  `isLoggedIn()`'s `Date.now() < expires_at` check alone would only catch an
  expired session the next time something happened to re-check it (e.g. a
  failed submit hitting `apiFetch`'s 401 handling). `scheduleSessionTimeout()`
  (called once from `index.html` right after the initial `isLoggedIn()` check)
  sets an actual `setTimeout` for the remaining validity so the session ends
  itself — back to the login screen — the moment the token expires, with no
  user action required to trigger it.
- **API**: API Gateway HTTP API, one Lambda per resource
  (`rosters`, `players`, `schedule`, `news`, `content_blocks`, `coaches`,
  `contacts`, `sponsors`, `albums`, `photos`), all
  doing simple CRUD against their own DynamoDB table. Routes are declared
  per real HTTP method (GET/POST/PUT/DELETE), not `ANY` — see "Known
  gotchas" below for why. Adding a new keyed-list resource is table-driven:
  one entry each in `local.functions` (`infra/lambda.tf`), a table in
  `infra/dynamodb.tf`, and `local.api_routes` (`infra/api.tf`) — the
  routing/CORS/JWT-vs-public wiring itself needs no changes. `standings`
  and `uploads` are the two exceptions to this pattern — both are
  singleton actions (not a keyed list of entities), so they get bespoke
  integration/route blocks in `api.tf` instead (`GET`/`POST /standings`,
  `POST /uploads`) while still reusing the generic
  `local.functions`/`aws_lambda_function.function` mechanism for their
  actual Lambda deployment.
- **Rosters/Players**: `rosters` is team-level (name, photo, drag-order,
  many-to-many `coach_ids`); `players` is a separate table keyed by
  `team_id`/`player_id` for the roster of individual players under a team.
  The admin UI's Rosters tab shows the team list, and a "Players" button per
  team drills into a `playersMeta()` view scoped to that `team_id`, with a
  "← Rosters" breadcrumb back — same pattern used for Photos → Albums (see
  "Admin UI" below).
- **Image uploads** (coach, team, player, and Content Block photos): the
  browser crops an image client-side, then uploads the result directly to
  S3 via a presigned URL from the `uploads` Lambda (`backend/functions/uploads`,
  writes to `images/uploads/<uuid>.<ext>` — not entity-specific despite the
  older `images/coaches/...` objects still sitting in the bucket from before
  this was generalized). `openImageCropDialog()` (`frontend/admin/app.js`)
  is a separate modal dialog — drag to reposition, wheel/slider to zoom,
  against a fixed square crop window — reused by every cropped `file`-type
  field in the admin's generic form engine (see "Admin UI" below). Photos
  (the per-album picture, not to be confused with Content Block photos)
  skip cropping entirely (`raw: true` on that field) since they're candid
  event shots at their natural aspect ratio, not avatar crops. Images live
  under `images/` in the same S3 bucket as the static site, so they're
  served publicly via CloudFront.
- **Admin UI**: a from-scratch rewrite (matching
  `designer/Basketball Website Admin.dc.html`'s mockup structure, restyled
  onto the same Classical tokens as the public site — see
  `frontend/admin/style.css`) replaced the old one-hand-rolled-function-
  per-section admin with a generic, metadata-driven engine in
  `frontend/admin/app.js`:
  - `renderGenericSection(container, meta, ctx)` is the shared list/table
    engine — search, click-to-sort columns, drag-to-reorder (disabled
    while a sort is active, and omitted entirely for sections whose real
    schema has no `order` field: News, Players, Schedule), an empty state,
    and Edit/Delete per row — driven entirely by a `meta` object per
    section (`contentBlocksMeta()`, `newsMeta()`, `coachesMeta()`,
    `contactsMeta()`, `sponsorsMeta()`, `rostersMeta()`, `albumsMeta()`,
    and the drill-down `playersMeta(team, back)`/`photosMeta(album, back)`)
    rather than one bespoke render function per resource.
  - `openModal({fields, initialValues, onSave, validate, ...})` is the
    shared Create/Edit dialog — every section's `fields` array describes
    its form (`text`/`textarea`/`select`/`checkbox`/`multi`/`file`/
    `number`/`date`/`email`), including cross-field behavior via
    `visibleIf(form)` (Schedule's Location/Address only for Away games,
    Content Blocks' League Name only for the Logo generator) and a
    per-section `validate(values)` hook for constraints spanning multiple
    fields (News's opposite Published-date rules by Event type).
    Required-field checking is generic; `validate` only needs to handle
    what's specific to that section.
  - `openConfirm()` (a Delete confirmation dialog) and `showToast()`
    (a bottom-of-screen save/delete confirmation, auto-dismissing) are
    shared across every section, replacing the old per-section inline
    error/success text.
  - The nav is grouped into Content / Teams / Season / Administration
    (`NAV_GROUPS`, `SECTION_LABELS` in `app.js`), matching the mockup for
    the first three — a structural change from the old flat row of tabs.
    Administration (currently just Users) is the one group gated by
    permission rather than always shown: `initDashboard()` fetches the
    signed-in user's own Users row (`getCurrentEmail()` in `auth.js`
    decodes the id_token's `email` claim, then `GET /users/<email>`) and
    `hasSectionAccess()`/`SECTION_PERMISSION` hide any nav tab (not just
    Administration's) whose required permission the user lacks — `Admin`
    unlocks everything. This is UI convenience on top of the real
    enforcement, which is server-side (see `AdminAllowlist` in
    content-schemas.md) — hiding a tab isn't what stops a write, the
    Lambda's own permission check is.
  - **Schedule and Standings stay bespoke**, not on `renderGenericSection`,
    but both reuse the same shared `openModal()`/`openConfirm()`/
    `showToast()` primitives everything else uses, so editing still feels
    consistent. Schedule (`renderScheduleSection`) needs a List/Calendar
    toggle plus a team-filter that both views share, and a Season load
    control above everything else. Standings (`renderStandingsSection`) is
    a singleton cache row, not a keyed list — there's no per-school
    `/standings/<id>` endpoint, only `GET`/`POST /standings` (scrape
    refresh) and `PUT /standings` (replace `rows` wholesale) — so its Add/
    Edit/Delete modals all compute the *full* new `rows` array client-side
    (add one, splice one in-place by object identity, or filter one out)
    and `PUT` that whole array, rather than posting to a per-item path
    like every other section's generic `itemPath()`.
- **Infra**: Terraform, all under `infra/`. State is local
  (`infra/terraform.tfstate`) — fine for solo dev, move to an S3 backend
  before collaborating with anyone else.
