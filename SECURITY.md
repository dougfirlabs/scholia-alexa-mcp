# Security

This is a demo endpoint: use synthetic data only, no personal data.
For confidential vulnerability reports, contact the maintainers through
[GitHub private vulnerability reporting](https://github.com/dougfirlabs/scholia-alexa-mcp/security/advisories/new).
Do not put credentials or personal data in public issues.

Threat model:

- Stolen credentials authorize their subject until revoked; judge hashes are independently revocable and OAuth tokens expire within one hour.
- Other subjects cannot read or write a credential's storage; server-issued sessions and bounded partitions prevent arbitrary namespace creation.
- Recorded text is untrusted, sanitized data, never executable instructions. Templates label spoken quotes; model consumers must not follow quoted instructions.
- Request, string, chain, retention, rate and CPU limits bound resource abuse. Logical expiry is not guaranteed physical erasure.
- Hash chains detect edits relative to a trusted head; a database administrator can rewrite an entire chain. They do not prove authorship.

Secrets belong in Worker secrets or ignored `.dev.vars`. No deployment or actual
Alexa+ integration is implied by the local test results. Keep the demo off until
credentials, rate bindings, dedicated database and endpoint configuration are verified.
