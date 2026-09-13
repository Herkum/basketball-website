terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

# us-east-1 provider alias: CloudFront + Cognito hosted UI custom certs must
# live in us-east-1 regardless of where the rest of the stack runs. Not used
# yet (no custom domain/cert today) but kept so it's a one-line addition later.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile
}
