#!/usr/bin/env python3
"""Backfills the `address` field on Schedule games:
  - Every "Home" game gets Newbury Park High School's address.
  - Every "Away" game gets its opponent's address, looked up from a mapping
    of verified real addresses (web-searched 2026-09-12; see CLAUDE.md).
  - Games whose opponent isn't in the mapping (currently just
    "San Gabriel Tournament" - host site couldn't be confirmed) are left
    untouched rather than guessed.

Usage:
    python3 backfill_addresses.py
"""
import boto3
from boto3.dynamodb.conditions import Key

PROFILE = "basketball-website"
SCHEDULE_TABLE = "basketball-website-Schedule"
SEASON = "2026-2027"

HOME_ADDRESS = "456 N Reino Rd, Newbury Park, CA 91320"

AWAY_ADDRESSES = {
    "Buena": "5670 Telegraph Rd, Ventura, CA 93003",
    "Buena JV Tournament": "5670 Telegraph Rd, Ventura, CA 93003",
    "Buena FS Tournament": "5670 Telegraph Rd, Ventura, CA 93003",
    "St. Bonaventure": "3167 Telegraph Rd, Ventura, CA 93003",
    "Malibu": "30215 Morning View Dr, Malibu, CA 90265",
    "Oak Park": "899 N Kanan Rd, Oak Park, CA 91377",
    "Nordhoff Varsity Tournament": "1401 Maricopa Hwy, Ojai, CA 93023",
    "Simi Valley": "5400 Cochran St, Simi Valley, CA 93063",
    "Simi Valley Showcase": "5400 Cochran St, Simi Valley, CA 93063",
    "Moorpark": "4500 Tierra Rejada Rd, Moorpark, CA 93021",
    "Royal": "1402 Royal Ave, Simi Valley, CA 93065",
    "Burroughs/Burbank": "1920 Clark Ave, Burbank, CA 91506",
    "AGBU/Canoga Park": "6844 Oakdale Ave, Canoga Park, CA 91306",
    "Mira Costa": "1401 Artesia Blvd, Manhattan Beach, CA 90266",
    "Westlake": "100 N Lakeview Canyon Rd, Westlake Village, CA 91362",
    "Oaks Christian": "31749 La Tienda Rd, Westlake Village, CA 91362",
    "Agoura": "28545 W Driver Ave, Agoura Hills, CA 91301",
    "Calabasas": "22855 W Mulholland Hwy, Calabasas, CA 91302",
    "Thousand Oaks": "2323 N Moorpark Rd, Thousand Oaks, CA 91360",
    "Camarillo": "4660 Mission Oaks Blvd, Camarillo, CA 93012",
    "Camarillo FS Tournament": "4660 Mission Oaks Blvd, Camarillo, CA 93012",
    "Oxnard": "3400 W Gonzales Rd, Oxnard, CA 93036",
    # "San Gabriel Tournament" intentionally omitted - host site unconfirmed
}


def main():
    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(SCHEDULE_TABLE)

    games = table.query(KeyConditionExpression=Key("season").eq(SEASON)).get("Items", [])

    updated, skipped = 0, []
    for game in games:
        if game.get("home_away") == "Home":
            address = HOME_ADDRESS
        else:
            address = AWAY_ADDRESSES.get(game.get("opponent"))

        if not address:
            skipped.append(f"{game['date']} vs {game.get('opponent')}")
            continue

        game["address"] = address
        table.put_item(Item=game)
        updated += 1

    print(f"Updated {updated}/{len(games)} games with an address")
    if skipped:
        print("Skipped (no known address):")
        for s in skipped:
            print(f"  - {s}")


if __name__ == "__main__":
    main()
