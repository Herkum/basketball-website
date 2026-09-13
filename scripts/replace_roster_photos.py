#!/usr/bin/env python3
"""Replaces every roster's `image` with test-assets/test-roster.jpg (a wide
team-photo placeholder), uploading it once to S3 and pointing all teams at
the same URL. Deletes the old per-team placeholder images it replaces.

Usage:
    python3 replace_roster_photos.py
"""
import uuid

import boto3

PROFILE = "basketball-website"
ROSTERS_TABLE = "basketball-website-Rosters"
BUCKET_NAME = "basketball-website-site-741458017127"
SITE_ORIGIN = "https://dt3ujgqjdxxfm.cloudfront.net"
IMAGE_PATH = "test-assets/test-roster.jpg"


def main():
    session = boto3.Session(profile_name=PROFILE)
    dynamodb = session.resource("dynamodb")
    s3 = session.client("s3")
    rosters_table = dynamodb.Table(ROSTERS_TABLE)

    key = f"images/uploads/{uuid.uuid4()}.jpg"
    with open(IMAGE_PATH, "rb") as f:
        s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=f, ContentType="image/jpeg")
    new_url = f"{SITE_ORIGIN}/{key}"
    print(f"Uploaded {IMAGE_PATH} -> {new_url}")

    teams = rosters_table.scan().get("Items", [])
    old_keys = []
    for team in teams:
        old_image = team.get("image", "")
        if old_image.startswith(SITE_ORIGIN):
            old_keys.append(old_image[len(SITE_ORIGIN) + 1 :])

        team["image"] = new_url
        rosters_table.put_item(Item=team)
        print(f"Updated '{team['name']}' -> {new_url}")

    for old_key in old_keys:
        s3.delete_object(Bucket=BUCKET_NAME, Key=old_key)
        print(f"Deleted old image {old_key}")


if __name__ == "__main__":
    main()
