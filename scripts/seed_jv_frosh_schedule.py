#!/usr/bin/env python3
"""Seeds the Schedule table with the Junior Varsity and Frosh/Soph boys
basketball schedules, scraped 2026-09-12 from:
  https://www.nphsathletics.org/lower/basketball-boys-junior-varsity/schedule-results/
  https://www.nphsathletics.org/lower/basketball-boys-frosh-soph/schedule-results/
Season hadn't started (0-0-0 records), so no scores are set. Games are
linked to the existing "Junior Varsity" and "Frosh" rosters via team_id.

Usage:
    python3 seed_jv_frosh_schedule.py
"""
import uuid

import boto3

PROFILE = "basketball-website"
SCHEDULE_TABLE = "basketball-website-Schedule"
ROSTERS_TABLE = "basketball-website-Rosters"
SEASON = "2026-2027"

# (date ISO, opponent, home_away, time)
JV_GAMES = [
    ("2026-11-16", "Buena", "Away", "5:30 PM"),
    ("2026-11-17", "St. Bonaventure", "Home", "5:30 PM"),
    ("2026-11-20", "Malibu", "Home", "5:30 PM"),
    ("2026-11-23", "Oxnard", "Away", "12:30 PM"),
    ("2026-11-27", "Buena JV Tournament", "Away", "TBA"),
    ("2026-11-28", "Buena JV Tournament", "Away", "TBA"),
    ("2026-11-30", "Buena JV Tournament", "Away", "TBA"),
    ("2026-12-01", "Buena JV Tournament", "Away", "TBA"),
    ("2026-12-05", "Simi Valley Showcase", "Away", "TBA"),
    ("2026-12-08", "Simi Valley", "Home", "5:30 PM"),
    ("2026-12-11", "Moorpark", "Away", "5:30 PM"),
    ("2026-12-14", "Royal", "Home", "5:30 PM"),
    ("2026-12-18", "Burroughs/Burbank", "Home", "5:30 PM"),
    ("2026-12-21", "AGBU/Canoga Park", "Away", "5:30 PM"),
    ("2026-12-23", "Mira Costa", "Away", "5:30 PM"),
    ("2027-01-05", "Westlake", "Away", "5:30 PM"),
    ("2027-01-08", "Oaks Christian", "Home", "5:30 PM"),
    ("2027-01-11", "Agoura", "Home", "5:30 PM"),
    ("2027-01-13", "Calabasas", "Away", "5:30 PM"),
    ("2027-01-15", "Thousand Oaks", "Away", "5:30 PM"),
    ("2027-01-19", "Westlake", "Home", "5:30 PM"),
    ("2027-01-22", "Oaks Christian", "Away", "5:30 PM"),
    ("2027-01-23", "Camarillo", "Away", "2:30 PM"),
    ("2027-01-26", "Agoura", "Away", "5:30 PM"),
    ("2027-01-29", "Thousand Oaks", "Home", "5:30 PM"),
    ("2027-02-02", "Calabasas", "Home", "5:30 PM"),
]

FROSH_GAMES = [
    ("2026-11-16", "Buena", "Away", "4:00 PM"),
    ("2026-11-17", "St. Bonaventure", "Home", "4:00 PM"),
    ("2026-11-18", "Buena FS Tournament", "Away", "TBA"),
    ("2026-11-19", "Buena FS Tournament", "Away", "TBA"),
    ("2026-11-20", "Buena FS Tournament", "Away", "TBA"),
    ("2026-11-23", "Oxnard", "Away", "11:00 AM"),
    ("2026-12-01", "Oak Park", "Home", "4:00 PM"),
    ("2026-12-08", "Simi Valley", "Home", "4:00 PM"),
    ("2026-12-11", "Moorpark", "Away", "4:00 PM"),
    ("2026-12-14", "Royal", "Home", "4:00 PM"),
    ("2026-12-18", "Burroughs/Burbank", "Home", "4:00 PM"),
    ("2026-12-21", "AGBU/Canoga Park", "Away", "4:00 PM"),
    ("2026-12-23", "Mira Costa", "Away", "4:00 PM"),
    ("2026-12-26", "Camarillo FS Tournament", "Away", "TBA"),
    ("2026-12-28", "Camarillo FS Tournament", "Away", "TBA"),
    ("2026-12-29", "Camarillo FS Tournament", "Away", "TBA"),
    ("2026-12-30", "Camarillo FS Tournament", "Away", "TBA"),
    ("2027-01-05", "Westlake", "Away", "4:00 PM"),
    ("2027-01-08", "Oaks Christian", "Home", "4:00 PM"),
    ("2027-01-11", "Agoura", "Home", "4:00 PM"),
    ("2027-01-13", "Calabasas", "Away", "4:00 PM"),
    ("2027-01-15", "Thousand Oaks", "Away", "4:00 PM"),
    ("2027-01-19", "Westlake", "Home", "4:00 PM"),
    ("2027-01-22", "Oaks Christian", "Away", "4:00 PM"),
    ("2027-01-23", "Camarillo", "Away", "1:00 PM"),
    ("2027-01-26", "Agoura", "Away", "4:00 PM"),
    ("2027-01-29", "Thousand Oaks", "Home", "4:00 PM"),
    ("2027-02-02", "Calabasas", "Home", "4:00 PM"),
]

TEAM_GAMES = [
    ("Junior Varsity", JV_GAMES),
    ("Frosh", FROSH_GAMES),
]


def main():
    session = boto3.Session(profile_name=PROFILE)
    dynamodb = session.resource("dynamodb")
    schedule_table = dynamodb.Table(SCHEDULE_TABLE)
    rosters_table = dynamodb.Table(ROSTERS_TABLE)

    rosters_by_name = {t["name"]: t for t in rosters_table.scan().get("Items", [])}

    for team_name, games in TEAM_GAMES:
        team = rosters_by_name.get(team_name)
        if team is None:
            print(f"No roster named '{team_name}' found, skipping its games")
            continue
        team_id = team["team_id"]

        for date, opponent, home_away, time in games:
            schedule_table.put_item(
                Item={
                    "season": SEASON,
                    "game_id": str(uuid.uuid4()),
                    "date": date,
                    "opponent": opponent,
                    "home_away": home_away,
                    "time": time,
                    "address": "",
                    "team_id": team_id,
                    "our_score": "",
                    "opponent_score": "",
                }
            )
        print(f"Added {len(games)} games for {team_name}")


if __name__ == "__main__":
    main()
