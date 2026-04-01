---
paths: "**/*.test.ts"
---
# Testing Conventions

- Use existing test infrastructure from `packages/tests/src/_jest/helpers/` — check for mock helpers (e.g., `getMockLogger` from `mocks.ts`) before creating ad-hoc mocks.
- Avoid timing-based waits (`setTimeout`, `sleep`) in tests. Wait for specific conditions instead.
- Tests should exercise meaningful behavior, not just repeat the implementation. If a test only asserts what the code literally does with no edge cases or integration value, it's low-value.
- Follow the `cases` + `test.each` pattern for unit tests with multiple inputs/outputs.
- Use `nock` for HTTP mocking and `memfs` for filesystem mocking in integration tests.
