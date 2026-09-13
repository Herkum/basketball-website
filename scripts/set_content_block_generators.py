#!/usr/bin/env python3
"""Sets the `generator` field on the Content Blocks that drive a public
site page (Rosters/Schedule/Coaches), and creates the two that don't exist
yet (News, Contact Us) so the sidebar nav has a complete set of pages to
link to. See CLAUDE.md's "Content Blocks -> page mapping" section.

Usage:
    python3 set_content_block_generators.py
"""
import time
import uuid

import boto3

PROFILE = "basketball-website"
CONTENT_BLOCKS_TABLE = "basketball-website-ContentBlocks"

# title -> generator, for blocks that should already exist
EXISTING_GENERATORS = {
    "Rosters": "Rosters",
    "Schedule": "Schedule",
    "Coaches": "Coaches",
}

# (title, generator) for blocks to create if missing
NEW_BLOCKS = [
    ("News", "News"),
    ("Contact Us", "Contact Us"),
]


def main():
    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(CONTENT_BLOCKS_TABLE)

    blocks = table.scan().get("Items", [])
    by_title = {b.get("title"): b for b in blocks}

    for title, generator in EXISTING_GENERATORS.items():
        block = by_title.get(title)
        if block is None:
            print(f"No existing block titled '{title}', skipping")
            continue
        block["generator"] = generator
        table.put_item(Item=block)
        print(f"Set generator='{generator}' on '{title}'")

    for title, generator in NEW_BLOCKS:
        if title in by_title:
            print(f"'{title}' already exists, skipping create")
            continue
        table.put_item(
            Item={
                "block_id": str(uuid.uuid4()),
                "title": title,
                "body": "",
                "image": "",
                "special": False,
                "generator": generator,
                "order": int(time.time() * 1000),
            }
        )
        print(f"Created '{title}' with generator='{generator}'")


if __name__ == "__main__":
    main()
