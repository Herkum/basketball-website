# Basketball Website

A public static site (rosters, schedule, news, coaches, contacts, content
blocks) backed by a serverless admin CMS for managing all of it. Admin login
is Google Sign-In via Amazon Cognito, restricted to an email allowlist
stored in DynamoDB. The public site needs no login — see "Public API" below.

## Architecture

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
  `contact.html`) sharing `site.js`/`site.css`; `frontend/admin/` is the
  separate admin SPA with its own `app.js`/`style.css`.
- **Public site layout**: every page uses a fixed left sidebar +
  central-column shell (`.layout` > `#site-sidebar` + `.central-column` >
  `#site-header` + `<main>`, see any page's HTML) — the header bar spans
  only the central column's width, not the sidebar, and the whole `.layout`
  is width-capped and centered (`max-width: 1400px`) so it doesn't stretch
  edge-to-edge on wide viewports. `initLayout()` in `site.js` builds both
  the header (from the `special` Content Block's body) and the sidebar nav
  (one link per non-`special` Content Block, in `order`) and is called by
  every `initXPage()` before it renders its own content.
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
  field (dropdown in the admin: None/Coaches/Rosters/Schedule/News/Contact
  Us) that drives a dedicated public page. `findBlockByGenerator(blocks,
  generator)` in `site.js` looks one up by that field (not by title, so the
  admin can rename a block freely) and renders its `body` as the page's
  intro and its `title` as the page's `<h1>` and sidebar label.
  `GENERATOR_PAGES`/`pageForGenerator()` map a generator value to its HTML
  file (`Rosters`→`rosters.html`, `Schedule`→`schedule.html`, etc.; no/
  unrecognized generator falls back to `index.html`). Blocks with no
  generator (`Home`, `Mission Statement`, `Sponsors`) are plain text
  sections rendered only on the home page, still looked up there by title
  via `findBlock(blocks, title)` since there's no dedicated page for them
  to be a generator of. `Header`'s body is the site name shown in the
  header bar — it's flagged `special`/NoIndex in the admin, which means
  "exclude from the sidebar nav" (the sidebar **is** the auto-generated
  content listing that flag was built for).
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
- **Auth**: Cognito User Pool federates with Google as an IdP. The SPA does
  Authorization Code + PKCE against Cognito's Hosted UI (no client secret in
  the browser). A Cognito post-authentication Lambda trigger
  (`backend/functions/post_auth_allowlist`) checks the authenticated email
  against the `AdminAllowlist` DynamoDB table and rejects sign-in if absent.
- **API**: API Gateway HTTP API, one Lambda per resource
  (`rosters`, `players`, `schedule`, `news`, `content_blocks`, `coaches`),
  all doing simple CRUD against their own DynamoDB table. Routes are
  declared per real HTTP method (GET/POST/PUT/DELETE), not `ANY` — see
  "Known gotchas" below for why.
- **Rosters/Players**: `rosters` is team-level (name, photo, drag-order,
  many-to-many `coach_ids`); `players` is a separate table keyed by
  `team_id`/`player_id` for the roster of individual players under a team.
  The admin UI's Rosters tab shows the team list, and a "Players" button per
  team opens a nested panel scoped to that `team_id` (`renderRostersSection`
  in `app.js`) — this mirrors the Coaches list's drag-to-reorder exactly.
- **Image uploads** (coach, team, and player photos): the browser crops an
  image client-side on a `<canvas>` (`frontend/admin/app.js`,
  `createImageField`), then uploads the canvas's blob directly to S3 via a
  presigned URL from the `uploads` Lambda (`backend/functions/uploads`,
  writes to `images/uploads/<uuid>.<ext>` — not entity-specific despite the
  older `images/coaches/...` objects still sitting in the bucket from before
  this was generalized). `createImageField` is generic — reused as-is for
  coaches, team photos, and player photos. Images live under `images/` in
  the same S3 bucket as the static site, so they're served
  publicly via CloudFront.
- **Infra**: Terraform, all under `infra/`. State is local
  (`infra/terraform.tfstate`) — fine for solo dev, move to an S3 backend
  before collaborating with anyone else.

## AWS access

- CLI profile: `basketball-website` (SSO via IAM Identity Center). Refresh
  with `aws sso login --profile basketball-website` when it expires.
- Terraform is configured to use this profile automatically
  (`infra/variables.tf` default), so `terraform plan`/`apply` just work once
  the SSO session is fresh.
- `infra/terraform.tfvars` (gitignored) holds the Google OAuth Client
  ID/Secret — ask the user for these if missing; don't invent placeholders.

## Deploying

```
cd infra
terraform plan -out=tfplan
terraform apply "tfplan"
```

A `null_resource.invalidate_cache` fires a CloudFront invalidation on every
apply that changes a static file or `admin/config.js`, so frontend changes go
live immediately after apply (no manual invalidation needed).

`admin/config.js` is **not** a static file in the repo for production — it's
rendered by Terraform from `frontend/admin/config.js.tpl`, injecting the real
deployed Cognito domain, client ID, API base URL, etc. Do not hand-edit the
deployed one; edit the `.tpl` and re-apply.

## Local frontend dev

No build step, so local dev is just serving `frontend/` directly:

```
cd frontend && python3 -m http.server 8000
```

Then open `http://127.0.0.1:8000/admin/index.html`. This works against the
**real deployed** Cognito/API/DynamoDB backend — there's no local backend.

This requires `frontend/admin/config.js` to exist as a real local file (it's
gitignored, never deployed — see the `static_files` exclusion in
`infra/s3_site.tf`, which explicitly skips `admin/config.js` so this local
file can never clobber the deployed templated one). If it's missing, recreate
it from the deployed one (`curl https://<cloudfront-domain>/admin/config.js`)
but override `redirectUri`/`logoutUri` to
`http://127.0.0.1:8000/admin/callback.html` and
`http://127.0.0.1:8000/admin/index.html`.

Cognito's app client `callback_urls`/`logout_urls` (in `infra/cognito.tf`)
already include both the production CloudFront URLs and the
`http://127.0.0.1:8000/...` local ones, so the full OAuth round-trip works
locally without any Google Console changes (Google only ever redirects back
to Cognito's own domain, never to the SPA directly).

Note: Cognito requires `https://` for callback/logout URLs except for the
literal hostname `localhost` — but `http://127.0.0.1:...` was tested and IS
accepted too, which is what's actually configured.

The public pages (`index.html`, `rosters.html`, etc.) need the same kind of
local override, but simpler: `frontend/config.js` (also gitignored, also
excluded from `static_files` in `infra/s3_site.tf`) just needs `apiBase`
and `siteOrigin` pointing at the real deployed values — no OAuth fields,
since every GET the public site makes is unauthenticated. If missing,
recreate from `curl https://<cloudfront-domain>/config.js`. New public
pages/features can and should be built and verified against
`http://127.0.0.1:8000/...` before ever touching `terraform apply` for the
S3/CloudFront side — the API itself has no "local" version so it's already
live either way, but the static files don't have to be.

`http://127.0.0.1:8000` is also in the CORS `allow_origins` on the API
Gateway HTTP API (`infra/api.tf`) and the S3 bucket's CORS config
(`infra/s3_site.tf`, needed for coach image uploads) — without these, the
browser blocks every fetch from the local dev origin even though the OAuth
login itself succeeds. If you ever change the local dev port from 8000,
update all three places (Cognito callback/logout URLs, API Gateway CORS, S3
CORS), not just `config.js`.

Backend (Lambda) changes still require `terraform apply` — there's no local
Lambda runtime. For quick one-off testing of a Lambda without redeploying
Terraform each time, `aws lambda invoke --profile basketball-website
--function-name basketball-website-<name> --payload '...' out.json` works
directly against the deployed function.

## Known gotchas (already fixed, but easy to reintroduce)

- **API Gateway CORS + `ANY` routes**: HTTP API's automatic CORS handling for
  `OPTIONS` preflight only works if no explicit route swallows `OPTIONS`.
  Routes must be declared per real method (GET/POST/PUT/DELETE), never `ANY`.
- **S3 presigned URLs need explicit region + SigV4**: `boto3.client("s3")`
  without `region_name` signs against S3's global endpoint, which
  307-redirects buckets outside `us-east-1` to their regional endpoint — a
  redirect a browser can't follow on a signed `PUT` (signature won't match
  the new host). Always construct the uploads Lambda's S3 client with
  `region_name=os.environ["AWS_REGION"]` and
  `Config(signature_version="s3v4")`.
- **`[hidden]` attribute vs. author CSS**: an author stylesheet rule like
  `.foo { display: flex }` beats the browser's default `[hidden] {
  display: none }` at equal specificity (author origin always wins over
  user-agent origin). `frontend/admin/style.css` has a blanket
  `[hidden] { display: none !important; }` rule to guard against this —
  don't remove it.
- **`<label>` wrapping a form control it isn't meant to submit**: a `<label>`
  forwards any click inside it to its associated form control. The Coaches
  "Photo" field wraps a file input AND a crop `<canvas>` — if that ever gets
  wrapped in a real `<label>` again, releasing a drag on the canvas will
  reopen the file picker. Keep it a plain `<div>` with a `<span>` caption
  (see `photo-field-group` in `app.js`/`style.css`).
- **Canvas dragging**: use Pointer Events (`pointerdown`/`setPointerCapture`)
  on the canvas itself, not `mousedown` + `window`-level `mousemove`/`mouseup`
  — the latter is more prone to "losing" the drag.
- **Never use `alert()`/`confirm()`/`prompt()` in the admin UI**: these block
  the whole tab, including for browser automation tools. Use an inline error
  element instead (see `errorEl` in `createImageField`).
- **Every editable form needs a "Cancel" button, shown only while
  `editing`/`editingTeam`/`editingPlayer` is set** (never on the plain
  Create form) — clicking it clears that variable and re-renders the form
  empty without saving. Added consistently across all six sections
  (Coaches, Rosters team + player, News, ContentBlocks, Contacts, Schedule)
  — replicate this `...(editing ? [cancelButton] : [])` pattern for any new
  section's form.
- **`.item-form label` beats a more specific-looking class on a `<label>`
  nested inside it**: `.item-form label { flex-direction: column }` has
  higher specificity than a lone `.checkbox-label { flex-direction: row }`
  (descendant selector with a type beats a single class), so a checkbox +
  text `<label class="checkbox-label">` inside any `.item-form` rendered
  stacked instead of inline until this was scoped as
  `.item-form .checkbox-label` in `style.css`. Same family of bug as the
  `[hidden]` one above — an author rule beating an author rule this time,
  not author-vs-UA, but the fix pattern (raise specificity to match the
  actual nesting) is the same.

## Content schemas

- `Rosters` (PK `team_id`): `name`, `image` (CloudFront URL, cropped the same
  way as coach photos), `coach_ids` (list of coach IDs — many-to-many with
  Coaches, displayed by cross-referencing on the client since DynamoDB has no
  joins), `order` (drag-to-reorder, same pattern as Coaches)
- `Players` (PK `team_id`, SK `player_id`): `first_name`, `last_name`,
  `number`, `height`, `year` (one of `Freshman`/`Sophomore`/`Junior`/`Senior`
  — see `PLAYER_YEARS` in `app.js`), `profile`, `image` (cropped the same
  way as coach/team photos). Listed via the Rosters tab's "Players" button
  for a given team, not its own top-level tab.
- `Schedule` (PK `season`, SK `game_id`): `date`, `time` (free text, not
  `type="time"` — schedules routinely say "TBA"), `opponent`, `home_away`,
  `address` (free text; rendered as a Google Maps search link —
  `mapsUrl()`/`https://www.google.com/maps/search/?api=1&query=...` — no
  geocoding, so it only needs to be something Maps can resolve, not
  precise lat/long), `team_id` (which roster this game belongs to, picked
  from a `<select>` populated via `/rosters`), `our_score`,
  `opponent_score`. Custom `renderScheduleSection` in `app.js`.
  Defaults to `defaultSeason()` on load instead of a blank
  type-a-season-and-click-Load screen. Displayed as a month calendar
  (`buildCalendar` in `app.js`), not a table — each game is a clickable chip
  on its date; clicking one loads it into the edit form (which gains
  Save/Delete/Cancel buttons only while editing) and scrolls the form into
  view. The create form above the calendar is unchanged for adding new
  games. `viewYear`/`viewMonth` re-center on the season's earliest game
  whenever a new season is loaded via the Season/Load control.
- `News` (PK `post_id`): `title`, `body` (textarea), `published_date`,
  `end_date` — both are `<input type="date">` with enforced ordering:
  `published_date` must be strictly after today, `end_date` strictly after
  whatever `published_date` currently holds (its `min` attribute updates
  live when `published_date` changes). Enforced both via the native HTML
  `min` attribute and a JS check on submit as a fallback. `image` (cropped
  the same way as every other photo field). Custom `renderNewsSection` in
  `app.js` — the cross-field min-date logic and image cropper don't fit a
  generic builder.
- `ContentBlocks` (PK `block_id`): `title`, `body` (textarea), `image`
  (cropped photo), `special` (boolean checkbox — flags a block as excluded
  from the public site's sidebar nav, see "Content Blocks → page mapping"
  above), `generator` (dropdown: None/Coaches/Rosters/Schedule/News/Contact
  Us — which dedicated public page this block drives, see same section),
  `order` (drag-to-reorder, same pattern as Coaches). Custom
  `renderContentBlocksSection` in
  `app.js` — this was the last user
  of the old generic `renderSimpleSection`/`buildForm`/`buildTable`/
  `renderKeyedSection` helpers, which were deleted once every section
  needed either a textarea, an image cropper, drag-to-reorder, or
  cross-field validation that the generic builders didn't support. There
  is no more generic CRUD builder in `app.js` — every section is its own
  `render*Section` function following the same hand-rolled pattern.
- `Coaches` (PK `coach_id`): `name`, `title`, `profile`, `image` (a CloudFront
  URL to the cropped photo in S3), `order` (integer, drag-to-reorder in the
  admin UI; the `coaches` Lambda sorts GET-list results by this field, and
  defaults it to a timestamp on create so new coaches land at the end;
  reordering rewrites `order` sequentially, 0-based, for every coach)
- `Contacts` (PK `contact_id`): `label` (free text, e.g. "General Info"),
  `type` (one of `Email`/`Physical Address`/`Instagram` — see
  `CONTACT_TYPES` in `app.js`; it's a fixed `<select>`, not free text, so
  adding a new contact type means updating that array), `value` (free-text
  textarea — holds an email, a full mailing address, or an @handle
  depending on `type`), `order` (drag-to-reorder, same pattern as Coaches).
  `renderContactsSection` in `app.js`.
- `AdminAllowlist` (PK `email`): admin emails permitted to log in. Manage
  with `scripts/seed_allowlist.py add|remove|list <email>` (uses the
  `.venv` in the repo root — `pip install boto3` into it if missing).

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

## Not yet done

- No custom domain — still on the CloudFront default `*.cloudfront.net` URL.
- Public-facing site content is still just a placeholder page.
- Terraform state is local only.
