# PR: session/architecture-doc

## Summary

- `fix(hub)`: wire the policy document's `consumers` table into the runtime
  consumer resolver (`consumerPolicyFromDocument()` in
  `src/control/subjects.ts`, used by `src/hub/runtime.ts`). Each
  policy-defined key governs as its own subject; unknown and missing keys keep
  the configured default-subject or rejection behavior.
- `fix(policy)`: bind deterministic enforcement to the active policy snapshot
  (`src/control/policy/live-control.ts`). The pipeline's detection control is
  rebuilt per policy version, so a hot reload changes enforcement on the next
  interaction without a restart, and no valid policy fails closed.
- `test`: three new suites pinning the guarantees:
  `tests/concurrency-isolation.test.ts` (interleaved multi-subject requests
  keep verdicts and audit attribution correct; unknown keys never inherit a
  known subject's policy), `tests/consumer-policy.test.ts` (policy document to
  consumer-policy derivation), `tests/policy-live-control.test.ts` (live
  rebinding across policy versions, fail-closed without policy).
- `docs`: accuracy updates to `docs/architecture.md` on top of the landed
  document: module map and implementation status now reflect the merged
  signature engine, model allowlist, semantic control, dashboard/audit-export
  routes; the policy engine section documents the live enforcement binding and
  which configuration remains startup-resolved; the multi-tenancy section
  records the audit export's known-key gate.
- `feat(ui)`: the shadcn dashboard component set (`chart` on recharts,
  `table`, `tabs`, `dropdown-menu`, `select`, `progress`, `separator`,
  `skeleton`, `tooltip`), the recharts dependency, and the rewritten theme
  tokens in `src/styles.css`.

## Design

Both fixes came from observing the hosted app rather than reading code. The
runtime resolved every consumer key to the default subject (the policy's key
table was never wired), and enforcement was pinned to the startup policy
snapshot (a removed rule kept blocking until restart). The fixes are narrow:
one pure mapping helper and one control wrapper, each with its own test.

## Validation

- `bun test`: 227 pass, 0 fail, 9 skip (the `SEMANTIC_LIVE=1` opt-in tier),
  including the three new suites; `bun run verify` passes.
- **Live multi-user observation**: the hosted app answered 24 concurrent
  `POST /api/guard` requests across 4 consumer keys in under 60 ms each with
  governed verdicts; PII payloads were redacted to `[EMAIL]` with verdict
  `redact` on every subject; an unknown key followed the configured
  default-subject behavior.
- **Live hot-reload cycle**, without restart: clean policy `200 allow`, rule
  added `403 block`, rule reverted `200 allow`.
- **Mixed-payload burst** (6 payload classes x 3 subjects, 18-way concurrent):
  `allow`, typed-placeholder `redact`, deterministic `block` (403), malformed
  and out-of-shape `400` responses all matched the documented behavior.
- The two gaps above (empty `knownKeys`, stale enforcement) were found by these
  observations and are covered by the new tests.
