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
  `telemetry.test.ts` (6 checks on audit rows, verdict/control/group
  filters, JSONL/CSV exports including RFC 4180 quoting, and the dashboard
  summary), `stages.test.ts` (14: model allowlist, failure precedence,
  control timeouts, redaction merging, malformed envelopes),
  `semantic-stub.test.ts` (8: threshold ladder, uncertainty flagging,
  fail-closed classifier errors, group-scoped checks),
  `chat.test.ts` (5: both chat directions, model never called on block),
  `hub.test.ts` (8: governed catalog, refusals, grants, identity),
  `names.test.ts` (4: known names redact, unknown words and places pass),
  `profiles.test.ts` (5: strictness divergence across profiles),
  `file-audit.test.ts` (2: durable JSONL trail),
  `detectors.test.ts` (12: every secret family plus PII and near-misses),
  and `evasion.test.ts` (5: case/spacing caught, leet and base64 left to
  the semantic tier) — 100 scenarios total.
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
Zero-width smuggling (`DA\u200bN`) also slips past the feed today and is
left to the semantic tier; leet-speak and raw base64 are asserted as
regex-tier passes for the same documented reason.

## Validation

- `bun run eval`: 100 pass, 0 fail across 13 files.
- `bun run verify` (tsc + biome): clean.
- `bun test`: 462 pass, 0 fail, 9 skip (52 files).
