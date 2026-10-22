"""Credential verification and bounded client-credentials tokens; no secret defaults."""
import base64
import hashlib
import hmac
import json
import time
from urllib.parse import unquote_plus


def subject_hash(subject):
    return hashlib.sha256(subject.encode()).hexdigest()


def judge_subject(token, hashes):
    digest = subject_hash(token)
    if token and any(hmac.compare_digest(digest, item.strip()) for item in hashes.split(",") if item.strip()):
        return "judge:" + digest
    return None


def session_id(subject):
    # One server-issued stable session per credential; rotation creates a new scope.
    return subject_hash("session:" + subject)


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def decode(value):
    return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)


def issue_token(subject, key, audience, now=None):
    if len(key.encode()) < 32 or not audience:
        raise ValueError("Token service unavailable")
    now = int(time.time() if now is None else now)
    claims = {"sub": subject, "aud": audience, "iss": audience.removesuffix("/mcp"),
              "iat": now, "exp": now + 3600, "sid": session_id(subject)}
    parts = [encode(json.dumps(value, separators=(",", ":")).encode())
             for value in ({"alg": "HS256", "typ": "JWT"}, claims)]
    signature = hmac.new(key.encode(), ".".join(parts).encode(), hashlib.sha256).digest()
    return ".".join([*parts, encode(signature)])


def verify_token(token, key, audience, hashes="", client_id="", now=None):
    try:
        if len(key.encode()) < 32 or len(token) > 8192:
            return None
        head, body, signature = token.split(".")
        expected = hmac.new(key.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(decode(signature), expected):
            return None
        header, claims = json.loads(decode(head)), json.loads(decode(body))
        now = time.time() if now is None else now
        if header != {"alg": "HS256", "typ": "JWT"} or not isinstance(claims, dict):
            return None
        if (type(claims.get("exp")) is not int or type(claims.get("iat")) is not int
                or not claims["iat"] <= now < claims["exp"] <= claims["iat"] + 3600
                or claims.get("aud") != audience or claims.get("iss") != audience.removesuffix("/mcp")):
            return None
        subject = claims.get("sub")
        if not isinstance(subject, str) or claims.get("sid") != session_id(subject):
            return None
        if subject.startswith("judge:"):
            if not any(hmac.compare_digest(subject[6:], h.strip()) for h in hashes.split(",") if h.strip()):
                return None
        elif not client_id or subject != client_id:
            return None
        return subject
    except (ValueError, TypeError, KeyError, UnicodeError):
        return None


def client_subject(header, client_id, client_secret):
    try:
        if len(header) > 8192:
            return None
        scheme, value = header.split(" ", 1)
        if scheme.lower() != "basic" or not client_id or client_id.startswith("judge:") or not client_secret:
            return None
        user, secret = base64.b64decode(value, validate=True).decode().split(":", 1)
        if hmac.compare_digest(unquote_plus(user).encode(), client_id.encode()) and hmac.compare_digest(unquote_plus(secret).encode(), client_secret.encode()):
            return client_id
    except (ValueError, UnicodeError):
        pass
    return None
