# TypeScript Worker verification

The deployed entry point is `src/index.ts`. The unchanged Python implementation
is retained in `legacy/python/` as an executable compatibility reference.
`src/reference.json` is exported by `scripts/export_reference.py`; it preserves
the existing catalog, examples, resources, initialization response and schemas.
The runtime dependencies are `lossless-json` (numeric token preservation) and
`entities` (HTML entity decoding). Cryptography uses Worker WebCrypto APIs.

## Compatibility checks

```sh
npm ci
npm run typecheck
npm test
uv run --with pytest --with pytest-timeout python -m pytest tests -q --timeout=10
```

Tests use Node's built-in SQLite module (Node 22.13+). Python tests load the
legacy modules through `tests/conftest.py`. Set `PYTHON` for the TypeScript test
that invokes the independent Python verifier when using a different interpreter.
Python fixture generation: `python scripts/generate_fixtures.py`.
TypeScript fixture regeneration: `REGENERATE_TS_FIXTURE=1 npm test`.
Both fixture producers must be reviewed independently of the implementations.
Shared fixtures cover Unicode key ordering and escaping, negative zero, integral
floats, fractional timestamps, exponent notation, integers above 2^53, eviction
anchors and record hashes. No D1 migration or data rewrite is required.

## Local latency evidence (2026-10-22)

Measured against a fresh `wrangler dev --local --ip 127.0.0.1 --port 18787`
process with the checked-in rate limits and a local D1 database. The benchmark
records one synthetic decision in household `latency` and issues 20 requests per
method. Run it only against an authorized test environment.

```sh
MCP_TOKEN="$LOCAL_TEST_TOKEN" LATENCY_SAMPLES=20 LATENCY_MAX_P95_MS=100 \
  node scripts/latency.mjs http://127.0.0.1:18787
```

| Request | p50 | p95 |
| --- | ---: | ---: |
| tools/list | 4.00 ms | 5.19 ms |
| tools/call explain_why | 9.84 ms | 10.92 ms |

The first initialize request after starting the local server took 34.31 ms.
This is a local first-request probe, not a Cloudflare remote isolate cold-start
measurement. Remote latency and actual Alexa+ connectivity remain operator
validation steps; this run does not deploy or submit anything. The default
20-sample benchmark stays within the 60/minute subject limit when run alone;
wait for the rate window before repeating it or running other traffic.

The demo's existing Playwright suite exercises the same TypeScript server at
desktop and mobile widths. AWS signing is checked against the independently
computed fixture already used by the Python tests. No live AWS credentials are
needed; real Polly playback remains a separately authorized integration check.

Final local checks: 13 TypeScript tests, 45 Python tests, and all 9 existing
Playwright tests passed. Browser evidence covers 1920, 1440 and 390 pixel
viewports with no unexpected console errors or failed requests. Screenshots
and semantic assertion JSON were captured in the local test evidence directory.
The first browser attempt used a stale dev-server credential; restarting
Wrangler after changing `.dev.vars` resolved token exchange without an app change.
