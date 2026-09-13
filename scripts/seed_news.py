#!/usr/bin/env python3
"""Seeds a few random News posts, each with a generated placeholder photo
(same style as scripts/add_team_photos.py). Real photos/copy should replace
these later through the admin UI's normal upload/crop flow.

Usage:
    python3 seed_news.py
"""
import io
import uuid

import boto3
from PIL import Image, ImageDraw, ImageFont

PROFILE = "basketball-website"
NEWS_TABLE = "basketball-website-News"
BUCKET_NAME = "basketball-website-site-741458017127"
SITE_ORIGIN = "https://dt3ujgqjdxxfm.cloudfront.net"

POSTS = [
    {
        "title": "Season Tip-Off Set for November 16",
        "body": "All three levels open their 2026-2027 season on the road at Buena. "
        "Come support the team as they kick off a new year of Panther basketball.",
        "published_date": "2026-09-20",
        "end_date": "2026-11-16",
        "color": (30, 58, 95),
        "label": "TIP-OFF",
    },
    {
        "title": "New Gym Bleachers Installed",
        "body": "Over the summer, the athletics department completed an upgrade to the "
        "home gym's bleacher seating, adding capacity for home games this season.",
        "published_date": "2026-09-25",
        "end_date": "2026-10-15",
        "color": (140, 30, 40),
        "label": "GYM",
    },
    {
        "title": "Youth Basketball Clinic Announced",
        "body": "Varsity and JV players will host a free youth clinic for local elementary "
        "and middle school players ahead of the season. Details on sign-ups to follow.",
        "published_date": "2026-10-01",
        "end_date": "2026-11-01",
        "color": (40, 110, 60),
        "label": "CLINIC",
    },
    {
        "title": "Booster Club Season Kickoff Meeting",
        "body": "The basketball booster club will hold its season kickoff meeting to "
        "coordinate concessions, team meals, and fundraising for the year.",
        "published_date": "2026-09-18",
        "end_date": "2026-10-05",
        "color": (90, 70, 130),
        "label": "BOOSTERS",
    },
]


def make_news_image(label, color):
    size = 480
    img = Image.new("RGB", (size, size), color=color)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 56)
    except OSError:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), label, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) / 2 - bbox[0], (size - text_h) / 2 - bbox[1]),
        label,
        fill=(255, 255, 255),
        font=font,
    )

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=88)
    buffer.seek(0)
    return buffer


def main():
    session = boto3.Session(profile_name=PROFILE)
    news_table = session.resource("dynamodb").Table(NEWS_TABLE)
    s3 = session.client("s3")

    for post in POSTS:
        key = f"images/uploads/{uuid.uuid4()}.jpg"
        image_buffer = make_news_image(post["label"], post["color"])
        s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=image_buffer, ContentType="image/jpeg")

        news_table.put_item(
            Item={
                "post_id": str(uuid.uuid4()),
                "title": post["title"],
                "body": post["body"],
                "published_date": post["published_date"],
                "end_date": post["end_date"],
                "image": f"{SITE_ORIGIN}/{key}",
            }
        )
        print(f"Added '{post['title']}'")


if __name__ == "__main__":
    main()
