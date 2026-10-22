# Developer friction

| Area | Severity | Observed friction | Suggestion |
| --- | --- | --- | --- |
| MCP | Medium | Seed dispatch was synchronous while persistent bindings require await | Keep envelope/reference dispatch reusable and provide an async tool boundary |
| Python Workers | Medium | Worker runtime imports are unavailable in ordinary Python test execution | Provide lightweight transport stubs plus a SQLite-backed D1 binding double; retain a separate runtime smoke gate |
| Storage | Medium | Concurrent read/append/write can overwrite another decision | Use D1 conditional writes and bounded conflict retries |
| Retention | Medium | Deleting individual linked records breaks historical verification | Expire a whole bounded household window and document logical TTL versus physical cleanup |
| Test setup | Low | System Python had no pytest installed | Use the repository's uv-managed test environment |
| Alexa+ | Pending | No live Alexa+ client was connected in this implementation run | Validate discovery, credentials and spoken output in a separate operator-controlled smoke test |
