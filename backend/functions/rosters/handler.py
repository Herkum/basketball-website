import json
import os
import time
import uuid
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
users_table = dynamodb.Table(os.environ["USERS_TABLE_NAME"])

REQUIRED_PERMISSION = "Edit Rosters"


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
    """Team-level roster CRUD: name, image, coach_ids (many-to-many with
    Coaches), order (drag-to-reorder). Individual players live in the
    separate Players table, keyed by team_id - see the `players` function.
    """
    method = event["requestContext"]["http"]["method"]
    team_id = (event.get("pathParameters") or {}).get("team_id")

    if method == "GET" and team_id:
        item = table.get_item(Key={"team_id": team_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET":
        items = table.scan().get("Items", [])
        items.sort(key=lambda i: i.get("order", 0))
        return _response(200, items)

    perms = _caller_permissions(event)
    if "Admin" not in perms and REQUIRED_PERMISSION not in perms:
        return _response(403, {"error": "forbidden"})

    if method in ("POST", "PUT"):
        body = json.loads(event.get("body") or "{}")
        body["team_id"] = team_id or body.get("team_id") or str(uuid.uuid4())
        body.setdefault("coach_ids", [])
        # New teams (no order sent) go to the end of the list; reordering
        # sends an explicit `order` for every affected team.
        body.setdefault("order", int(time.time() * 1000))
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and team_id:
        table.delete_item(Key={"team_id": team_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
