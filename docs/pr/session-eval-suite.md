## Summary

- Adds a judge-facing evaluation suite under `tests/eval/` with a shared
  harness (`harness.ts`) that runs every scenario against the shipped
  `policy.json` + `signatures.json` through the product pipeline stages:
  `benign.test.ts` (10 positive cases that must allow with no hits),
  `attacks.test.ts` (13 negative cases pinning verdict, deciding control,
  and rule id per abuse class), `live-config.test.ts` (8 rehearsals of
  judge edits — disabling the signature stage, per-signature and severity
  overrides, feed removal/restore hot-reload, corrupt-feed last-good
  fallback, policy reload with last-valid retention and threshold edits),
  and `telemetry.test.ts` (5 checks on audit rows, verdict/control/group
  filters, JSONL/CSV exports, and the dashboard summary).
- Adds a `bun run eval` script that runs only the evaluation suite.
- Complements the per-user-tracking PR (coverage/unit tests for consumers,
  dashboard, and hub internals) with end-to-end scenario coverage; no
  overlapping cases.

## Design

Scenarios rebuild pipelines from deep clones of the shipped controls, and
feed/policy reload tests use temp files, so the suite never mutates repo
artifacts and stays hermetic (no network, no API keys). The one judgment
call baked in: sentence-initial `Jaka` is redacted as a person by the
names index, so the Polish positive case uses `Czy jutro będzie padać?`
instead — the `Jaka` collision is a known false positive, not asserted.

## Validation

- `bun run eval`: 36 pass, 0 fail across 4 files.
- `bun run verify` (tsc + biome): clean.
- `bun test`: 398 pass, 0 fail, 9 skip (43 files).
