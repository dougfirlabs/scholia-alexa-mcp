"""Validate the JSON Schema subset used by this server's tool definitions."""
import math
import re


def bounded(value, depth=0):
    if depth > 20:
        raise ValueError("Input nesting limit exceeded")
    if isinstance(value, str) and len(value.encode()) > 8192:
        raise ValueError("String exceeds 8192 bytes")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Non-finite number")
    if isinstance(value, dict):
        for key, item in value.items():
            bounded(key, depth + 1)
            bounded(item, depth + 1)
    if isinstance(value, list):
        for item in value:
            bounded(item, depth + 1)


def validate(value, schema):
    bounded(value)
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise ValueError("Expected object")
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            raise ValueError("Missing argument")
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            raise ValueError("Unknown argument")
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key])
    elif kind == "string":
        if not isinstance(value, str):
            raise ValueError("Expected string")
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 8192):
            raise ValueError("Invalid string length")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            raise ValueError("Invalid string")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("Invalid choice")


def valid_id(message):
    value = message.get("id")
    return "id" not in message or type(value) in (str, int) or (type(value) is float and math.isfinite(value))
