#!/usr/bin/env python3
"""Populates Contacts to match the mockup's kind/role grouping (Program/
School/Boosters/Social) - sets kind/role on the 3 existing contacts and
adds coach/office/booster entries. Placeholder values throughout, same as
every other seeded entity in this project - replace through the admin UI
once real values are known.

Usage:
    python3 set_contacts_format.py
"""
import time
import uuid

import boto3

PROFILE = "basketball-website"
CONTACTS_TABLE = "basketball-website-Contacts"

EXISTING_UPDATES = {
    "General Inquiries": {"kind": "School", "role": "General inquiries"},
    "Arena / Gym Location": {"kind": "School", "role": "Home venue"},
    "Follow Us": {"kind": "Social", "role": "Game nights and results"},
}

NEW_CONTACTS = [
    {
        "label": "Jane Smith",
        "kind": "Program",
        "role": "Head Coach",
        "type": "Email",
        "value": "jsmith@npanthers.org",
    },
    {
        "label": "Jack",
        "kind": "Program",
        "role": "JV Coach",
        "type": "Email",
        "value": "jack@npanthers.org",
    },
    {
        "label": "Athletics Office",
        "kind": "School",
        "role": "Eligibility, clearance, transcripts",
        "type": "Phone",
        "value": "(805) 498-3676",
    },
    {
        "label": "Panther Booster Club",
        "kind": "Boosters",
        "role": "Sponsorship, fundraising, volunteers",
        "type": "Email",
        "value": "boosters@npanthers.org",
    },
]


def main():
    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(CONTACTS_TABLE)

    items = table.scan().get("Items", [])
    by_label = {i.get("label"): i for i in items}
    max_order = max((int(i.get("order", 0)) for i in items), default=0)

    for label, fields in EXISTING_UPDATES.items():
        item = by_label.get(label)
        if item is None:
            print(f"No existing contact labeled '{label}', skipping")
            continue
        item.update(fields)
        table.put_item(Item=item)
        print(f"Updated '{label}' -> kind={fields['kind']}, role={fields['role']}")

    for i, contact in enumerate(NEW_CONTACTS, start=1):
        if contact["label"] in by_label:
            print(f"'{contact['label']}' already exists, skipping create")
            continue
        table.put_item(
            Item={
                "contact_id": str(uuid.uuid4()),
                "order": max_order + i,
                **contact,
            }
        )
        print(f"Created '{contact['label']}' ({contact['kind']})")


if __name__ == "__main__":
    main()
