#!/usr/bin/env python3
"""Seeds the Locations table from the real schools our Away opponents play
at, then links each matching Schedule game to its new location_id.

Addresses were web-verified 2026-09-15 (see chat history / commit message).
Tournament-named opponents (e.g. "Buena JV Tournament") map to their single
host school - one Location per real physical school, not per tournament
label. "San Gabriel Tournament" is intentionally left unmapped - its host
school could not be confirmed (same as the earlier backfill_addresses.py).

Usage:
    python3 seed_locations.py
"""
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key

PROFILE = "basketball-website"
LOCATIONS_TABLE = "basketball-website-Locations"
SCHEDULE_TABLE = "basketball-website-Schedule"
SEASON = "2026-2027"

# name -> address, one per real physical school/venue.
LOCATIONS = {
    "3 Ball Academy": "721 Cliff Drive, Santa Barbara, CA 93109",
    "AGBU Manoogian-Demirdjian School": "6844 Oakdale Ave, Canoga Park, CA 91306",
    "Agoura High School": "28545 W Driver Ave, Agoura Hills, CA 91301",
    "Buena High School": "5670 Telegraph Rd, Ventura, CA 93003",
    "Calabasas High School": "22855 W Mulholland Hwy, Calabasas, CA 91302",
    "Adolfo Camarillo High School": "4660 Mission Oaks Blvd, Camarillo, CA 93012",
    "Mira Costa High School": "1401 Artesia Blvd, Manhattan Beach, CA 90266",
    "Moorpark High School": "4500 Tierra Rejada Rd, Moorpark, CA 93021",
    "Nordhoff High School": "1401 Maricopa Hwy, Ojai, CA 93023",
    "Oaks Christian School": "31749 La Tienda Rd, Westlake Village, CA 91362",
    "Oxnard High School": "3400 W Gonzales Rd, Oxnard, CA 93036",
    "Simi Valley High School": "5400 Cochran St, Simi Valley, CA 93063",
    "Thousand Oaks High School": "2323 N Moorpark Rd, Thousand Oaks, CA 91360",
    "Ventura High School": "2 N Catalina St, Ventura, CA 93001",
    "Westlake High School": "100 N Lakeview Canyon Rd, Westlake Village, CA 91362",
}

# Schedule `opponent` value -> Locations key above. Opponents not listed
# here (currently just "San Gabriel Tournament") are left untouched.
OPPONENT_TO_LOCATION = {
    "3 Ball Academy": "3 Ball Academy",
    "AGBU/Canoga Park": "AGBU Manoogian-Demirdjian School",
    "Agoura": "Agoura High School",
    "Buena": "Buena High School",
    "Buena FS Tournament": "Buena High School",
    "Buena JV Tournament": "Buena High School",
    "Calabasas": "Calabasas High School",
    "Camarillo": "Adolfo Camarillo High School",
    "Camarillo FS Tournament": "Adolfo Camarillo High School",
    "Mira Costa": "Mira Costa High School",
    "Moorpark": "Moorpark High School",
    "Nordhoff Varsity Tournament": "Nordhoff High School",
    "Oaks Christian": "Oaks Christian School",
    "Oxnard": "Oxnard High School",
    "Simi Valley Showcase": "Simi Valley High School",
    "Thousand Oaks": "Thousand Oaks High School",
    "Ventura": "Ventura High School",
    "Westlake": "Westlake High School",
}


def main():
    session = boto3.Session(profile_name=PROFILE)
    dynamodb = session.resource("dynamodb")
    locations_table = dynamodb.Table(LOCATIONS_TABLE)
    schedule_table = dynamodb.Table(SCHEDULE_TABLE)

    name_to_id = {}
    for i, (name, address) in enumerate(LOCATIONS.items()):
        location_id = str(uuid.uuid4())
        locations_table.put_item(
            Item={
                "location_id": location_id,
                "name": name,
                "address": address,
                "order": int(time.time() * 1000) + i,
            }
        )
        name_to_id[name] = location_id
        print(f"Created location: {name} ({address})")

    games = schedule_table.query(KeyConditionExpression=Key("season").eq(SEASON)).get("Items", [])
    linked, skipped = 0, []
    for game in games:
        if game.get("home_away") != "Away":
            continue
        location_name = OPPONENT_TO_LOCATION.get(game.get("opponent"))
        if not location_name:
            skipped.append(f"{game['date']} vs {game.get('opponent')}")
            continue
        game["location_id"] = name_to_id[location_name]
        game["location"] = location_name
        game["address"] = LOCATIONS[location_name]
        schedule_table.put_item(Item=game)
        linked += 1

    print(f"\nLinked {linked} Away games to a Location")
    if skipped:
        print("Skipped (no known host school):")
        for s in skipped:
            print(f"  - {s}")


if __name__ == "__main__":
    main()
