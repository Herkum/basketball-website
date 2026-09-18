resource "aws_dynamodb_table" "rosters" {
  name         = "${var.project_name}-Rosters"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "team_id"

  attribute {
    name = "team_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "players" {
  name         = "${var.project_name}-Players"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "team_id"
  range_key    = "player_id"

  attribute {
    name = "team_id"
    type = "S"
  }

  attribute {
    name = "player_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "schedule" {
  name         = "${var.project_name}-Schedule"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "season"
  range_key    = "game_id"

  attribute {
    name = "season"
    type = "S"
  }

  attribute {
    name = "game_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "news" {
  name         = "${var.project_name}-News"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "post_id"

  attribute {
    name = "post_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "content_blocks" {
  name         = "${var.project_name}-ContentBlocks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "block_id"

  attribute {
    name = "block_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "coaches" {
  name         = "${var.project_name}-Coaches"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "coach_id"

  attribute {
    name = "coach_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "contacts" {
  name         = "${var.project_name}-Contacts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "contact_id"

  attribute {
    name = "contact_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "sponsors" {
  name         = "${var.project_name}-Sponsors"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sponsor_id"

  attribute {
    name = "sponsor_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "albums" {
  name         = "${var.project_name}-Albums"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "album_id"

  attribute {
    name = "album_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "photos" {
  name         = "${var.project_name}-Photos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "album_id"
  range_key    = "photo_id"

  attribute {
    name = "album_id"
    type = "S"
  }

  attribute {
    name = "photo_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "standings" {
  name         = "${var.project_name}-Standings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "cache_id"

  attribute {
    name = "cache_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "admin_allowlist" {
  name         = "${var.project_name}-AdminAllowlist"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }
}

resource "aws_dynamodb_table" "locations" {
  name         = "${var.project_name}-Locations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "location_id"

  attribute {
    name = "location_id"
    type = "S"
  }
}
