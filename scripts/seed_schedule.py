#!/usr/bin/env python3
"""Seeds the Schedule table with the Varsity boys basketball schedule
scraped from https://www.nphsathletics.org/varsity/basketball-boys/schedule-results
on 2026-09-12. The season hadn't started yet at that point (overall record
0-0-0), so no scores are set - re-run scripts/update_scores.py (if/when it
exists) or edit through the admin UI as results come in.

Usage:
    python3 seed_schedule.py
"""
import uuid

import boto3

PROFILE = "basketball-website"
SCHEDULE_TABLE = "basketball-website-Schedule"
SEASON = "2026-2027"

# (date ISO, opponent, home_away)
GAMES = [
    ("2026-11-16", "Buena", "Away"),
    ("2026-11-17", "St. Bonaventure", "Home"),
    ("2026-11-20", "Malibu", "Home"),
    ("2026-11-23", "San Gabriel Tournament", "Away"),
    ("2026-11-24", "San Gabriel Tournament", "Away"),
    ("2026-11-25", "San Gabriel Tournament", "Away"),
    ("2026-11-27", "San Gabriel Tournament", "Away"),
    ("2026-12-01", "Oak Park", "Home"),
    ("2026-12-03", "Nordhoff Varsity Tournament", "Away"),
    ("2026-12-04", "Nordhoff Varsity Tournament", "Away"),
    ("2026-12-05", "Nordhoff Varsity Tournament", "Away"),
    ("2026-12-08", "Simi Valley", "Home"),
    ("2026-12-11", "Moorpark", "Away"),
    ("2026-12-14", "Royal", "Home"),
    ("2026-12-18", "Burroughs/Burbank", "Home"),
    ("2026-12-21", "AGBU/Canoga Park", "Away"),
    ("2026-12-23", "Mira Costa", "Away"),
    ("2027-01-05", "Westlake", "Away"),
    ("2027-01-08", "Oaks Christian", "Home"),
    ("2027-01-11", "Agoura", "Home"),
    ("2027-01-13", "Calabasas", "Away"),
    ("2027-01-15", "Thousand Oaks", "Away"),
    ("2027-01-19", "Westlake", "Home"),
    ("2027-01-22", "Oaks Christian", "Away"),
    ("2027-01-23", "Camarillo", "Away"),
    ("2027-01-26", "Agoura", "Away"),
    ("2027-01-29", "Thousand Oaks", "Home"),
    ("2027-02-02", "Calabasas", "Home"),
]


def main():
    session = boto3.Session(profile_name=PROFILE)
    table = session.resource("dynamodb").Table(SCHEDULE_TABLE)

    for date, opponent, home_away in GAMES:
        table.put_item(
            Item={
                "season": SEASON,
                "game_id": str(uuid.uuid4()),
                "date": date,
                "opponent": opponent,
                "home_away": home_away,
                "our_score": "",
                "opponent_score": "",
            }
        )
        print(f"Added {date} {home_away} vs {opponent}")

    print(f"\nSeeded {len(GAMES)} games for season {SEASON}")


if __name__ == "__main__":
    main()
