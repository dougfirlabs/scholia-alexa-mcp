# Alexa, why? — local demo

This is an independent, simulated Alexa+ experience using a deterministic intent
router. No connection to Alexa devices, stores or booking services is made.
Household actions update the demo activity panel; their decisions are really
persisted by the MCP Worker in local D1. Use demo data only.

## Start locally

1. Run `npm ci` and `uv sync` (Python 3.12+ and Node required).
2. Copy `.dev.vars.example` to `.dev.vars`; replace the token with a random local
   credential. Set `MCP_ALLOWED_ORIGINS=http://localhost:8787,http://127.0.0.1:8787`.
3. Copy `wrangler.toml` to `wrangler.local.toml` (gitignored). Append:

   ```toml
   [[d1_databases]]
   binding = "DECISIONS_DB"
   database_name = "alexa-decisions"
   database_id = "00000000-0000-0000-0000-000000000000"
   migrations_dir = "migrations"
   ```

4. Run `uv run pywrangler d1 migrations apply alexa-decisions --local -c wrangler.local.toml`.
5. Run `uv run pywrangler dev -c wrangler.local.toml --ip 127.0.0.1 --port 8787`.
6. Open <http://127.0.0.1:8787/demo> in Chrome. Enter the token and a new demo
   household name, such as `video-take-1`, then select **Connect securely**.
   Use a fresh name per take to keep the weekly summary to three decisions.

The token is held in page memory, never placed in a URL or browser storage.
The demo always calls the same-origin `/mcp` endpoint. Only the demo assets are
publicly readable; MCP authentication and origin checks still apply. The local
configuration does not enable public ingress. Do not deploy this demo as part
of rehearsal.

## Seven turns, under three minutes

Allow about 15 seconds per turn. Tap **Mic**, speak, review the transcript, and
press **Send**. Typing each turn follows the exact same path. The browser may
ask for microphone permission. Speech recognition availability depends on Chrome,
the operating system and its speech service; localhost is a secure context.

| Turn | Say | Expected result |
| --- | --- | --- |
| 1 | Reorder coffee | Simulated coffee order recorded, with a trace link. |
| 2 | Why did you reorder coffee? | Stored coffee rationale and recorded approver. |
| 3 | Change the evening routine | Simulated lights at 20% at 8 pm. |
| 4 | Why did you change the evening routine? | Stored routine rationale and trace. |
| 5 | Book a cleaner | Simulated visit on Friday at 10 am. |
| 6 | Why did you book a cleaner? | Stored booking rationale and trace. |
| 7 | What changed this week? | Three decisions from the last seven days. |

Finish by selecting **Verify decision trail** on the last card. Expand the JSON
to show the returned Action/Finding atoms and previous-hash links. Verification
is performed by the server over the retained household chain; it is not proof
of authorship or an independent signature. Reasons and approvers are caller
claims. No external purchase or reservation is made.

Read-aloud is on by default. Use **Stop speaking** or uncheck **Read answers
aloud** for a quiet recording. If microphone access fails, the text field remains
available. Unknown prompts show supported examples without recording an action.
A failed tool call does not produce a successful action card. After an ambiguous
network failure, check the weekly trail before retrying (writes are not idempotent).
The activity panel shows this page session; persisted history remains accessible
through weekly changes and explanations after a reload.

## Reproduce browser evidence

With the local Worker still running:

```sh
npx playwright install chromium
npx playwright test web/tests --workers=1 --reporter=line
uv run --with pytest --with pytest-timeout python -m pytest tests -q --timeout=10
```

The browser tests read the local token from `.dev.vars` or `DEMO_TOKEN`, create
unique demo households, and exercise all seven text turns against real local
MCP and D1. They capture screenshots and console/request evidence at desktop
and mobile sizes under `docs/demo-*`. They also check the text fallback and
failed-request behavior. Physical microphone recognition and audible playback
need a manual Chrome check; automated evidence does not claim those passed.

Screenshots: [desktop](docs/demo-1440.png), [mobile](docs/demo-390.png).
