#!/usr/bin/env python3
"""Add or remove admin emails from the AdminAllowlist DynamoDB table.

Usage:
    python3 seed_allowlist.py add someone@example.com
    python3 seed_allowlist.py remove someone@example.com
    python3 seed_allowlist.py list
"""
import sys

import boto3

PROFILE = "basketball-website"
TABLE_NAME = "basketball-website-AdminAllowlist"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(TABLE_NAME)

    command = sys.argv[1]

    if command == "list":
        items = table.scan().get("Items", [])
        for item in items:
            print(item["email"])
        return

    if command in ("add", "remove") and len(sys.argv) == 3:
        email = sys.argv[2].strip().lower()
        if command == "add":
            table.put_item(Item={"email": email})
            print(f"Added {email}")
        else:
            table.delete_item(Key={"email": email})
            print(f"Removed {email}")
        return

    print(__doc__)
    sys.exit(1)


if __name__ == "__main__":
    main()
