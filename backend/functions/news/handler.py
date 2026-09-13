import json
import os
import uuid

import boto3

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
    post_id = (event.get("pathParameters") or {}).get("post_id")

    if method == "GET" and post_id:
        item = table.get_item(Key={"post_id": post_id}).get("Item")
        return _response(404, {"error": "not found"}) if item is None else _response(200, item)

    if method == "GET":
        items = table.scan().get("Items", [])
        return _response(200, items)

    if method in ("POST", "PUT"):
        body = json.loads(event.get("body") or "{}")
        body["post_id"] = post_id or body.get("post_id") or str(uuid.uuid4())
        table.put_item(Item=body)
        return _response(200, body)

    if method == "DELETE" and post_id:
        table.delete_item(Key={"post_id": post_id})
        return _response(204, {})

    return _response(400, {"error": "unsupported request"})
