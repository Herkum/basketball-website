locals {
  google_idp_enabled = var.google_client_id != "" && var.google_client_secret != ""
}

resource "aws_cognito_user_pool" "admin" {
  name = "${var.project_name}-admin"

  auto_verified_attributes = ["email"]

  lambda_config {
    post_authentication = aws_lambda_function.post_auth_allowlist.arn
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    mutable             = true
    required            = true
  }
}

resource "aws_lambda_permission" "allow_cognito_invoke_post_auth" {
  statement_id  = "AllowCognitoInvokePostAuth"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_auth_allowlist.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.admin.arn
}

resource "aws_cognito_user_pool_domain" "admin" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.admin.id
}

# Google as a federated identity provider. Only created once Google OAuth
# credentials are supplied (see variables.tf) — deploy DynamoDB/S3/CloudFront
# first, add these vars, then re-apply to bring this online.
resource "aws_cognito_identity_provider" "google" {
  count         = local.google_idp_enabled ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.admin.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret     = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

resource "aws_cognito_user_pool_client" "admin_spa" {
  name         = "${var.project_name}-admin-spa"
  user_pool_id = aws_cognito_user_pool.admin.id

  generate_secret = false

  allowed_oauth_flows                 = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                = ["openid", "email", "profile"]

  # Admin session length: the SPA (auth.js) only ever stores the id_token and
  # uses its expires_in to know when to bounce back to the Hosted UI -- there's
  # no refresh-token flow, so this is the actual "how long am I logged in for"
  # knob. Bumped from Cognito's 60-minute default to 2 hours.
  id_token_validity     = 2
  access_token_validity = 2
  token_validity_units {
    id_token     = "hours"
    access_token = "hours"
  }

  supported_identity_providers = local.google_idp_enabled ? ["Google"] : ["COGNITO"]

  callback_urls = [
    "https://${aws_cloudfront_distribution.site.domain_name}/admin/callback.html",
    "https://${local.site_domain}/admin/callback.html",
    "http://127.0.0.1:8000/admin/callback.html",
  ]
  logout_urls = [
    "https://${aws_cloudfront_distribution.site.domain_name}/admin/index.html",
    "https://${local.site_domain}/admin/index.html",
    "http://127.0.0.1:8000/admin/index.html",
  ]

  depends_on = [aws_cognito_identity_provider.google]
}

output "cognito_hosted_ui_domain" {
  value = "https://${aws_cognito_user_pool_domain.admin.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.admin.id
}

output "cognito_app_client_id" {
  value = aws_cognito_user_pool_client.admin_spa.id
}

output "google_idp_redirect_uri_to_register_in_google_console" {
  description = "Add this exact URI as an authorized redirect URI on the Google OAuth client"
  value       = "https://${aws_cognito_user_pool_domain.admin.domain}.auth.${var.aws_region}.amazoncognito.com/oauth2/idpresponse"
}
