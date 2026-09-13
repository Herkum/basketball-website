#!/usr/bin/env python3
"""Seeds Sponsors matching the design mockup's tiered sponsor list
(Banner/Court/Friend of the Program). Placeholder business names/sites,
same as every other seeded entity in this project - replace through the
admin UI once real sponsors are signed.

Usage:
    python3 seed_sponsors.py
"""
import time
import uuid

import boto3

PROFILE = "basketball-website"
SPONSORS_TABLE = "basketball-website-Sponsors"

SPONSORS = [
    ("Conejo Valley Orthodontics", "Orthodontics · Thousand Oaks", "https://conejovalleyortho.com", "Banner"),
    ("Reino Road Auto", "Service & repair · Newbury Park", "https://reinoroadauto.com", "Banner"),
    ("Borchard Family Dental", "Family dentistry", "https://borcharddental.com", "Court"),
    ("Thousand Oaks Print Co.", "Printing & signage", "https://toprintco.com", "Court"),
    ("Ventu Park Physical Therapy", "Sports rehabilitation", "https://ventuparkpt.com", "Court"),
    ("Panther Booster Club", "Parent organization", "https://npanthers.org/boosters", "Friend of the Program"),
    ("Newbury Park Coffee", "Café", "https://npcoffee.com", "Friend of the Program"),
    ("Dos Vientos Hardware", "Hardware", "https://dosvientoshardware.com", "Friend of the Program"),
    ("Lang & Wells Insurance", "Insurance", "https://langwells.com", "Friend of the Program"),
]


def main():
    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(SPONSORS_TABLE)

    existing = {i.get("name") for i in table.scan().get("Items", [])}
    base_order = int(time.time() * 1000)

    for i, (name, kind, website, tier) in enumerate(SPONSORS):
        if name in existing:
            print(f"'{name}' already exists, skipping")
            continue
        table.put_item(
            Item={
                "sponsor_id": str(uuid.uuid4()),
                "name": name,
                "kind": kind,
                "website": website,
                "tier": tier,
                "order": base_order + i,
            }
        )
        print(f"Created '{name}' ({tier})")


if __name__ == "__main__":
    main()
