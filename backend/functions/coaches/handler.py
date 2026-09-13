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
    method = event["requestContext"]["http"]["method"]
    coach_id = (event.get("pathParameters") or {}).get("coach_id")

    if method == "GET" and coach_id:
        item = table.get_item(Key={"coach_id": coach_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET":
        items = table.scan().get("Items", [])
        items.sort(key=lambda i: i.get("order", 0))
        return _response(200, items)

    if method in ("POST", "PUT"):
        body = json.loads(event.get("body") or "{}")
        body["coach_id"] = coach_id or body.get("coach_id") or str(uuid.uuid4())
        # New coaches (no order sent) go to the end of the list; reordering
        # sends an explicit `order` for every affected coach.
        body.setdefault("order", int(time.time() * 1000))
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and coach_id:
        table.delete_item(Key={"coach_id": coach_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
