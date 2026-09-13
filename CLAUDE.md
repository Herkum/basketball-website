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

## Not yet done

- No custom domain — still on the CloudFront default `*.cloudfront.net` URL.
- Public-facing site content is still just a placeholder page.
- Terraform state is local only.
