variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "AWS CLI profile to use"
  type        = string
  default     = "basketball-website"
}

variable "project_name" {
  description = "Short name used as a prefix for resource names"
  type        = string
  default     = "basketball-website"
}

variable "google_client_id" {
  description = "OAuth 2.0 Client ID from Google Cloud Console (Sign in with Google). Leave blank until ready to deploy Cognito's Google IdP (step 4 of the build)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_secret" {
  description = "OAuth 2.0 Client Secret from Google Cloud Console (Sign in with Google). Leave blank until ready to deploy Cognito's Google IdP (step 4 of the build)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cognito_domain_prefix" {
  description = "Prefix for the Cognito Hosted UI domain (must be globally unique): <prefix>.auth.<region>.amazoncognito.com"
  type        = string
  default     = "basketball-website-admin"
}
