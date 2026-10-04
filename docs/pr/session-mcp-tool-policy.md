## Summary

- New `policy.mcp.json`: per-tool entries mapping tool name to allowed caller group ids plus a `requireConfirm` flag (`addTodo`/`listTodos` open to hr, manager, software-developer; `deleteAllTodos` manager-only with confirmation; `fetchUrl` manager/software-developer with confirmation).
- Group-based tool authorization enforced in the grant registry (`src/hub/grants.ts`): the tool policy is consulted on every grant check, with explicit `grant()`/`revoke()` overrides always winning over the file.
- Token-based confirmation gate in the hub governor (`src/hub/governance.ts`): the first call to a `requireConfirm` tool returns `confirmation-required` with an opaque token and executes nothing; repeating the call with `{ ..., "confirm": token }` executes the stored arguments. Tokens are single-use, group-bound, and expire after 5 minutes.
- New additive `mcp_tool_calls` table plus migration (`drizzle/0001_add-mcp-tool-calls.sql`): append-only usage rows (tool, group, user, verdict, latency, token estimate, confirmation outcome, policy version) with time/tool/user/group/verdict indexes. Existing tables are untouched.
- Usage hook and aggregation queries (`src/hub/tool-usage.ts`): governance reports every terminal outcome through a plain `ToolUsageSink` callback; `recordToolCall` persists rows and `toolCallCounts` aggregates calls per tool per verdict for dashboard stats.
- Pure audit-sink summary for dashboard stats: `summarizeToolUsage` derives per-tool, per-group, and per-verdict counts plus confirmation requests from in-memory audit events for surfaces that never open the database.
- Hub wiring (`src/hub/runtime.ts`, `src/hub/mcp-server.ts`, `src/hub/loop.ts`, `src/db/index.ts`, `src/db/schema.ts`, `src/env.ts`, `src/control/audit.ts`, `src/control/guard.ts`): policy store startup with hot-reload, durable writes plumbed through the usage sink, `mcp-tool` seam on tool-call audits.
- Signature engine untouched: detection and redaction remain LLM-gateway only per scope; tool-call arguments and results pass through the existing control pipeline without signature changes.
- Tests: `tests/tool-policy.test.ts` (16), `tests/hub-tool-policy.test.ts` (13), `tests/tool-usage.test.ts` (11).

## Design

Tool-call authorization lives in a separate `policy.mcp.json` because it answers a different question than `policy.json`: `policy.json` owns how content is inspected (thresholds, detectors, semantic governance) while the tool policy owns who may call which tool. An unlisted tool is denied once a policy is loaded (fail closed), but a missing or unreadable file makes the registry abstain so the hub falls back to grant-registry defaults and local development keeps working without the file. Confirmation replays the stored arguments rather than the confirming call's arguments so an approval cannot be re-targeted at new arguments after the fact. Database writes are best-effort fire-and-forget: the hub never blocks on SQLite, and the in-memory audit sink remains the record when `DATABASE_URL` is unset.

## Validation

- `bun run typecheck` — pass (tsc clean).
- `bun run test` — 718 pass, 0 fail, 2076 expects, 56 files (includes 16 tool-policy, 13 hub-tool-policy, 11 tool-usage tests).
- `bun run verify` — pass (tsc + biome clean, 176 files).
- Fresh-DB migrate check — `DATABASE_URL=file:/tmp/verify-mcp.db bun run db:migrate` applied 0000 + 0001 cleanly; tables `audit_events`, `mcp_tool_calls`, `usage_records` present; existing tables untouched (0001 contains only `CREATE TABLE mcp_tool_calls` + 5 indexes).

To try it: point an MCP client at `/mcp` with `x-user-id` / `x-user-group-id` headers, call a gated tool (e.g. `deleteAllTodos`), then confirm via a second call carrying the returned token in `confirm`.
