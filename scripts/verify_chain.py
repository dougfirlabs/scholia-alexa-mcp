"""Verify get_trace structuredContent JSON from stdin; no project dependencies."""
import hashlib
import json
import sys


def verify(payload):
    previous = payload.get("anchor")
    household = payload["trace"]["household_id"]
    for index, record in enumerate(payload["chain"], 1):
        body = {key: value for key, value in record.items() if key != "trace_id"}
        encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        digest = "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()
        if record.get("trace_id") != digest or body.get("previous") != previous or body.get("household_id") != household:
            return f"FAIL at record #{index}"
        previous = digest
    return "OK" if payload["trace"] in payload["chain"] else "FAIL: selected trace absent"


if __name__ == "__main__":
    try:
        result = verify(json.load(sys.stdin))
    except (ValueError, KeyError, TypeError, AttributeError):
        result = "FAIL: invalid trace input"
    print(result)
    sys.exit(0 if result == "OK" else 1)
