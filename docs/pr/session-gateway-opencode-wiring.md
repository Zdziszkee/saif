## Summary

Makes the OpenCode-over-gateway loop work end to end and surfaces its data
on the dashboard:

- **Gateway ↔ OpenCode wiring**: new `GET /v1/models` serving the policy
  allowlist in OpenAI catalog format (OpenCode's provider setup 404s
  without it); the upstream call now sends `x-opencode-session`
  (generated UUID per request, pinnable) required by Zen Go; settled
  gateway turns fan out into the hub audit sink via a
  `GatewayTurnDeps.onAudit` hook, so gateway traffic reaches the
  dashboard, `/api/decisions`, and `audit.jsonl` — previously it lived in
  SQLite only and the dashboard stayed empty.
- **Dashboard spend**: new "Cost and tokens" plot replaces "Budget
  usage" — linear-time cost line (USD axis, compact ticks, dots on sparse
  series) aggregating gateway `usage_records` and MCP `mcp_tool_calls`
  (new `listToolUsage` query; MCP contributes tokens, never fabricated
  cost); per-user token table; user filter inbox scoping plot and totals;
  escalation tables show the user id, not just the group.
- **Policy**: allowlist adds the Zen Go ids in play
  (`muse-spark-1.3-contributor`, `mimo-v2.6-pro`, gemini ids);
  `local-small` restored (tests/docs/demo reference it).
- Merged `origin/master` (#44–#46) cleanly; no conflicts.

## Design

One non-obvious call: the audit fan-out is a hook on turn deps rather
than a direct hub import, so `src/gateway/lifecycle.ts` keeps no
dependency on the hub runtime (the route wires `getAuditSink`). MCP cost
is tokens-only by construction — the `mcp_tool_calls` table has no cost
column, and the plot refuses to invent dollars (fully-unpriced totals
render `unpriced`).

## Validation

- `bun run test`: 1625 pass / 0 fail (9 pre-existing skips), incl. new
  `gateway-upstream-session`, `dashboard-usage`, `dashboard-cost-series`,
  and `cost-plot` suites.
- `bun run verify` (tsc + biome): clean.
- Live: `mimo-v2.6-pro` streams through identity → allowlist → forward →
  settle with metered usage; redact/block/escalate rows (deterministic,
  signature feed with provenance, live Jev scores) land in the terminal
  decision lines, `audit.jsonl`, `/api/decisions`, and the dashboard.
