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


def _sort_key(item):
    return (item.get("last_name", ""), item.get("first_name", ""))


def handler(event, context):
    method = event["requestContext"]["http"]["method"]
    path_params = event.get("pathParameters") or {}
    team_id = path_params.get("team_id")
    player_id = path_params.get("player_id")

    if method == "GET" and team_id and player_id:
        item = table.get_item(Key={"team_id": team_id, "player_id": player_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET" and team_id:
        items = table.query(KeyConditionExpression=Key("team_id").eq(team_id)).get("Items", [])
        items.sort(key=_sort_key)
        return _response(200, items)

    if method in ("POST", "PUT") and team_id:
        body = json.loads(event.get("body") or "{}")
        body["team_id"] = team_id
        body["player_id"] = player_id or body.get("player_id") or str(uuid.uuid4())
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and team_id and player_id:
        table.delete_item(Key={"team_id": team_id, "player_id": player_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
