import os

import boto3

dynamodb = boto3.resource("dynamodb")
allowlist_table = dynamodb.Table(os.environ["ALLOWLIST_TABLE_NAME"])


def handler(event, context):
    """Cognito post-authentication trigger.

    Denies sign-in (by raising) unless the authenticated user's email is
    present in the AdminAllowlist table. Raising here is what Cognito
    interprets as "reject this sign-in".
    """
    email = event["request"]["userAttributes"].get("email")
    if not email:
        raise Exception("No email present on authenticated user.")

    response = allowlist_table.get_item(Key={"email": email.lower()})
    if "Item" not in response:
        raise Exception(f"{email} is not authorized to access the admin console.")

    return event
