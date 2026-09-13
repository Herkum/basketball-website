#!/usr/bin/env python3
"""Creates the "Standings" Content Block (didn't exist before) with
generator="Standings" so it shows up in the sidebar and links to
standings.html. See CLAUDE.md's "Content Blocks -> page mapping" section.

Usage:
    python3 set_standings_generator.py
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

    if "Standings" in by_title:
        block = by_title["Standings"]
        block["generator"] = "Standings"
        table.put_item(Item=block)
        print("'Standings' already exists, set generator='Standings'")
    else:
        table.put_item(
            Item={
                "block_id": str(uuid.uuid4()),
                "title": "Standings",
                "body": "",
                "image": "",
                "special": False,
                "generator": "Standings",
                "order": max_order + 1,
            }
        )
        print("Created 'Standings' with generator='Standings'")


if __name__ == "__main__":
    main()
