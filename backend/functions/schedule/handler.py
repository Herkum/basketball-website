import json
import os
import uuid

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    method = event["requestContext"]["http"]["method"]
    path_params = event.get("pathParameters") or {}
    season = path_params.get("season")
    game_id = path_params.get("game_id")

    if method == "GET" and season and game_id:
        item = table.get_item(Key={"season": season, "game_id": game_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET" and season:
        items = table.query(KeyConditionExpression=Key("season").eq(season)).get("Items", [])
        return _response(200, items)

    if method in ("POST", "PUT") and season:
        body = json.loads(event.get("body") or "{}")
        body["season"] = season
        body["game_id"] = game_id or body.get("game_id") or str(uuid.uuid4())
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and season and game_id:
        table.delete_item(Key={"season": season, "game_id": game_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
