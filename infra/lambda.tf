locals {
  functions = {
    rosters = {
      dir        = "rosters"
      table_arn  = aws_dynamodb_table.rosters.arn
      table_name = aws_dynamodb_table.rosters.name
    }
    schedule = {
      dir        = "schedule"
      table_arn  = aws_dynamodb_table.schedule.arn
      table_name = aws_dynamodb_table.schedule.name
    }
    news = {
      dir        = "news"
      table_arn  = aws_dynamodb_table.news.arn
      table_name = aws_dynamodb_table.news.name
    }
    content_blocks = {
      dir        = "content_blocks"
      table_arn  = aws_dynamodb_table.content_blocks.arn
      table_name = aws_dynamodb_table.content_blocks.name
    }
    coaches = {
      dir        = "coaches"
      table_arn  = aws_dynamodb_table.coaches.arn
      table_name = aws_dynamodb_table.coaches.name
    }
    players = {
      dir        = "players"
      table_arn  = aws_dynamodb_table.players.arn
      table_name = aws_dynamodb_table.players.name
    }
    contacts = {
      dir        = "contacts"
      table_arn  = aws_dynamodb_table.contacts.arn
      table_name = aws_dynamodb_table.contacts.name
    }
    sponsors = {
      dir        = "sponsors"
      table_arn  = aws_dynamodb_table.sponsors.arn
      table_name = aws_dynamodb_table.sponsors.name
    }
    albums = {
      dir        = "albums"
      table_arn  = aws_dynamodb_table.albums.arn
      table_name = aws_dynamodb_table.albums.name
    }
    photos = {
      dir        = "photos"
      table_arn  = aws_dynamodb_table.photos.arn
      table_name = aws_dynamodb_table.photos.name
    }
    standings = {
      dir        = "standings"
      table_arn  = aws_dynamodb_table.standings.arn
      table_name = aws_dynamodb_table.standings.name
      # scrapes an external page (MaxPreps) - needs more than the default
      # 10s other resources' simple DynamoDB CRUD calls get.
      timeout = 20
    }
  }
}

data "archive_file" "function_zip" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${path.module}/../backend/functions/${each.value.dir}"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_iam_role" "function_role" {
  for_each = local.functions
  name     = "${var.project_name}-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "function_policy" {
  for_each = local.functions
  name     = "${var.project_name}-${each.key}-policy"
  role     = aws_iam_role.function_role[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = each.value.table_arn
      }
    ]
  })
}

resource "aws_lambda_function" "function" {
  for_each = local.functions

  function_name    = "${var.project_name}-${each.key}"
  role             = aws_iam_role.function_role[each.key].arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.function_zip[each.key].output_path
  source_code_hash = data.archive_file.function_zip[each.key].output_base64sha256
  timeout          = lookup(each.value, "timeout", 10)

  environment {
    variables = {
      TABLE_NAME = each.value.table_name
    }
  }
}

# --- Cognito post-authentication trigger Lambda ---

data "archive_file" "post_auth_allowlist_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/functions/post_auth_allowlist"
  output_path = "${path.module}/build/post_auth_allowlist.zip"
}

resource "aws_iam_role" "post_auth_allowlist_role" {
  name = "${var.project_name}-post-auth-allowlist"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "post_auth_allowlist_policy" {
  name = "${var.project_name}-post-auth-allowlist-policy"
  role = aws_iam_role.post_auth_allowlist_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.admin_allowlist.arn
      }
    ]
  })
}

resource "aws_lambda_function" "post_auth_allowlist" {
  function_name    = "${var.project_name}-post-auth-allowlist"
  role             = aws_iam_role.post_auth_allowlist_role.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.post_auth_allowlist_zip.output_path
  source_code_hash = data.archive_file.post_auth_allowlist_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      ALLOWLIST_TABLE_NAME = aws_dynamodb_table.admin_allowlist.name
    }
  }
}

# --- Presigned S3 upload URL generator (used by the admin image cropper) ---

data "archive_file" "uploads_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/functions/uploads"
  output_path = "${path.module}/build/uploads.zip"
}

resource "aws_iam_role" "uploads_role" {
  name = "${var.project_name}-uploads"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "uploads_policy" {
  name = "${var.project_name}-uploads-policy"
  role = aws_iam_role.uploads_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.site.arn}/images/*"
      }
    ]
  })
}

resource "aws_lambda_function" "uploads" {
  function_name    = "${var.project_name}-uploads"
  role             = aws_iam_role.uploads_role.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.uploads_zip.output_path
  source_code_hash = data.archive_file.uploads_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      BUCKET_NAME = aws_s3_bucket.site.id
    }
  }
}
