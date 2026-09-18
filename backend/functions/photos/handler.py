import json
import os
import time
import uuid
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
users_table = dynamodb.Table(os.environ["USERS_TABLE_NAME"])

REQUIRED_PERMISSION = "Edit Content"


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def _caller_permissions(event):
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt", {}).get("claims", {})
    email = (claims.get("email") or "").lower()
    if not email:
        return set()
    item = users_table.get_item(Key={"email": email}).get("Item")
    if item is None:
        return set()
    permissions = item.get("permissions")
    if permissions is None:
        return {"Admin"}
    return set(permissions)


def handler(event, context):
    """Photos nested under an album: image (CloudFront URL from the shared
    /uploads presigned-URL flow), caption, order (drag-to-reorder). Mirrors
    the Players table's team_id/player_id nesting under Rosters.
    """
    method = event["requestContext"]["http"]["method"]
    path_params = event.get("pathParameters") or {}
    album_id = path_params.get("album_id")
    photo_id = path_params.get("photo_id")

    if method == "GET" and album_id and photo_id:
        item = table.get_item(Key={"album_id": album_id, "photo_id": photo_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET" and album_id:
        items = table.query(KeyConditionExpression=Key("album_id").eq(album_id)).get("Items", [])
        items.sort(key=lambda i: i.get("order", 0))
        return _response(200, items)

    perms = _caller_permissions(event)
    if "Admin" not in perms and REQUIRED_PERMISSION not in perms:
        return _response(403, {"error": "forbidden"})

    if method in ("POST", "PUT") and album_id:
        body = json.loads(event.get("body") or "{}")
        body["album_id"] = album_id
        body["photo_id"] = photo_id or body.get("photo_id") or str(uuid.uuid4())
        body.setdefault("order", int(time.time() * 1000))
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and album_id and photo_id:
        table.delete_item(Key={"album_id": album_id, "photo_id": photo_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
