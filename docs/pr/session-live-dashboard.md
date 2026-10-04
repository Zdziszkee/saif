## Summary

- Cuts the dashboard over from fixture-fed metrics to live derivation: `src/dashboard/data.ts` builds posture/verdict counts, threat breakdown, budget usage vs limits, latency p50/p95/p99, and the escalation queue from the policy snapshot plus recorded audit decisions, with zeros/empty lists (no seeded values) when nothing is recorded.
- Enriches the audit decision record (`src/control/audit.ts`): every decision carries verdict, blocking `controlId`, hits, `redactionCount`, `latencyMs`, usage tokens/cost when available, direction/seam/subject, and policy/feed versions.
- Wires the product audit sink to memory plus `data/audit.jsonl` (`src/hub/runtime.ts`); the SQLite `audit_events` / `usage_records` / `budget_windows` tables stay defined in `src/db/` with sink wiring as follow-up.
- Reads the feed badge from the live signature feed store through `getDashboardData` (`src/dashboard/server.ts`) instead of the fixture feed version.
- Keeps the dashboard fresh with a 15s repoll (`REFRESH_INTERVAL_MS`) and explains missing semantic evidence via `TierStatusBanner`, which fetches `GET /api/status` (`getHubStatus`: feed health/version, policy profile/version, semantic enablement/reason) and banners only when the semantic tier is off.
- Updates `docs/architecture.md` (diagram, observability, module map, implementation status) to match the live behavior above.

## Design

Threat rows group recorded hit evidence by control and category and split counts into blocked/flagged/redacted from the decision verdict, so the breakdown reuses what enforcement already recorded instead of fixture categories; latency percentiles are computed from recorded per-decision `latencyMs` (empty input yields zeros, never fixture numbers); budget usage sums usage-event tokens/cost against each policy rule's limit per consumer and window, with computeTimeMs/requests windows left approximate because usage events only carry tokens/cost when available.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean, 187 files checked, no errors.
- `bun run test` (unit tier): 737 pass, 0 fail across 57 files.
- Diagram box alignment rechecked (all box lines 74 chars).
