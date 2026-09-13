#!/usr/bin/env python3
"""One-off backfill: adds `time` and `team_id` (Varsity) to the 28 games
seeded by seed_schedule.py, using the times scraped alongside the original
dates/opponents (not stored at the time since the schema had no `time`
field yet). `address` is intentionally left blank - the scrape only had
"Gym"/"TBA"/tournament names, not real street addresses; fill those in
through the admin UI as they're confirmed.

Usage:
    python3 backfill_schedule_time_team.py
"""
import boto3

PROFILE = "basketball-website"
SCHEDULE_TABLE = "basketball-website-Schedule"
ROSTERS_TABLE = "basketball-website-Rosters"
SEASON = "2026-2027"
TEAM_NAME = "Varsity"

# date ISO -> time, as scraped from nphsathletics.org on 2026-09-12
TIMES = {
    "2026-11-16": "7:00 PM",
    "2026-11-17": "7:00 PM",
    "2026-11-20": "7:00 PM",
    "2026-11-23": "TBA",
    "2026-11-24": "TBA",
    "2026-11-25": "TBA",
    "2026-11-27": "TBA",
    "2026-12-01": "5:30 PM",
    "2026-12-03": "TBA",
    "2026-12-04": "TBA",
    "2026-12-05": "TBA",
    "2026-12-08": "7:00 PM",
    "2026-12-11": "7:00 PM",
    "2026-12-14": "7:00 PM",
    "2026-12-18": "7:00 PM",
    "2026-12-21": "7:00 PM",
    "2026-12-23": "7:00 PM",
    "2027-01-05": "7:00 PM",
    "2027-01-08": "7:00 PM",
    "2027-01-11": "7:00 PM",
    "2027-01-13": "7:00 PM",
    "2027-01-15": "7:00 PM",
    "2027-01-19": "7:00 PM",
    "2027-01-22": "7:00 PM",
    "2027-01-23": "4:00 PM",
    "2027-01-26": "7:00 PM",
    "2027-01-29": "7:00 PM",
    "2027-02-02": "7:00 PM",
}


def main():
    session = boto3.Session(profile_name=PROFILE)
    dynamodb = session.resource("dynamodb")
    schedule_table = dynamodb.Table(SCHEDULE_TABLE)
    rosters_table = dynamodb.Table(ROSTERS_TABLE)

    varsity = next(
        (t for t in rosters_table.scan().get("Items", []) if t.get("name") == TEAM_NAME),
        None,
    )
    if varsity is None:
        raise SystemExit(f"No roster named '{TEAM_NAME}' found")
    team_id = varsity["team_id"]

    games = schedule_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("season").eq(SEASON)
    ).get("Items", [])

    updated = 0
    for game in games:
        time = TIMES.get(game["date"])
        if time is None:
            print(f"No scraped time for {game['date']} vs {game.get('opponent')}, skipping")
            continue
        game["time"] = time
        game["team_id"] = team_id
        game.setdefault("address", "")
        schedule_table.put_item(Item=game)
        updated += 1

    print(f"Updated {updated}/{len(games)} games with time + team_id ({TEAM_NAME})")


if __name__ == "__main__":
    main()
