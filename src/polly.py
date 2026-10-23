"""Bounded plain-text Polly synthesis with stdlib AWS Signature Version 4."""
from datetime import datetime, timezone
import hashlib
import hmac
import json
import re

from tools_alexa import sanitize


class VoiceUnavailable(RuntimeError):
    pass


def speech_text(message):
    if not isinstance(message, dict) or set(message) != {"text"} or not isinstance(message["text"], str):
        raise ValueError("Expected text")
    text = sanitize(message["text"]).strip()
    if not text or len(text) > 300:
        raise ValueError("Text must contain 1 to 300 sanitized characters")
    return text


def signed_headers(body, access_key, secret_key, region, timestamp, session_token=""):
    host = f"polly.{region}.amazonaws.com"
    headers = {"content-type": "application/json", "host": host, "x-amz-date": timestamp}
    if session_token:
        headers["x-amz-security-token"] = session_token
    names = ";".join(sorted(headers))
    canonical = "\n".join(["POST", "/v1/speech", "", "".join(
        f"{name}:{' '.join(headers[name].split())}\n" for name in sorted(headers)),
        names, hashlib.sha256(body.encode()).hexdigest()])
    day = timestamp[:8]
    scope = f"{day}/{region}/polly/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", timestamp, scope,
                          hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + secret_key).encode()
    for value in (day, region, "polly", "aws4_request"):
        key = hmac.new(key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
                                f"SignedHeaders={names}, Signature={signature}")
    return headers


async def synthesize(text, config, fetcher=None):
    # Enforce the cap here too: no caller can bypass the outbound boundary.
    text = speech_text({"text": text})
    access, secret = config("AWS_ACCESS_KEY_ID"), config("AWS_SECRET_ACCESS_KEY")
    region = config("AWS_REGION") or "us-west-2"
    if not access or not secret or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region):
        raise VoiceUnavailable("voice unavailable")
    engine = config("POLLY_ENGINE") or "generative"
    voice = config("POLLY_VOICE") or "Ruth"
    if fetcher is None:
        from workers import fetch
        fetcher = fetch
    try:
        for attempt in range(2):
            body = json.dumps({"Text": text, "TextType": "text", "OutputFormat": "mp3",
                               "Engine": engine, "VoiceId": voice}, separators=(",", ":"))
            headers = signed_headers(body, access, secret, region,
                                     datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                                     config("AWS_SESSION_TOKEN"))
            response = await fetcher(f"https://polly.{region}.amazonaws.com/v1/speech",
                                     method="POST", headers=headers, body=body, redirect="error")
            if response.status == 200:
                return await response.bytes()
            error = await response.json()
            code = error.get("__type", error.get("code", "")).split("#")[-1].split(":")[0]
            if attempt == 0 and engine == "generative" and code == "EngineNotSupportedException":
                engine = "neural"
                continue
            raise VoiceUnavailable("voice unavailable")
    except Exception:
        raise VoiceUnavailable("voice unavailable") from None
