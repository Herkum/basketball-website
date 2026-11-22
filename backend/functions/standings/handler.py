"""League Standings cache (singleton "current" row): `GET` (public) serves
it, `PUT` (JWT, `Edit Season`) saves the admin's manual edits. The rows
themselves come from the `rankings` refresh, which already scrapes our
league's MaxPreps table - see `_write_standings` in rankings/handler.py.
"""

import json
import os
import time
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
users_table = dynamodb.Table(os.environ["USERS_TABLE_NAME"])

CACHE_ID = "current"
REQUIRED_PERMISSION = "Edit Season"


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


def _get_cached():
    return table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {}


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
    # The League Standings cache is written by the `rankings` refresh (one
    # MaxPreps scrape for both - see _write_standings there). This Lambda
    # only serves it and saves the admin's manual edits.
    if "requestContext" not in event:
        return _response(400, {"error": "standings are refreshed by the rankings job, not invoked directly"})

    method = event["requestContext"]["http"]["method"]

    if method == "GET":
        item = _get_cached()
        return _response(200, item or {"source_url": None, "updated_at": None, "rows": []})

    perms = _caller_permissions(event)
    if "Admin" not in perms and REQUIRED_PERMISSION not in perms:
        return _response(403, {"error": "forbidden"})

    if method == "PUT":
        # Manual correction of the cached rows (e.g. fixing a scrape
        # error) - persists exactly what's given. The next rankings refresh
        # overwrites every field but `link` again.
        body = json.loads(event.get("body") or "{}")
        rows = body.get("rows")
        if rows is None:
            return _response(400, {"error": "rows required"})
        cached = _get_cached()
        item = {
            "cache_id": CACHE_ID,
            "source_url": cached.get("source_url"),
            "updated_at": int(time.time()),
            "rows": rows,
        }
        table.put_item(Item=item)
        return _response(200, item)

    return _response(400, {"error": "unsupported request"})
