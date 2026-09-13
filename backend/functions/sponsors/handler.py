import json
import os
import time
import uuid
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])


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


def handler(event, context):
    """Sponsor entries: name, kind (business category), website,
    tier (Banner/Court/Friend of the Program), order (drag-to-reorder,
    same pattern as Contacts/Coaches).
    """
    method = event["requestContext"]["http"]["method"]
    sponsor_id = (event.get("pathParameters") or {}).get("sponsor_id")

    if method == "GET" and sponsor_id:
        item = table.get_item(Key={"sponsor_id": sponsor_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET":
        items = table.scan().get("Items", [])
        items.sort(key=lambda i: i.get("order", 0))
        return _response(200, items)

    if method in ("POST", "PUT"):
        body = json.loads(event.get("body") or "{}")
        body["sponsor_id"] = sponsor_id or body.get("sponsor_id") or str(uuid.uuid4())
        body.setdefault("order", int(time.time() * 1000))
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and sponsor_id:
        table.delete_item(Key={"sponsor_id": sponsor_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
