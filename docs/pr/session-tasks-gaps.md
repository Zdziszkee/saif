## Summary

- Closes the stale-checkbox batch in `openspec/changes/ai-control-layer/tasks.md`: flips 1.3 (new `src/lib/jev/` alias), 3.3 (`docs/storage.md` now covers all three tables), 5.5, 10.3, 10.4 (15s polling documented as the mechanism), 12.2, 13.1, 13.2 doc-half; fixes the 11.1 note (live derivation, no fixture reference). 4.3, 5.1, 5.3, 5.4, 5.6, 5.7 stay open with documented reasons (need code-side fixture/matcher/safety/provenance work).
- Env (`src/env.ts`): adds optional `TYPESAFE_API_KEY`, `POLICY_PATH`, `SIGNATURES_PATH`, `BUDGET_WINDOW_DEFAULT`; semantic tier reads via `env` with runtime fallback. App boots keyless.
- Storage (`src/db/`): `DATABASE_URL` defaults to `file:data/saif.db` with lazy `getDb()`; new `audit-repo.ts` (append-only insert + filtered query) and `usage-repo.ts` (insert + windowed spend aggregation, NULL-aware); product sink fans out to SQLite best-effort. First-run migration noted at the default path; `data/*.db` gitignored.
- Budget (`src/control/budget.ts`, `pipeline.ts`): pure in-memory ledger (estimator, UTC bucket math, reserve/settle/reconcile, rule check); pipeline takes optional `checkBudget` instead of hardcoded `overBudget:false`. Metrics helpers (spend-vs-limits, unpriced counts) added to dashboard derivation.
- Gateway (`src/routes/v1.chat-completions.ts`, `src/control/pricing.ts`): `POST /v1/chat/completions` with identity-first lifecycle, group-selected checks, SSE passthrough, LiteLLM price cache (NULL = unpriced), windowed usage tracker; `ChatAsk` wired via governed loop. Hub-surface guard gets a justified gateway carve-out allowlist with a `guardInteraction` enforcement assertion (D10 intact for MCP routes).
- Docs/demo: `scripts/demo-traffic.ts` (allow/redact/block/escalate walkthrough with verdict assertions), `docs/demo.md`, README judge quickstart + harness pointer, `docs/performance.md` with measured deterministic timings (sub-ms p50/p95, no network).

## Design

One branch, five parallel workers on disjoint file sets; the only cross-worker conflict (D10 guard vs gateway transport) resolved as an explicit allowlist rather than import evasion, so the invariant stays enforced. No `budget_windows` table (storage doc deliberate omission stands); settlement composes from recorded usage. `src/control/semantic/` stays canonical.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean, 206 files checked.
- `bun run test`: 825 pass, 0 fail across 66 files; keyless rerun (`env -u TYPESAFE_API_KEY`): 825 pass, 0 fail.
- Perf harness: benign p50 0.218/p95 0.534ms; exploit prompts 0.10–0.18ms p50 (bun 1.4.2 darwin, 200 iters).
- Demo script exits 0 against live dev server with all 5 verdicts asserted.
