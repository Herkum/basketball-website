# AWS access, deploying, and local dev

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
