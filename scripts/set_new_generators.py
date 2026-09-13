#!/usr/bin/env python3
"""Sets generator="Sponsors" on the existing "Sponsors" Content Block (it
was a plain text block before; its body becomes the sponsors.html intro),
and creates a new "Photos" Content Block (which didn't exist before) with
generator="Photos" so both show up in the sidebar. See CLAUDE.md's
"Content Blocks -> page mapping" section.

Usage:
    python3 set_new_generators.py
"""
import uuid

import boto3

PROFILE = "basketball-website"
CONTENT_BLOCKS_TABLE = "basketball-website-ContentBlocks"


def main():
    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(CONTENT_BLOCKS_TABLE)

    blocks = table.scan().get("Items", [])
    by_title = {b.get("title"): b for b in blocks}
    max_order = max((int(b.get("order", 0)) for b in blocks), default=0)

    sponsors_block = by_title.get("Sponsors")
    if sponsors_block is None:
        print("No existing block titled 'Sponsors', skipping")
    else:
        sponsors_block["generator"] = "Sponsors"
        table.put_item(Item=sponsors_block)
        print("Set generator='Sponsors' on 'Sponsors'")

    if "Photos" in by_title:
        photos_block = by_title["Photos"]
        photos_block["generator"] = "Photos"
        table.put_item(Item=photos_block)
        print("'Photos' already exists, set generator='Photos'")
    else:
        table.put_item(
            Item={
                "block_id": str(uuid.uuid4()),
                "title": "Photos",
                "body": "",
                "image": "",
                "special": False,
                "generator": "Photos",
                "order": max_order + 1,
            }
        )
        print("Created 'Photos' with generator='Photos'")


if __name__ == "__main__":
    main()
