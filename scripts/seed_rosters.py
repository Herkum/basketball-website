#!/usr/bin/env python3
"""One-off/reusable seeder: creates Varsity, Junior Varsity, and Frosh teams
with 15 generated players each, and assigns every existing coach to every
generated team.

Usage:
    python3 seed_rosters.py
"""
import random
import time
import uuid

import boto3

PROFILE = "basketball-website"
ROSTERS_TABLE = "basketball-website-Rosters"
PLAYERS_TABLE = "basketball-website-Players"
COACHES_TABLE = "basketball-website-Coaches"

TEAM_NAMES = ["Varsity", "Junior Varsity", "Frosh"]
PLAYERS_PER_TEAM = 15

FIRST_NAMES = [
    "James", "Michael", "David", "Marcus", "Anthony", "Chris", "Jordan", "Tyler",
    "Brandon", "Justin", "Kevin", "Ryan", "Ethan", "Noah", "Isaiah", "Elijah",
    "Xavier", "Malik", "Aidan", "Caleb",
]
LAST_NAMES = [
    "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore",
    "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
]
YEARS = ["Freshman", "Sophomore", "Junior", "Senior"]


def random_height():
    feet = random.choice([5, 6])
    inches = random.randint(0, 11)
    return f"{feet}'{inches}\""


def main():
    session = boto3.Session(profile_name=PROFILE)
    dynamodb = session.resource("dynamodb")
    rosters_table = dynamodb.Table(ROSTERS_TABLE)
    players_table = dynamodb.Table(PLAYERS_TABLE)
    coaches_table = dynamodb.Table(COACHES_TABLE)

    coach_ids = [c["coach_id"] for c in coaches_table.scan().get("Items", [])]
    print(f"Assigning {len(coach_ids)} coach(es) to every team: {coach_ids}")

    for index, team_name in enumerate(TEAM_NAMES):
        team_id = str(uuid.uuid4())
        rosters_table.put_item(
            Item={
                "team_id": team_id,
                "name": team_name,
                "image": "",
                "coach_ids": coach_ids,
                "order": index,
            }
        )
        print(f"Created team '{team_name}' ({team_id})")

        used_numbers = random.sample(range(0, 100), PLAYERS_PER_TEAM)
        for i in range(PLAYERS_PER_TEAM):
            player_id = str(uuid.uuid4())
            players_table.put_item(
                Item={
                    "team_id": team_id,
                    "player_id": player_id,
                    "first_name": random.choice(FIRST_NAMES),
                    "last_name": random.choice(LAST_NAMES),
                    "number": str(used_numbers[i]),
                    "height": random_height(),
                    "year": random.choice(YEARS),
                    "profile": "",
                }
            )
        print(f"  added {PLAYERS_PER_TEAM} players")


if __name__ == "__main__":
    main()
