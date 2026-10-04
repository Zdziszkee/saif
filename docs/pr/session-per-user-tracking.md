## Summary

- Adds per-user (per-consumer-key) tracking end to end: `AuditEvent.consumerKey`, `AuditFilter{consumerKey,since,until}`, `summarizeAuditDecisions().byConsumer`, CSV `consumerKey` column.
- Threads the raw `x-consumer-key` through every seam (guard API, MCP hub, tool-call governance, export-deny path); keyless traffic records `"(none)"`.
- Dashboard gains a By-consumer card, a `?consumer=` selector with isolation view, and per-row consumer attribution; export accepts `consumer`/`consumerKey` + `since`/`until`.
- Adds `dashboard-consumers.ts` / `dashboard-meta.ts` shaping helpers (escalations queue, versions formatting, controls-in-force) and 10 new test files covering audit, guard, governance, export, dashboard, and identity invariants.
- Backfills coverage on the lowest-covered units (placeholders/redact to 100%, model/tools, semantic tier, hub infra, guard fail-closed, pipeline/feed edges).

## Design

Identity reuses the existing consumer-key mapping (`subject == key` for known keys, else the default subject) instead of inventing a new principal type: one optional `consumerKey` field on the audit event keeps the schema append-only and the CSV/JSONL formats backward-compatible. Dashboard filtering is loader-level (`filterByConsumerKey` before `summarizeAuditDecisions`) so every card respects the `?consumer=` selection. Known follow-ups left out of scope: chat seam still records `"(none)"`, budget/cost and latency instrumentation don't exist yet, and the `"none"` vs `"(none)"` keyless label is pinned by tests but not yet unified.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean, 126 files.
- `bun test`: 505 pass, 9 skip, 0 fail across 45 files.
- `bun run build`: success.
- `bun test --coverage`: placeholders.ts and redact.ts to 100% lines; model.ts 27% to 69%, tools.ts to 100%, semantic control.ts to 100%, hub catalog/config/grants to 100%.
