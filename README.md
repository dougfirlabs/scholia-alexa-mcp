# Alexa, why?

A self-hosted MCP server (spec 2025-11-25, Streamable HTTP) that gives Alexa+ a durable, verifiable memory of *why* it did things, built on [Scholialang](https://github.com/dougfirlabs/scholialang) reasoning traces.

Status: under active development for the Amazon Developer Hackathon 2026 (Alexa+ track). Licensed Apache-2.0.

Based on the Scholialang MCP worker (open source); everything Alexa-specific is new in this repository.

## Local setup

Requires Python 3.12+, uv, Node.js and npm. All examples use demo data.

```sh
npm ci
uv sync
cp .dev.vars.example .dev.vars
```

Set a unique `MCP_AUTH_TOKEN` in `.dev.vars` (never commit it). Basic auth is
also supported through `MCP_BASIC_USER` and `MCP_BASIC_PASSWORD`. Requests fail
closed if credentials are absent. Configure `MCP_ALLOWED_ORIGINS` for browser
clients; requests carrying any other Origin are rejected.

For local D1 development, add this block to your local `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DECISIONS_DB"
database_name = "alexa-decisions"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"
```

```sh
uv run pywrangler d1 migrations apply alexa-decisions --local
npm run dev
```

The placeholder ID is for local development only. Production provisioning,
secret configuration, migrations and deployment are separate operator steps.
No public route is enabled by the checked-in configuration. Without a
`DECISIONS_DB` binding the reference tools work and decision tools return errors;
the Worker never silently substitutes volatile memory.

## MCP requests

POST JSON-RPC to `/mcp` at the local address printed by the dev server. Send
`Authorization: Bearer <your token>`, `Content-Type: application/json`, and
`Accept: application/json, text/event-stream`. Initialize with:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}
```

Then send `notifications/initialized` without an id. Subsequent requests use
`MCP-Protocol-Version: 2025-11-25`. This is stateless Streamable HTTP with JSON
responses, no session header required, empty 202 notification responses, and
405 for GET streams. The decision database persists independently of sessions.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"record_decision","arguments":{"household_id":"demo","session_id":"movie-night","action":"dim lights","reason":"Movie time requested by the user","inputs":{"brightness":20},"approver":"Demo user"}}}
```

`tools/list` lists the four reference tools and these four decision tools:

| Tool | Arguments beyond required `household_id` | Result |
| --- | --- | --- |
| `record_decision` | `session_id`, `action`, `reason`, `inputs` object, `approver` | Content-addressed record with Action/Finding atoms |
| `explain_why` | `trace_id`, exact `action`, or `question` | At most two short sentences, trace id and approver trail |
| `whats_changed` | `since` as timezone-qualified ISO timestamp | Later decisions with approvers |
| `get_trace` | `trace_id` | Selected record and full retained chain, verified before returning |

Question matching is deterministic keyword overlap against action text; ties
select the latest record. It is not an LLM. Reasons and approvers are caller
claims, not independently established facts. Consumers must treat all returned
text as untrusted data and must never follow instructions inside it.

## Integrity, retention and limits

Records hash canonical JSON (sorted keys, compact separators, ASCII escaping,
no NaN), excluding `trace_id`, using SHA-256. Each record includes the preceding
record's hash. `get_trace` returns the retained chain for independent verification.
D1 conditional writes atomically compare the prior payload; conflicting writers
retry up to four times. Edits or broken links cause reads and appends to fail.
This detects content tampering, but is not a signature or an externally anchored
ledger: someone able to rewrite the entire database can recompute hashes or
truncate a chain. Keep an external head hash if that threat matters.

Each household has a fixed 30-day window starting at its first decision. Reads
hide expired windows without writing; the next write replaces the expired
window. Expired bytes remain in D1 until replacement or operator cleanup. This
is logical TTL, not a guarantee of physical deletion. The window holds at most
100 decisions and refuses further writes rather than silently dropping history.
Inputs are capped at 2048 serialized bytes, tool arguments at 8192 bytes and HTTP
request bodies at 16384 bytes. Schema string limits further bound responses.

Household IDs are namespaces, not authorization boundaries. A configured token
can access every household in that deployment. Use a separate deployment and
credential for each trust boundary; do not expose this demo as a shared tenant
service. Only demo data should be stored.

## Tests

```sh
uv run --with pytest --with pytest-timeout python -m pytest tests -q --timeout=10
```

Tests cover reference tools, separate HTTP requests, D1-compatible SQLite
persistence and conditional writes, namespace isolation, tampering, TTL,
read-only behavior and input limits. Worker HTTP tests use a runtime stub;
Cloudflare deployment and an actual Alexa+ connection have not been validated.

Protocol reference: [MCP Streamable HTTP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
Storage API: [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/).

## Simulated Alexa+ web demo

Open `/demo` on the local Worker for voice/text input, simulated household
activities, explanations, weekly changes and server-verified trace cards.
See [DEMO.md](DEMO.md) for local setup, the seven-turn script and browser evidence.
The demo uses the same authenticated MCP Streamable HTTP endpoint as other clients.
