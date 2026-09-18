# Basketball Website

A public static site (rosters, schedule, news, coaches, contacts, content
blocks) backed by a serverless admin CMS for managing all of it. Admin login
is Google Sign-In via Amazon Cognito, restricted to an email allowlist
stored in DynamoDB. The public site needs no login — see "Public API" in
architecture.md below.

This file is split into topic files under `docs/` (imported below) to keep
any one file a manageable size — treat them as part of this same set of
project instructions, not optional background reading.

@docs/architecture.md
@docs/aws-and-deploy.md
@docs/gotchas.md
@docs/content-schemas.md

## Local dev quick start

```
cd frontend && python3 -m http.server 8000
```

Then open `http://127.0.0.1:8000/index.html` (public site) or
`http://127.0.0.1:8000/admin/index.html` (admin). Runs against the real
deployed API/Cognito/DynamoDB — there's no local backend. Requires
`frontend/config.js`/`frontend/admin/config.js` to exist locally (gitignored)
— see "Local frontend dev" in aws-and-deploy.md if either is missing.

## Not yet done

- No custom domain — still on the CloudFront default `*.cloudfront.net` URL.
- Public-facing site content is still just a placeholder page.
- Terraform state is local only.
- Every `backend/functions/*/handler.py` duplicates its own `DecimalEncoder`/
  `_response` boilerplate, and now also its own `_caller_permissions()`
  (looks up the JWT-authenticated caller's row in `AdminAllowlist`/Users to
  gate writes — see `Administration → Users` in content-schemas.md) — by
  deliberate convention, there's no shared Lambda layer, each function is
  packaged independently via `infra/lambda.tf`'s per-directory
  `archive_file`. Worth a follow-up: add a Lambda layer (or a shared source
  dir merged into each function's zip at build time) holding
  `DecimalEncoder`/`_response`/`_caller_permissions`, then trim them out of
  every handler — but that's a packaging/infra change, not a drop-in code
  edit, so it hasn't been done opportunistically alongside feature work.
- `frontend/admin/app.js`'s generic `renderGenericSection()` table-paint
  (sortable headers, flag/strong/muted cell rendering, row Edit/Delete
  actions) is independently reimplemented a second and third time in
  Schedule's `paintList()` and Standings' `paintTable()`, since both stay
  off the generic engine for real reasons (Schedule needs a List/Calendar
  toggle + team filter; Standings is a singleton bulk-`PUT` cache, not a
  per-item REST resource). A future cleanup could factor just the
  row/cell/actions painting into a shared `paintTable(container, columns,
  rows, {onEdit, onDelete, sort})` helper reused by all three, leaving each
  renderer only its genuinely bespoke parts — deferred for now since it
  touches all three renderers' control flow and wasn't worth the
  regression risk to do opportunistically.
