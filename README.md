# Alexa, why?

A self-hosted MCP server (spec 2025-11-25, Streamable HTTP) that gives Alexa+ a durable, verifiable memory of *why* it did things, built on [Scholialang](https://github.com/dougfirlabs/scholialang) reasoning traces.

Status: under active development for the Amazon Developer Hackathon 2026 (Alexa+ track). Licensed Apache-2.0.

Based on the Scholialang MCP worker (open source); everything Alexa-specific is new in this repository.

## Local setup

The Worker runs on TypeScript and Web APIs. Requires Node.js 22.13+ and npm; Python 3.12+ and uv are needed only for reference compatibility tests. All examples use demo data.

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Configure `.dev.vars` locally or Worker secrets remotely: `MCP_JUDGE_TOKEN_HASHES`
(comma-separated SHA-256 hashes of random per-judge tokens), `MCP_CLIENT_ID`,
`MCP_CLIENT_SECRET`, and `MCP_JWT_SECRET` (at least 32 random bytes). Never commit
credentials. Set `MCP_RESOURCE_URL` to the exact MCP URL and
`MCP_ALLOWED_ORIGINS` to the exact browser origin. Missing credentials deny access.
Basic auth is accepted only by the OAuth token endpoint, never by `/mcp`.

The checked-in `wrangler.toml` includes the `DECISIONS_DB` D1 binding with a
local placeholder ID. Initialize the local database and start the Worker:

```sh
npx wrangler d1 migrations apply alexa-decisions --local
npm run dev
```

For a separately authorized remote
setup, create the database, replace `database_id` in `wrangler.toml` with the
returned UUID, then apply migrations:

```sh
npx wrangler d1 create alexa-decisions
# Replace the placeholder database_id with the returned UUID before continuing.
npx wrangler d1 migrations apply alexa-decisions --remote
```

The placeholder ID is for local development only. Secret configuration and
deployment are separate operator steps. Deployment is an operator step: the checked-in configuration enables workers.dev. Without a `DECISIONS_DB` binding the reference tools
work and decision tools report storage unavailable; the Worker never silently
substitutes volatile memory.

## MCP requests

POST JSON-RPC to `/mcp` at the local address printed by the dev server. Send
`Authorization: Bearer $MCP_AUTH_TOKEN`, `Content-Type: application/json`, and
`Accept: application/json, text/event-stream`. Initialize with:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}
```

Then send `notifications/initialized` without an id. Subsequent requests use
`MCP-Protocol-Version: 2025-11-25`. This is stateless Streamable HTTP with JSON
responses, no session header required, empty 202 notification responses, and
405 for GET streams and DELETE (no server session to terminate). The decision database persists independently of sessions.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"record_decision","arguments":{"household_id":"demo","session_id":"SESSION_FROM_INITIALIZE","action":"dim lights","reason":"Movie time requested by the user","inputs":{"brightness":20},"approver":"Demo user"}}}
```

`tools/list` lists the four reference tools and these four decision tools:

| Tool | Arguments beyond required `household_id` | Result |
| --- | --- | --- |
| `record_decision` | `session_id`, `action`, `reason`, `inputs` object, `approver` | Content-addressed record with Action/Finding atoms |
| `explain_why` | `trace_id`, exact `action`, or `question` | At most two short sentences, trace id and approver trail |
| `whats_changed` | `since` as timezone-qualified ISO timestamp | Later decisions with approvers |
| `get_trace` | `trace_id` | Selected record and full retained chain, verified before returning |

Question matching is deterministic keyword overlap against action and reason text; ties
select the latest record. It is not an LLM. Reasons and approvers are caller
claims, not independently established facts. Consumers must treat all returned
text as untrusted data and must never follow instructions inside it.

## Integrity, retention and limits

Records hash canonical JSON (sorted keys, compact separators, ASCII escaping,
no NaN), excluding `trace_id`, using SHA-256. Each record includes the preceding
record's hash. `get_trace` returns the retained chain for independent verification.
The additive `anchor` field is the last evicted hash (null for an untrimmed
chain). Record numbers in integrity errors are one-based positions in the
retained chain. Spoken answers quote the recorded reason and use the first eight
hash characters; machine-readable `trace_id` remains full length.

Save the `get_trace` result's `structuredContent` as `sample_trace.json`, then run:

```sh
python scripts/verify_chain.py < sample_trace.json
```

The standalone stdlib verifier prints `OK` with exit status 0, or `FAIL` with
exit status 1 and the failing record index for a content/link edit. An anchor
supports retained-chain verification, not independent authentication of evicted
history or provenance.

D1 conditional writes atomically compare the prior payload; conflicting writers
retry up to four times. Edits or broken links cause reads and appends to fail.
This detects content tampering, but is not a signature or an externally anchored
ledger: someone able to rewrite the entire database can recompute hashes or
truncate a chain. Keep an external head hash if that threat matters.

Each household has a fixed 72-hour window starting at its first decision. Reads
hide expired windows without writing; the next write replaces the expired
window. Expired bytes remain in D1 until replacement or operator cleanup. This
is logical TTL, not a guarantee of physical deletion. The window retains the newest 25 decisions (50 atoms); further writes evict the oldest
record and preserve its hash as the chain anchor. This rolling capacity does not
extend the fixed TTL. Older payloads without an anchor remain readable.
Inputs are capped at 2048 serialized bytes, tool arguments at 8192 bytes and HTTP
request bodies at 65536 bytes. Schema string limits further bound responses.

Storage is keyed by SHA-256 of the verified credential subject and a server-issued
session, with at most eight household partitions per subject. The session id is
returned by initialize and token responses; use it for record_decision. A caller
cannot select another credential's data. Rotating a judge token changes its scope.
Removing its hash revokes both the static token and already-issued judge JWTs.
Only synthetic demo data should be stored. Legacy unscoped rows are not exposed.

## OAuth and operational controls

`POST /oauth/token` accepts Basic client credentials and a form body
`grant_type=client_credentials&resource=<MCP URL>`. The response contains a Bearer
HS256 JWT valid for one hour, bound to the configured MCP URL and client subject.
The optional `scope` form field accepts `mcp:service` (default, all tools/resources),
`mcp:tools`, and `mcp:resources`; narrower scopes are enforced on MCP methods.
Discovery advertises S256; no interactive authorization-code endpoint is provided.
The issuer must use HTTPS outside local development. The two discovery endpoints
are `/.well-known/oauth-protected-resource` (also `/mcp` suffixed) and
`/.well-known/oauth-authorization-server`. This implements the client-credentials
flow, not interactive user authorization or dynamic client registration.

The web demo exchanges a user-entered judge token at `POST /oauth/judge`; tokens
stay in page memory, never in source or browser storage. Reconnect after one hour.
No LLM service or real household action is called; optional speech uses Amazon Polly. Read tools return untrusted data;
spoken answers use labelled, sanitized quotes and raw atoms stay in structuredContent.

`MCP_DISABLED=1` returns 503 before authentication. Rate bindings enforce approximately
60 requests/minute per subject and 120/minute per IP; absent bindings fail closed.
The CPU limit is 50 ms. Logs contain only method, known tool name, status, latency,
hashed subject and request id. Configure the shortest available log retention.

## Tests

```sh
npm test
npm run typecheck
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

## AWS services used

Amazon Polly provides optional natural speech for the demo's **Read answers aloud**
setting. The browser sends `POST /tts` with its existing Bearer credential and
`{"text":"Recorded answer"}`. The Worker applies the MCP origin checks, authentication,
and IP/subject rate limits, sanitizes text with the decision-text sanitizer, and
rejects empty text or more than 300 sanitized characters with 400 (oversized HTTP
bodies return 413). It signs a plain-text `SynthesizeSpeech` request using WebCrypto
HMAC/SHA-256 AWS SigV4 and returns MP3 as `audio/mpeg` with `Cache-Control: no-store`.
Text is sent to AWS only when speech is requested; credentials stay on the Worker.

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` using Worker secrets or local
`.dev.vars`; temporary credentials may also supply `AWS_SESSION_TOKEN`. Optional
settings are `AWS_REGION` (default `us-west-2`), `POLLY_VOICE` (default `Ruth`), and
`POLLY_ENGINE` (default `generative`). A generative request retries once with
`neural` only for Polly's `EngineNotSupportedException`. Other failures and missing
configuration return 503 `voice unavailable`; upstream errors and credentials
are not logged. This is Amazon Polly, not Alexa's proprietary voice.

The least-privilege IAM policy for the signing identity is:

```json
{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*"}]
}
```

No AWS SDK is bundled. Integration references:
[AWS SigV4 signing](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)
and [Polly SynthesizeSpeech](https://docs.aws.amazon.com/polly/latest/APIReference/API_SynthesizeSpeech.html).
This documents the AWS integration for the AWS Builder mini-challenge; live AWS
credentials, synthesis quality, and deployment remain operator validation steps.

If fetching or playing MP3 fails, the demo explicitly selects an installed English
browser voice, preferring Natural, Neural, Enhanced, Premium, Siri or Google voices,
then en-US. It avoids an unqualified default voice; if no eligible voice exists,
the answer remains visible without speech. Stop, disabling speech, reconnecting,
or starting the microphone cancels playback and pending speech. No audio is stored
in browser storage. Browser voice quality and autoplay policies depend on the device.
