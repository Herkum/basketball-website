import json
import os
import re
import time
import urllib.request
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])

CACHE_ID = "current"


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


def _strip_tags(html_fragment):
    return re.sub(r"<[^>]+>", "", html_fragment).strip()


def scrape_standings(source_url):
    """Scrapes a MaxPreps league standings page. Server-rendered, no JS
    needed - each row is <tr><td>rank</td><td class="school-details">
    ...<span class="school-name">Name</span>...</td><td>league W-L</td>
    <td>league pct</td><td>league PF</td><td>league PA</td>
    <td>overall W-L</td><td>overall pct</td><td>overall PF</td>
    <td>overall PA</td><td>streak</td></tr>. Streak cells have an inline
    HTML comment splitting the number from L/W (e.g. "3<!-- -->L") that
    needs stripping. Fragile by nature - if MaxPreps changes their
    markup, this silently returns fewer/no rows until someone notices.
    """
    with urllib.request.urlopen(source_url, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    tbody_start = html.find("<tbody")
    tbody_end = html.find("</tbody>")
    if tbody_start == -1 or tbody_end == -1:
        raise ValueError("no standings table found on page")
    tbody = html[tbody_start : tbody_end + len("</tbody>")]

    rows = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody, re.S):
        name_match = re.search(r'<span class="school-name">(.*?)</span>', row_html)
        if not name_match:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row_html, re.S)
        if len(cells) < 11:
            continue
        rows.append(
            {
                "rank": _strip_tags(cells[0]),
                "school": name_match.group(1).strip(),
                "league_record": _strip_tags(cells[2]),
                "league_pct": _strip_tags(cells[3]),
                "league_pf": _strip_tags(cells[4]),
                "league_pa": _strip_tags(cells[5]),
                "overall_record": _strip_tags(cells[6]),
                "overall_pct": _strip_tags(cells[7]),
                "overall_pf": _strip_tags(cells[8]),
                "overall_pa": _strip_tags(cells[9]),
                "streak": _strip_tags(cells[10]),
            }
        )
    return rows


def _refresh(source_url):
    new_rows = scrape_standings(source_url)

    # `link` is admin-set (see the League Standings admin tab), never
    # scraped - carry it forward from the previous cache by matching
    # school name, so a refresh doesn't wipe out links the admin entered.
    cached = table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {}
    old_by_school = {(r.get("school") or "").lower(): r for r in cached.get("rows", [])}
    for row in new_rows:
        old = old_by_school.get((row.get("school") or "").lower())
        row["link"] = old.get("link", "") if old else ""

    item = {
        "cache_id": CACHE_ID,
        "source_url": source_url,
        "updated_at": int(time.time()),
        "rows": new_rows,
    }
    table.put_item(Item=item)
    return item


def handler(event, context):
    # A direct/scheduled invoke (e.g. a future EventBridge rule) has no
    # requestContext - treat it as an implicit refresh using the last
    # saved source_url, so adding a scheduled trigger later needs no
    # handler changes.
    if "requestContext" not in event:
        cached = table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {}
        source_url = cached.get("source_url")
        if not source_url:
            return _response(400, {"error": "no source_url configured yet"})
        try:
            return _response(200, _refresh(source_url))
        except Exception as exc:
            return _response(502, {"error": f"scrape failed: {exc}"})

    method = event["requestContext"]["http"]["method"]

    if method == "GET":
        item = table.get_item(Key={"cache_id": CACHE_ID}).get("Item")
        return _response(200, item or {"source_url": None, "updated_at": None, "rows": []})

    if method == "POST":
        body = json.loads(event.get("body") or "{}")
        source_url = body.get("source_url")
        if not source_url:
            cached = table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {}
            source_url = cached.get("source_url")
        if not source_url:
            return _response(400, {"error": "source_url required"})
        try:
            return _response(200, _refresh(source_url))
        except Exception as exc:
            return _response(502, {"error": f"scrape failed: {exc}"})

    if method == "PUT":
        # Manual correction of the cached rows (e.g. fixing a scrape
        # error) - persists exactly what's given, no scraping involved.
        # Overwritten again on the next Refresh Now.
        body = json.loads(event.get("body") or "{}")
        rows = body.get("rows")
        if rows is None:
            return _response(400, {"error": "rows required"})
        cached = table.get_item(Key={"cache_id": CACHE_ID}).get("Item") or {}
        item = {
            "cache_id": CACHE_ID,
            "source_url": cached.get("source_url"),
            "updated_at": int(time.time()),
            "rows": rows,
        }
        table.put_item(Item=item)
        return _response(200, item)

    return _response(400, {"error": "unsupported request"})
