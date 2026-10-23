import json
import logging
import sys
import time
import uuid
from urllib.parse import parse_qs, urlparse

import auth
import polly
from validation import valid_id

from workers import Response, WorkerEntrypoint
from store import D1Store, SubjectStore

from mcp_protocol import (
    JSONRPC_PARSE_ERROR,
    SUPPORTED_PROTOCOL_VERSIONS,
    tool_definitions,
    handle_rpc_message_async,
    json_dumps,
    origin_allowed,
    rpc_error,
)


MCP_PATH = "/mcp"
HEALTH_PATH = "/healthz"
AUDIT_LOG = logging.getLogger(__name__)
AUDIT_LOG.setLevel(logging.INFO)
if not AUDIT_LOG.handlers:
    AUDIT_LOG.addHandler(logging.StreamHandler(sys.stdout))


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        audit = {"method": request.method if request.method in {"GET", "POST", "HEAD", "OPTIONS", "DELETE"} else "other",
                 "tool": None, "subject": None, "requestId": uuid.uuid4().hex}
        start = time.monotonic()
        try:
            response = await self._fetch(request, audit)
        except Exception:
            response = json_response({"error": "Internal error", "requestId": audit["requestId"]}, status=500)
        audit.update(status=response.status, latency_ms=round((time.monotonic() - start) * 1000, 2))
        AUDIT_LOG.info(json_dumps(audit))
        return response

    async def _fetch(self, request, audit):
        url = urlparse(request.url)
        audience = env_value(self.env, "MCP_RESOURCE_URL")
        issuer = audience.removesuffix("/mcp")
        if env_value(self.env, "MCP_DISABLED") == "1":
            return json_response({"error": "unavailable"}, status=503)
        if url.path in {"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"}:
            if request.method != "GET":
                return text_response("Method Not Allowed", status=405)
            if not audience:
                return json_response({"error": "unavailable"}, status=503)
            if "protected-resource" in url.path:
                return json_response({"resource": audience, "authorization_servers": [issuer], "bearer_methods_supported": ["header"]})
            return json_response({"issuer": issuer, "token_endpoint": issuer + "/oauth/token",
                                  "grant_types_supported": ["client_credentials"], "response_types_supported": [],
                                  "token_endpoint_auth_methods_supported": ["client_secret_basic"]})
        if url.path in {"/oauth/token", "/oauth/judge"}:
            return await self._token(request, audit)

        if url.path in {"/demo", "/demo/", "/demo/app.js", "/demo/style.css"}:
            if request.method not in {"GET", "HEAD"}:
                return text_response("Method Not Allowed", status=405, headers={"Allow": "GET, HEAD"})
            return await self.env.ASSETS.fetch(request)

        if url.path in {MCP_PATH, "/tts"} and request.method == "OPTIONS":
            return self._handle_options(request)

        if url.path not in {MCP_PATH, HEALTH_PATH, "/tts"}:
            return text_response("Not Found", status=404)

        origin_check = self._origin_allowed(request)
        if not origin_check:
            return json_response({"error": "forbidden_origin"}, status=403)

        if not await self._limit("IP_LIMITER", auth.subject_hash(header_value(request, "CF-Connecting-IP") or "local")):
            return json_response({"error": "rate_limited"}, status=429)
        subject = self._authorized(request)
        if not subject:
            return unauthorized_response(audience, self._cors_headers(request))
        audit["subject"] = auth.subject_hash(subject)
        if not await self._limit("SUBJECT_LIMITER", audit["subject"]):
            return json_response({"error": "rate_limited"}, status=429)

        if url.path == HEALTH_PATH:
            if request.method not in {"GET", "HEAD"}:
                return text_response("Method Not Allowed", status=405, headers={"Allow": "GET, HEAD"})
            body = "" if request.method == "HEAD" else json_dumps({"ok": True, "service": "scholialang-mcp"})
            return json_response_raw(body, status=200, headers=self._cors_headers(request))

        if request.method == "GET":
            return json_response(
                {"error": "SSE stream is not supported by this stateless MCP worker"},
                status=405,
                headers={"Allow": "POST, OPTIONS", **self._cors_headers(request)},
            )

        if request.method != "POST":
            return text_response("Method Not Allowed", status=405, headers={"Allow": "POST, OPTIONS"})

        if url.path == "/tts":
            return await self._tts(request)

        protocol_version = header_value(request, "MCP-Protocol-Version")
        if protocol_version and protocol_version not in SUPPORTED_PROTOCOL_VERSIONS:
            payload = rpc_error(None, -32602, "Unsupported MCP-Protocol-Version", {"supported": SUPPORTED_PROTOCOL_VERSIONS})
            return json_response(payload, status=400, headers=self._cors_headers(request))

        try:
            length = header_value(request, "Content-Length")
            if length and (not length.isdecimal() or int(length) > 65536):
                return json_response({"error": "payload_too_large"}, status=413, headers=self._cors_headers(request))
            raw_body = await request.text()
            if len(raw_body.encode("utf-8")) > 65536:
                return json_response({"error": "payload_too_large"}, status=413, headers=self._cors_headers(request))
            message = json.loads(raw_body)
        except Exception:
            payload = rpc_error(None, JSONRPC_PARSE_ERROR, "Parse error")
            return json_response(payload, status=400, headers=self._cors_headers(request))

        binding = getattr(self.env, "DECISIONS_DB", None)
        session = auth.session_id(subject)
        store = SubjectStore(D1Store(binding), subject, session) if binding is not None else None
        if isinstance(message, dict):
            method = message.get("method")
            audit["method"] = method if method in ("initialize", "ping", "tools/list", "tools/call", "resources/read", "resources/list", "notifications/initialized") else "other"
            params = message.get("params")
            if method == "tools/call" and isinstance(params, dict):
                name = params.get("name")
                audit["tool"] = name if name in [item["name"] for item in tool_definitions()] else "unknown"
                args = params.get("arguments")
                if (name == "record_decision" and message.get("jsonrpc") == "2.0" and valid_id(message)
                        and "id" in message and isinstance(args, dict) and args.get("session_id") != session):
                    return json_response(rpc_error(message["id"], -32602, "Use the server-issued session_id"))
        response_message = await handle_rpc_message_async(message, store, request_id=audit["requestId"])
        if isinstance(response_message, dict):
            if response_message.get("error", {}).get("code") == -32603:
                response_message["error"]["data"] = {"requestId": audit["requestId"]}
            if isinstance(message, dict) and message.get("method") == "initialize" and "result" in response_message:
                response_message["result"]["session_id"] = session
        if response_message is None:
            return text_response("", status=202, headers=self._cors_headers(request))
        return json_response(response_message, headers=self._cors_headers(request))

    async def _tts(self, request):
        headers = self._cors_headers(request)
        try:
            length = header_value(request, "Content-Length")
            if length and (not length.isdecimal() or int(length) > 65536):
                return json_response({"error": "payload_too_large"}, status=413, headers=headers)
            raw = await request.text()
            if len(raw.encode()) > 65536:
                return json_response({"error": "payload_too_large"}, status=413, headers=headers)
            text = polly.speech_text(json.loads(raw))
        except (ValueError, TypeError):
            return json_response({"error": "Expected 1 to 300 sanitized text characters"}, status=400, headers=headers)
        try:
            audio = await polly.synthesize(text, lambda name: env_value(self.env, name))
        except polly.VoiceUnavailable:
            return json_response({"error": "voice unavailable"}, status=503, headers=headers)
        return text_response(audio, headers={**headers, "Content-Type": "audio/mpeg"})

    def _handle_options(self, request):
        if not self._origin_allowed(request):
            return text_response("Forbidden", status=403)
        return text_response("", status=204, headers=self._cors_headers(request))

    async def _limit(self, name, key):
        binding = getattr(self.env, name, None)
        if binding is None:
            raise RuntimeError("Rate limiter unavailable")
        options = {"key": key}
        try:
            from pyodide.ffi import to_js
            from js import Object
            options = to_js(options, dict_converter=Object.fromEntries)
        except ImportError:
            pass
        result = await binding.limit(options)
        return result.get("success", False) if isinstance(result, dict) else bool(result.success)

    def _authorized(self, request):
        scheme, _, token = header_value(request, "Authorization").partition(" ")
        if scheme.lower() != "bearer" or len(token) > 8192:
            return None
        hashes = env_value(self.env, "MCP_JUDGE_TOKEN_HASHES")
        return auth.judge_subject(token, hashes) or auth.verify_token(
            token, env_value(self.env, "MCP_JWT_SECRET"), env_value(self.env, "MCP_RESOURCE_URL"),
            hashes, env_value(self.env, "MCP_CLIENT_ID"))

    async def _token(self, request, audit):
        if not self._origin_allowed(request):
            return json_response({"error": "forbidden_origin"}, status=403)
        if request.method == "OPTIONS":
            return self._handle_options(request)
        if request.method != "POST":
            return text_response("Method Not Allowed", status=405, headers={"Allow": "POST, OPTIONS"})
        if not await self._limit("IP_LIMITER", auth.subject_hash(header_value(request, "CF-Connecting-IP") or "local")):
            return json_response({"error": "rate_limited"}, status=429)
        audience = env_value(self.env, "MCP_RESOURCE_URL")
        if urlparse(request.url).path == "/oauth/judge":
            scheme, _, token = header_value(request, "Authorization").partition(" ")
            subject = auth.judge_subject(token, env_value(self.env, "MCP_JUDGE_TOKEN_HASHES")) if scheme.lower() == "bearer" else None
        else:
            subject = auth.client_subject(header_value(request, "Authorization"), env_value(self.env, "MCP_CLIENT_ID"), env_value(self.env, "MCP_CLIENT_SECRET"))
        if not subject:
            return unauthorized_response(audience, self._cors_headers(request))
        audit["subject"] = auth.subject_hash(subject)
        if not await self._limit("SUBJECT_LIMITER", audit["subject"]):
            return json_response({"error": "rate_limited"}, status=429)
        length = header_value(request, "Content-Length")
        if length and (not length.isdecimal() or int(length) > 65536):
            return json_response({"error": "payload_too_large"}, status=413)
        raw = await request.text()
        if len(raw.encode()) > 65536:
            return json_response({"error": "payload_too_large"}, status=413)
        if urlparse(request.url).path == "/oauth/token":
            form = parse_qs(raw, max_num_fields=10)
            if form.get("grant_type") != ["client_credentials"]:
                return json_response({"error": "unsupported_grant_type"}, status=400)
            if "resource" in form and form["resource"] != [audience]:
                return json_response({"error": "invalid_target"}, status=400)
        token = auth.issue_token(subject, env_value(self.env, "MCP_JWT_SECRET"), audience)
        return json_response({"access_token": token, "token_type": "Bearer", "expires_in": 3600,
                              "session_id": auth.session_id(subject)}, headers=self._cors_headers(request))

    def _origin_allowed(self, request):
        return origin_allowed(
            header_value(request, "Origin"),
            request.url,
            env_value(self.env, "MCP_ALLOWED_ORIGINS"),
        )

    def _cors_headers(self, request):
        origin = header_value(request, "Origin")
        if not origin or not self._origin_allowed(request):
            return {}
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Expose-Headers": "mcp-protocol-version",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }


def env_value(env, name):
    try:
        value = getattr(env, name)
    except Exception:
        return ""
    if value is None:
        return ""
    return str(value)


def header_value(request, name):
    try:
        value = request.headers.get(name)
    except Exception:
        try:
            value = request.headers[name]
        except Exception:
            return ""
    if value is None:
        return ""
    return str(value)


def base_headers():
    return {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }


def text_response(body, status=200, headers=None):
    merged = {**base_headers(), **(headers or {})}
    return Response(body, status=status, headers=merged)


def json_response(payload, status=200, headers=None):
    return json_response_raw(json_dumps(payload), status, headers)


def json_response_raw(body, status=200, headers=None):
    merged = {"Content-Type": "application/json; charset=utf-8", **base_headers(), **(headers or {})}
    return Response(body, status=status, headers=merged)


def unauthorized_response(audience="", headers=None):
    body = json_dumps({"error": "unauthorized"})
    merged = {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": f'Bearer resource_metadata="{audience.removesuffix("/mcp")}/.well-known/oauth-protected-resource"',
        **base_headers(),
        **(headers or {}),
    }
    return Response(body, status=401, headers=merged)
