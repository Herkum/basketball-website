import json
import os
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])

PERMISSIONS = {"Admin", "Edit Season", "Edit Rosters", "Edit Contacts", "Edit Content"}


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
    item = table.get_item(Key={"email": email}).get("Item")
    if item is None:
        return set()
    permissions = item.get("permissions")
    # A row with no `permissions` attribute at all (created before this
    # existed, or via scripts/seed_allowlist.py) is grandfathered in as
    # Admin rather than locking every existing admin out on deploy. An
    # explicit empty list (saved through this Users admin UI) means "no
    # permissions".
    if permissions is None:
        return {"Admin"}
    return set(permissions)


def _permissions_of(item):
    permissions = item.get("permissions")
    # Same grandfather rule as _caller_permissions: a missing attribute
    # means implicit Admin, not "no permissions".
    if permissions is None:
        return {"Admin"}
    return set(permissions)


def _remaining_admins(exclude_email):
    return [
        i
        for i in table.scan().get("Items", [])
        if i.get("email") != exclude_email and "Admin" in _permissions_of(i)
    ]


def _caller_email(event):
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt", {}).get("claims", {})
    return (claims.get("email") or "").lower()


def handler(event, context):
    """Admin allowlist, extended with a name and per-section edit
    permissions. Presence of a row here (regardless of permissions) is what
    lets someone sign in at all - see post_auth_allowlist. Every write, and
    reading anyone else's row or the full list, requires the caller to
    already hold Admin themselves - the one exception is GET on your own
    row, which the admin UI needs on every login just to know what to show.
    """
    method = event["requestContext"]["http"]["method"]
    email = (event.get("pathParameters") or {}).get("email")
    if email:
        email = email.lower()

    if method == "GET" and email and email == _caller_email(event):
        item = table.get_item(Key={"email": email}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if "Admin" not in _caller_permissions(event):
        return _response(403, {"error": "forbidden"})

    if method == "GET" and email:
        item = table.get_item(Key={"email": email}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET":
        items = table.scan().get("Items", [])
        items.sort(key=lambda i: (i.get("last_name", ""), i.get("first_name", "")))
        return _response(200, items)

    if method in ("POST", "PUT"):
        body = json.loads(event.get("body") or "{}")
        new_email = (body.get("email") or email or "").lower()
        if not new_email:
            return _response(400, {"error": "email is required"})
        body["email"] = new_email
        body["permissions"] = [p for p in (body.get("permissions") or []) if p in PERMISSIONS]

        # Editing an existing row (path email present) into a state with no
        # Admin left, when it was the last Admin, would lock everyone out
        # of managing Users at all - block it instead.
        if email and "Admin" not in body["permissions"]:
            existing = table.get_item(Key={"email": email}).get("Item")
            if existing and "Admin" in _permissions_of(existing) and not _remaining_admins(email):
                return _response(400, {"error": "cannot remove the last Admin"})

        table.put_item(Item=body)
        if email and email != new_email:
            table.delete_item(Key={"email": email})
        return _response(200, body)

    if method == "DELETE" and email:
        existing = table.get_item(Key={"email": email}).get("Item")
        if existing and "Admin" in _permissions_of(existing) and not _remaining_admins(email):
            return _response(400, {"error": "cannot delete the last Admin"})
        table.delete_item(Key={"email": email})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
