resource "aws_apigatewayv2_api" "admin" {
  name          = "${var.project_name}-admin-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [
      "https://${aws_cloudfront_distribution.site.domain_name}",
      "http://127.0.0.1:8000",
    ]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.admin.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.admin.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.project_name}-cognito-authorizer"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.admin_spa.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.admin.id}"
  }
}

locals {
  api_routes = {
    rosters = {
      function_key = "rosters"
      path         = "/rosters/{team_id}"
      list_path    = "/rosters"
    }
    players = {
      function_key = "players"
      path         = "/players/{team_id}/{player_id}"
      list_path    = "/players/{team_id}"
    }
    schedule = {
      function_key = "schedule"
      path         = "/schedule/{season}/{game_id}"
      list_path    = "/schedule/{season}"
    }
    news = {
      function_key = "news"
      path         = "/news/{post_id}"
      list_path    = "/news"
    }
    content_blocks = {
      function_key = "content_blocks"
      path         = "/content-blocks/{block_id}"
      list_path    = "/content-blocks"
    }
    coaches = {
      function_key = "coaches"
      path         = "/coaches/{coach_id}"
      list_path    = "/coaches"
    }
    contacts = {
      function_key = "contacts"
      path         = "/contacts/{contact_id}"
      list_path    = "/contacts"
    }
    sponsors = {
      function_key = "sponsors"
      path         = "/sponsors/{sponsor_id}"
      list_path    = "/sponsors"
    }
    albums = {
      function_key = "albums"
      path         = "/albums/{album_id}"
      list_path    = "/albums"
    }
    photos = {
      function_key = "photos"
      path         = "/photos/{album_id}/{photo_id}"
      list_path    = "/photos/{album_id}"
    }
  }
}

resource "aws_apigatewayv2_integration" "function_integration" {
  for_each               = local.api_routes
  api_id                 = aws_apigatewayv2_api.admin.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.function[each.value.function_key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "allow_apigw_invoke" {
  for_each      = local.api_routes
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function[each.value.function_key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.admin.execution_arn}/*/*"
}

locals {
  # HTTP APIs handle OPTIONS preflight automatically via cors_configuration
  # ONLY when no explicit route swallows it. Using "ANY" (which includes
  # OPTIONS) sends preflight through the JWT authorizer and breaks CORS, so
  # routes are declared per real HTTP method instead, leaving OPTIONS alone.
  methods = ["GET", "POST", "PUT", "DELETE"]

  # GET is public (the public site reads this content with no login);
  # POST/PUT/DELETE stay JWT-protected so only the admin can write.
  item_routes = merge([
    for name, r in local.api_routes : {
      for m in local.methods : "${name}-${m}" => {
        function_key = r.function_key
        path         = r.path
        method       = m
        public       = m == "GET"
      }
    }
  ]...)

  list_routes = merge([
    for name, r in local.api_routes : {
      for m in local.methods : "${name}-${m}" => {
        function_key = r.function_key
        path         = r.list_path
        method       = m
        public       = m == "GET"
      }
    }
  ]...)
}

resource "aws_apigatewayv2_route" "item_routes" {
  for_each  = local.item_routes
  api_id    = aws_apigatewayv2_api.admin.id
  route_key = "${each.value.method} ${each.value.path}"

  target              = "integrations/${aws_apigatewayv2_integration.function_integration[each.value.function_key].id}"
  authorization_type  = each.value.public ? "NONE" : "JWT"
  authorizer_id       = each.value.public ? null : aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "list_routes" {
  for_each  = local.list_routes
  api_id    = aws_apigatewayv2_api.admin.id
  route_key = "${each.value.method} ${each.value.path}"

  target              = "integrations/${aws_apigatewayv2_integration.function_integration[each.value.function_key].id}"
  authorization_type  = each.value.public ? "NONE" : "JWT"
  authorizer_id       = each.value.public ? null : aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_integration" "uploads" {
  api_id                 = aws_apigatewayv2_api.admin.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.uploads.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "allow_apigw_invoke_uploads" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.uploads.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.admin.execution_arn}/*/*"
}

resource "aws_apigatewayv2_route" "uploads" {
  api_id    = aws_apigatewayv2_api.admin.id
  route_key = "POST /uploads"

  target             = "integrations/${aws_apigatewayv2_integration.uploads.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# Standings is a singleton cache (GET the cached scrape, POST to trigger a
# fresh scrape) rather than a keyed list, so it doesn't fit the generic
# item/list route shape every other resource uses - bespoke here, same
# pattern as uploads above, reusing the standings Lambda from the generic
# `local.functions` map.
resource "aws_apigatewayv2_integration" "standings" {
  api_id                 = aws_apigatewayv2_api.admin.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.function["standings"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "allow_apigw_invoke_standings" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function["standings"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.admin.execution_arn}/*/*"
}

resource "aws_apigatewayv2_route" "standings_get" {
  api_id    = aws_apigatewayv2_api.admin.id
  route_key = "GET /standings"

  target             = "integrations/${aws_apigatewayv2_integration.standings.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "standings_post" {
  api_id    = aws_apigatewayv2_api.admin.id
  route_key = "POST /standings"

  target             = "integrations/${aws_apigatewayv2_integration.standings.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# PUT persists manually-edited rows (e.g. fixing a scrape error) without
# scraping, distinct from POST which triggers a fresh scrape.
resource "aws_apigatewayv2_route" "standings_put" {
  api_id    = aws_apigatewayv2_api.admin.id
  route_key = "PUT /standings"

  target             = "integrations/${aws_apigatewayv2_integration.standings.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

output "api_base_url" {
  value = aws_apigatewayv2_stage.default.invoke_url
}
