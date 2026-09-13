#!/usr/bin/env python3
"""Creates the "Logo" Content Block (NoIndex, powers the sidebar's brand
block: logo image, site name, tagline, league name) and moves "Standings"
to sit directly under "Schedule" in the sidebar order.

Usage:
    python3 set_logo_block_and_reorder.py
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

    if "Logo" in by_title:
        block = by_title["Logo"]
        block["generator"] = "Logo"
        block["special"] = True
        table.put_item(Item=block)
        print("'Logo' already exists, set generator='Logo' and special=True")
    else:
        table.put_item(
            Item={
                "block_id": str(uuid.uuid4()),
                "title": "Newbury Park",
                "body": "Boys Basketball",
                "image": "",
                "special": True,
                "generator": "Logo",
                "league_name": "Marmonte League",
                "order": -1,
            }
        )
        print("Created 'Logo' (title='Newbury Park', body='Boys Basketball')")

    schedule_block = by_title.get("Schedule")
    standings_block = by_title.get("Standings")
    if schedule_block and standings_block:
        standings_block["order"] = int(schedule_block.get("order", 0)) + 1
        # shift every block that was at or after that order down one, so
        # Standings lands right after Schedule without colliding
        for b in blocks:
            if b["block_id"] == standings_block["block_id"]:
                continue
            if b.get("title") != "Schedule" and int(b.get("order", 0)) > int(schedule_block.get("order", 0)):
                b["order"] = int(b.get("order", 0)) + 1
                table.put_item(Item=b)
        table.put_item(Item=standings_block)
        print("Moved 'Standings' to sit directly under 'Schedule'")
    else:
        print("Could not find both 'Schedule' and 'Standings' blocks, skipping reorder")


if __name__ == "__main__":
    main()
