#!/usr/bin/env python3
"""Generates a simple placeholder team photo for each existing roster (that
doesn't already have one) and uploads it, updating the roster's `image`
field. Real team photos should replace these later via the admin UI's
upload/crop flow - this is just so the roster list isn't missing photos.

Usage:
    python3 add_team_photos.py
"""
import io
import uuid

import boto3
from PIL import Image, ImageDraw, ImageFont

PROFILE = "basketball-website"
ROSTERS_TABLE = "basketball-website-Rosters"
BUCKET_NAME = "basketball-website-site-741458017127"
SITE_ORIGIN = "https://dt3ujgqjdxxfm.cloudfront.net"

TEAM_COLORS = {
    "Varsity": (30, 58, 95),
    "Junior Varsity": (140, 30, 40),
    "Frosh": (40, 110, 60),
}
DEFAULT_COLOR = (60, 60, 70)


def make_team_image(team_name):
    size = 480
    img = Image.new("RGB", (size, size), color=TEAM_COLORS.get(team_name, DEFAULT_COLOR))
    draw = ImageDraw.Draw(img)

    initials = "".join(word[0] for word in team_name.split()).upper()[:3]
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 180)
    except OSError:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), initials, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) / 2 - bbox[0], (size - text_h) / 2 - bbox[1]),
        initials,
        fill=(255, 255, 255),
        font=font,
    )

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=88)
    buffer.seek(0)
    return buffer


def main():
    session = boto3.Session(profile_name=PROFILE)
    dynamodb = session.resource("dynamodb")
    s3 = session.client("s3")
    rosters_table = dynamodb.Table(ROSTERS_TABLE)

    teams = rosters_table.scan().get("Items", [])
    for team in teams:
        if team.get("image"):
            print(f"Skipping '{team['name']}' - already has a photo")
            continue

        key = f"images/uploads/{uuid.uuid4()}.jpg"
        image_buffer = make_team_image(team["name"])
        s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=image_buffer, ContentType="image/jpeg")

        team["image"] = f"{SITE_ORIGIN}/{key}"
        rosters_table.put_item(Item=team)
        print(f"Added photo for '{team['name']}' -> {team['image']}")


if __name__ == "__main__":
    main()
