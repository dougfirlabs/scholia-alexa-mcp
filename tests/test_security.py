"""Security boundaries exercised through the Worker transport and protocol."""
import base64
import json
import sys
import time
import types
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import auth
import mcp_protocol as protocol
from store import MemoryStore, SubjectStore, append, TTL_SECONDS, MAX_RECORDS
from test_alexa import Binding, FIELDS, Limiter, Request, Response

with patch.dict(sys.modules, {"workers": types.SimpleNamespace(Response=Response, WorkerEntrypoint=object)}):
    import entry


def worker():
    result = entry.Default()
    result.env = types.SimpleNamespace(MCP_JUDGE_TOKEN_HASHES=auth.subject_hash("demo"),
        MCP_JWT_SECRET="k" * 32, MCP_CLIENT_ID="client", MCP_CLIENT_SECRET="client-secret",
        MCP_RESOURCE_URL="https://example.com/mcp", DECISIONS_DB=Binding(),
        IP_LIMITER=Limiter(), SUBJECT_LIMITER=Limiter())
    return result


def run(coro):
    import asyncio
    return asyncio.run(coro)


def rpc(name, args=None, message_id=1):
    return {"jsonrpc": "2.0", "id": message_id, "method": "tools/call",
            "params": {"name": name, "arguments": args or {}}}


@pytest.mark.parametrize("value", [None, True, [], {}, float("nan"), float("inf")])
def test_invalid_ids(value):
    message = rpc("record_decision", FIELDS, value)
    assert protocol.handle_rpc_message(message)["error"]["code"] == -32600
    assert run(protocol.handle_rpc_message_async(message, MemoryStore()))["error"]["code"] == -32600


@pytest.mark.parametrize("args", [{"format": []}, {"format": "exe"}, {"id": "x" * 8193}, {"extra": 1}])
def test_reference_schema(args):
    assert protocol.handle_rpc_message(rpc("scholialang.get_example", args))["result"]["isError"]


def test_lint_linear_and_generic_error():
    start = time.perf_counter()
    protocol.lint_snippet("<Step " * 34000)
    assert time.perf_counter() - start < .05
    with patch.object(protocol, "dispatch_request", side_effect=RuntimeError("sensitive exception")):
        result = protocol.handle_rpc_message({"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert result["error"]["code"] == -32603
    assert result["error"]["data"]["requestId"]
    assert "sensitive" not in json.dumps(result)


def test_auth_revocation_and_jwt_validation():
    hashes = auth.subject_hash("one") + "," + auth.subject_hash("two")
    assert auth.judge_subject("one", hashes)
    assert auth.judge_subject("two", hashes)
    assert not auth.judge_subject("one", auth.subject_hash("two"))
    token = auth.issue_token("client", "k" * 32, "https://example.com/mcp", now=10)
    verify = lambda value, **kw: auth.verify_token(value, "k" * 32, kw.get("aud", "https://example.com/mcp"), client_id="client", now=kw.get("now", 11))
    assert verify(token) == "client"
    assert not verify(token, now=3610)
    assert not verify(token, aud="https://wrong.example/mcp")
    assert not verify(token[:-3] + "aaa")
    judge = auth.issue_token("judge:" + auth.subject_hash("one"), "k" * 32, "https://example.com/mcp")
    assert auth.verify_token(judge, "k" * 32, "https://example.com/mcp", hashes)
    assert not auth.verify_token(judge, "k" * 32, "https://example.com/mcp", auth.subject_hash("two"))


def test_http_limits_kill_auth_and_metadata():
    w = worker()
    req = Request({})
    req.headers = {**Request.headers, "Content-Length": "65537"}
    async def unread():
        raise AssertionError("body must not be read")
    req.text = unread
    assert run(w.fetch(req)).status == 413
    assert run(w.fetch(Request({"x": "a" * 65537}))).status == 413
    for hashes in ("", auth.subject_hash("demo")):
        w.env.MCP_JUDGE_TOKEN_HASHES = hashes
        req = Request({})
        req.headers = {"Authorization": "Basic " + base64.b64encode(b"client:client-secret").decode()}
        response = run(w.fetch(req))
        assert response.status == 401
        assert json.loads(response.body) == {"error": "unauthorized"}
        assert "resource_metadata" in response.headers["WWW-Authenticate"]
    w.env.MCP_DISABLED = "1"
    assert run(w.fetch(req)).status == 503
    w.env.MCP_DISABLED = "0"
    for path in ("oauth-protected-resource", "oauth-protected-resource/mcp", "oauth-authorization-server"):
        req = Request({}); req.method = "GET"; req.url = "https://example.com/.well-known/" + path
        assert run(w.fetch(req)).status == 200


def test_oauth_transport_and_judge_exchange():
    w = worker()
    req = Request({}); req.url = "https://example.com/oauth/token"
    req.headers = {"Authorization": "Basic " + base64.b64encode(b"client:client-secret").decode()}
    async def body():
        return "grant_type=client_credentials&resource=https%3A%2F%2Fexample.com%2Fmcp"
    req.text = body
    response = run(w.fetch(req))
    assert response.status == 200
    token = json.loads(response.body)["access_token"]
    req = Request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    req.headers = {**Request.headers, "Authorization": "Bearer " + token}
    assert run(w.fetch(req)).status == 200
    assert "result" in json.loads(run(w.fetch(req)).body)
    req = Request({}); req.url = "https://example.com/oauth/judge"
    response = run(w.fetch(req))
    assert response.status == 200
    assert json.loads(response.body)["session_id"] == auth.session_id("judge:" + auth.subject_hash("demo"))


def test_subject_isolation_caps_sanitizer_and_logging(caplog):
    async def scenario():
        store = MemoryStore()
        a, b = SubjectStore(store, "a", "issued"), SubjectStore(store, "b", "issued")
        await append(a, FIELDS)
        assert await b.load("demo") is None
        for i in range(7):
            await append(a, {**FIELDS, "household_id": str(i)})
        with pytest.raises(ValueError, match="capacity"):
            await append(a, {**FIELDS, "household_id": "ninth"})
    run(scenario())
    assert TTL_SECONDS == 72 * 3600 and MAX_RECORDS * 2 <= 50
    w = worker()
    subject = "judge:" + auth.subject_hash("demo")
    fields = {**FIELDS, "session_id": auth.session_id(subject),
              "reason": '<speak>Secret utterance\x00 <audio src="https://evil.example"/>www.evil.example</speak>'}
    with caplog.at_level("INFO"):
        response = run(w.fetch(Request(rpc("record_decision", fields))))
    row = json.loads(response.body)["result"]
    assert not row["isError"]
    assert "atoms" not in row["content"][0]["text"]
    assert "<" not in row["structuredContent"]["reason"]
    assert "\x00" not in row["structuredContent"]["reason"]
    assert "evil.example" not in row["structuredContent"]["reason"]
    assert "Secret utterance" not in caplog.text and "Bearer" not in caplog.text
    request = Request(rpc("explain_why", {"household_id": "demo", "trace_id": row["structuredContent"]["trace_id"]}))
    assert "the recorded reason was" in json.loads(run(w.fetch(request)).body)["result"]["content"][0]["text"]
    w.env.MCP_JUDGE_TOKEN_HASHES += "," + auth.subject_hash("other")
    request.headers = {**Request.headers, "Authorization": "Bearer other"}
    assert json.loads(run(w.fetch(request)).body)["result"]["isError"]
    bad = run(w.fetch(Request(rpc("record_decision", FIELDS))))
    assert "error" in json.loads(bad.body)


def test_limiter_and_unconfigured_fail_closed():
    class Denied:
        async def limit(self, options):
            return {"success": False}
    w = worker(); w.env.IP_LIMITER = Denied()
    assert run(w.fetch(Request({}))).status == 429
    w.env.IP_LIMITER = Limiter(); w.env.SUBJECT_LIMITER = Denied()
    assert run(w.fetch(Request({}))).status == 429
    del w.env.IP_LIMITER
    assert run(w.fetch(Request({}))).status == 500


@pytest.mark.parametrize("message", [[], {"jsonrpc": "2.0", "id": {}, "method": "tools/call"},
    {"jsonrpc": "2.0", "id": 1, "method": []}, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": None}])
def test_malformed_http_envelopes_are_rpc_errors(message):
    response = run(worker().fetch(Request(message)))
    assert response.status == 200
    assert json.loads(response.body)["error"]["code"] in (-32600, -32602)


def test_internal_request_id_matches_audit(caplog):
    with patch.object(protocol, "dispatch_request", side_effect=RuntimeError("private data")), caplog.at_level("INFO"):
        response = run(worker().fetch(Request({"jsonrpc": "2.0", "id": 1, "method": "ping"})))
    request_id = json.loads(response.body)["error"]["data"]["requestId"]
    assert request_id in caplog.text and "private data" not in caplog.text
