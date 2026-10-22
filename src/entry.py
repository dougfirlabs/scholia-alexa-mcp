import json
from urllib.parse import urlparse

from workers import Response, WorkerEntrypoint
from store import D1Store

from mcp_protocol import (
    JSONRPC_PARSE_ERROR,
    SUPPORTED_PROTOCOL_VERSIONS,
    authorize_header,
    handle_rpc_message_async,
    json_dumps,
    origin_allowed,
    rpc_error,
)


MCP_PATH = "/mcp"
HEALTH_PATH = "/healthz"


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url = urlparse(request.url)

        if url.path in {"/demo", "/demo/", "/demo/app.js", "/demo/style.css"}:
            if request.method not in {"GET", "HEAD"}:
                return text_response("Method Not Allowed", status=405, headers={"Allow": "GET, HEAD"})
            return await self.env.ASSETS.fetch(request)

        if url.path == MCP_PATH and request.method == "OPTIONS":
            return self._handle_options(request)

        if url.path not in {MCP_PATH, HEALTH_PATH}:
            return text_response("Not Found", status=404)

        origin_check = self._origin_allowed(request)
        if not origin_check:
            return json_response({"error": "forbidden_origin"}, status=403)

        authorized, reason = self._authorized(request)
        if not authorized:
            return unauthorized_response(reason, self._cors_headers(request))

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

        protocol_version = header_value(request, "MCP-Protocol-Version")
        if protocol_version and protocol_version not in SUPPORTED_PROTOCOL_VERSIONS:
            payload = rpc_error(None, -32602, "Unsupported MCP-Protocol-Version", {"supported": SUPPORTED_PROTOCOL_VERSIONS})
            return json_response(payload, status=400, headers=self._cors_headers(request))

        try:
            raw_body = await request.text()
            if len(raw_body.encode("utf-8")) > 16384:
                return json_response({"error": "payload_too_large"}, status=413)
            message = json.loads(raw_body)
        except Exception:
            payload = rpc_error(None, JSONRPC_PARSE_ERROR, "Parse error")
            return json_response(payload, status=400, headers=self._cors_headers(request))

        binding = getattr(self.env, "DECISIONS_DB", None)
        store = D1Store(binding) if binding is not None else None
        response_message = await handle_rpc_message_async(message, store)
        if response_message is None:
            return text_response("", status=202, headers=self._cors_headers(request))
        return json_response(response_message, headers=self._cors_headers(request))

    def _handle_options(self, request):
        if not self._origin_allowed(request):
            return text_response("Forbidden", status=403)
        return text_response("", status=204, headers=self._cors_headers(request))

    def _authorized(self, request):
        return authorize_header(
            header_value(request, "Authorization"),
            env_value(self.env, "MCP_AUTH_TOKEN"),
            env_value(self.env, "MCP_BASIC_USER") or "scholia",
            env_value(self.env, "MCP_BASIC_PASSWORD"),
        )

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


def unauthorized_response(reason, headers=None):
    body = json_dumps({"error": "unauthorized", "reason": reason})
    merged = {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": 'Bearer realm="scholialang-mcp", Basic realm="scholialang-mcp"',
        **base_headers(),
        **(headers or {}),
    }
    return Response(body, status=401, headers=merged)
