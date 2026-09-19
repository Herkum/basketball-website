resource "aws_s3_bucket" "site" {
  bucket = "${var.project_name}-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [
      "https://${aws_cloudfront_distribution.site.domain_name}",
      "https://${local.site_domain}",
      "https://${local.site_domain_www}",
      "http://127.0.0.1:8000",
    ]
    allowed_headers = ["content-type"]
    max_age_seconds = 3000
  }
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.project_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [local.site_domain, local.site_domain_www]

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  # SPA-friendly: unknown paths fall back to index.html
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
          }
        }
      }
    ]
  })
}

data "aws_caller_identity" "current" {}

locals {
  frontend_dir = "${path.module}/../frontend"
  content_types = {
    ".html" = "text/html"
    ".js"   = "application/javascript"
    ".css"  = "text/css"
  }
  # every static asset except .tpl templates (rendered separately below) and
  # the local-dev config.js files (real local files for `python3 -m
  # http.server` dev that must never overwrite the deployed, templated
  # config.js objects)
  static_files = [
    for f in fileset(local.frontend_dir, "**/*") : f
    if !endswith(f, ".tpl") && f != "admin/config.js" && f != "config.js"
  ]
}

resource "aws_s3_object" "static_files" {
  for_each     = toset(local.static_files)
  bucket       = aws_s3_bucket.site.id
  key          = each.value
  source       = "${local.frontend_dir}/${each.value}"
  etag         = filemd5("${local.frontend_dir}/${each.value}")
  content_type = lookup(local.content_types, regex("\\.[^.]+$", each.value), "application/octet-stream")
}

# Injects deployed infra values (Cognito domain, client id, API base URL) into
# the admin SPA without hardcoding them in the repo.
resource "aws_s3_object" "admin_config" {
  bucket = aws_s3_bucket.site.id
  key    = "admin/config.js"
  content = templatefile("${local.frontend_dir}/admin/config.js.tpl", {
    cognito_domain = "https://${aws_cognito_user_pool_domain.admin.domain}.auth.${var.aws_region}.amazoncognito.com"
    client_id      = aws_cognito_user_pool_client.admin_spa.id
    api_base       = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
    redirect_uri   = "https://${local.site_domain}/admin/callback.html"
    logout_uri     = "https://${local.site_domain}/admin/index.html"
    site_origin    = "https://${local.site_domain}"
  })
  content_type = "application/javascript"
}


# Public site config (apiBase/siteOrigin only - no login on the public
# site, so no Cognito fields needed here).
resource "aws_s3_object" "public_config" {
  bucket = aws_s3_bucket.site.id
  key    = "config.js"
  content = templatefile("${local.frontend_dir}/config.js.tpl", {
    api_base    = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
    site_origin = "https://${local.site_domain}"
  })
  content_type = "application/javascript"
}

resource "null_resource" "invalidate_cache" {
  triggers = {
    static_files_hash  = sha1(join(",", [for f in local.static_files : filemd5("${local.frontend_dir}/${f}")]))
    config_hash        = aws_s3_object.admin_config.content
    public_config_hash = aws_s3_object.public_config.content
  }

  provisioner "local-exec" {
    command = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.site.id} --paths '/*' --profile ${var.aws_profile}"
  }

  depends_on = [aws_s3_object.static_files, aws_s3_object.admin_config, aws_s3_object.public_config]
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "s3_bucket_name" {
  value = aws_s3_bucket.site.id
}
