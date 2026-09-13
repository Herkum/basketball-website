import json
import os
import uuid

import boto3
from botocore.client import Config

# Explicit region_name is required: without it boto3 signs against S3's
# global endpoint, which 307-redirects buckets outside us-east-1 to their
# regional endpoint - a redirect a browser can't safely follow on a signed
# PUT (the signature doesn't match the new host), surfacing as an opaque
# "Failed to fetch". us-west-2 (like most regions) also requires SigV4.
s3 = boto3.client(
    "s3",
    region_name=os.environ["AWS_REGION"],
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
)
BUCKET_NAME = os.environ["BUCKET_NAME"]

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    body = json.loads(event.get("body") or "{}")
    content_type = body.get("content_type", "image/jpeg")

    if content_type not in ALLOWED_CONTENT_TYPES:
        return _response(400, {"error": f"unsupported content_type: {content_type}"})

    extension = content_type.split("/")[-1]
    # Shared endpoint for coach/team/player photos - not entity-specific.
    key = f"images/uploads/{uuid.uuid4()}.{extension}"

    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET_NAME, "Key": key, "ContentType": content_type},
        ExpiresIn=300,
    )

    return _response(200, {"uploadUrl": upload_url, "key": key})
