# Design

## Context

See `proposal.md` for motivation. Current state: a bare TanStack Start app (React 19,
Vite, Nitro, Biome) with one demo MCP route (`src/routes/mcp.ts` over
`src/utils/mcp-handler.ts`), an in-memory todos module, Drizzle + better-sqlite3 with a
single `todos` table, zod + t3-env for env validation, and `@tanstack/ai@0.64.0` already
installed. Constraints that shape this design:

- Judges execute the test suite themselves with **no paid subscriptions** and no
  credentials, and will poke the running system with ad-hoc prompts and config edits.
- Everything must run self-hosted (Nitro Node server); no reliance on Vercel-only
  infrastructure.
- Jev (TypeSafe AI) is the chosen semantic decision model: typed answers with calibrated
  confidence in 70-500 ms, input-only token cost, early-access API requiring a key.

## Goals / Non-Goals

**Goals:**

- One enforcement pipeline shared by all interception seams, with verdicts decided in
  exactly one place (the policy engine).
- Semantic tier swappable at the interface level: real Jev, hermetic mock, local fallback.
- Deterministic tier must be able to decide the common case without any model call.
- Every decision observable: audit, metrics, budget state.
- Test suite deterministic and credential-free by default.

**Non-Goals:**

- Training or fine-tuning any classifier; Jev is consumed as a hosted decision model.
- Identity/authn provider integration; consumer keys are presented via header and mapped
  to policy subjects, not authenticated against an IdP.
- A full human-review workflow UI; escalation is recorded and surfaced in the dashboard,
  resolution is out of scope.
- Replacing the app's chat/model stack; the layer wraps existing flows, it does not own
  agent behavior.

## Decisions

### D1. In-process middleware pipeline inside TanStack Start, not a separate proxy service
The control layer is a `src/control/` pipeline module invoked by three enforcement seams:
the generic guard API (`src/routes/api.guard.ts`), a chat seam introduced by this change
(a guarded chat endpoint plus demo page — the repo currently has no chat route), and the
existing MCP route (`src/routes/mcp.ts`). A thin `guardInteraction()` wrapper exposes the
SDK-style integration the challenge mentions. Alternative: standalone reverse proxy (extra deployable, harder for judges to
run) or SDK-only (trivially bypassed, no central reporting). Single-process keeps the
"lightweight" requirement and reuses the existing Nitro deployment story.

### D2. Jev through TanStack AI `decide()` with `@tanstack/ai-typesafe`, behind a `SemanticClassifier` interface
`@tanstack/ai@0.64.0` already exports `decide()`, `choice()`, `score()`, `boolean()`, and
`BaseEvaluateAdapter` with the exact TypeSafe wire format (`choice`/`score`/`noul`).
`@tanstack/ai-typesafe` (the official direct-TypeSafe adapter) supplies the transport;
our `SemanticClassifier` interface wraps `decide()` and carries a `mockDecider`
(fixed answers) and an optional `ollamaFallbackDecider` (small local model via
`@tanstack/ai-ollama`, same question shapes, degraded quality). Because
`@tanstack/ai-ollama` is a chat adapter with no evaluate activity, the fallback is a
custom evaluate implementation: its free-form output is untrusted text, so answers are
strictly validated into the wire shape (invalid output fails closed), and confidence —
which a chat model cannot calibrate — is derived from distribution concentration
(1 - normalized entropy). Alternatives: Vercel AI
Gateway (requires Vercel account/OIDC, conflicts with self-host constraint), raw fetch to
the TypeSafe REST API (reimplements answer mapping and typing), AI SDK
`experimental_evaluate` (second AI stack in a TanStack AI repo). Configuration injected at
the module boundary so tests never touch the network.

### D3. Question catalog in code, policy controls activation and thresholds
Semantic question definitions (instructions, criteria) live in a typed TS catalog so
answer handling keeps `decide()`'s compile-time unions. The policy file enables/disables
questions, sets per-profile probability/confidence thresholds, and may override question
wording for judge tunability. Rationale: judges mainly need to flip controls and
thresholds (explicitly named in the challenge), while typed answers keep the verdict
mapper safe. Alternative (fully declarative questions in policy) buys flexibility at the
cost of type safety; retained as an override path.

### D4. Cheap-first pipeline order
`shape validation -> model allowlist -> signature feed -> deterministic PII/secrets ->
budget pre-flight -> semantic tier -> verdict mapping`. Deterministic `block` is final and
skips the semantic call; deterministic `redact` is applied before semantic evaluation sees
the text. Rationale: latency and cost stay near zero for the common case, and signature
detections never depend on model availability. Alternative (parallel tiers) reduces
worst-case latency but spends Jev tokens on requests deterministic rules would have
blocked.

### D5. Verdict model: `allow | redact | block | escalate`, per direction, decided only by policy
Evidence (matches, probabilities, confidence) flows into a pure
`applyPolicy(evidence, profile)` function. Uncertainty and tool failures map to the
profile's failure verdict (default `block` for failures, `escalate` for low confidence).
Escalation = audit entry flagged for review, content not forwarded. This is the
"classification is advisory to policy" boundary: identical Jev answers can yield different
verdicts under different profiles, which is also what makes the threshold behavior
unit-testable.

### D6. Policy as versioned JSON with zod validation and file-watch hot reload
One `policy.json` (plus sample variants `policy.permissive.json`, `policy.strict.json`)
validated by a zod schema shared with runtime checks. A watcher swaps an immutable policy
snapshot atomically; each request reads one snapshot and stamps its version hash into the
audit record. Invalid reloads keep the last valid policy and log the error. JSON over
YAML: zod-native, no parser dependency, diff-friendly for judges.

### D7. SQLite (Drizzle) for audit, usage, and budget state
Three new tables: `audit_events` (append-only, one row per governed interaction with
evidence JSON), `usage_records` (tokens, cost, latency per call, incl. Jev's own usage),
and `budget_windows` (key, window, counters). Windows are computed by time bucket, so
rollover needs no cron. Alternatives: Postgres (operational overhead), in-memory (loses
audit durability), files (no queryability for dashboards/exports).

### D8. Hermetic test suite by default, live smoke suite opt-in
Vitest drives the suite with `mockDecider` fixtures and temp SQLite files; every spec
scenario maps to a test. A `test:live` script (gated on `TYPESAFE_API_KEY`) exercises the
real Jev path. Judges run `bun run test` and get deterministic pass/fail with no network
or keys — mandatory given the no-paid-services evaluation setup.

### D9. Budget enforcement: estimate pre-flight, settle post-flight
Token estimates (chars/4 heuristic plus fixed overhead) reserve budget before forwarding;
actual usage from the model response settles and reconciles. Jev input tokens count toward
the layer's own metering so semantic cost is visible. Over-budget uses the policy's
over-budget verdict (default `block`).

## Risks / Trade-offs

- [Jev is early-access; judges may lack a key] → The suite is hermetic (D8); the
  `SemanticClassifier` interface keeps quality-degraded local fallback possible (D2);
  docs state plainly which tier needs the key.
- [Semantic misclassification / overconfidence] → Calibrated probabilities with per-action
  confidence floors (D5); deterministic tier is independent and final for its classes;
  thresholds tuned per profile with the fail-closed default.
- [Added latency on the guarded path] → Cheap-first ordering (D4); single `decide()` call
  with questions in parallel; per-stage latency recorded in audit for the telemetry the
  challenge asks for. Budget a p95 target of ~100 ms deterministic / ~600 ms with semantic.
- [Prompts leave the house when using hosted Jev] → Policy option to disable the semantic
  tier per consumer or route sensitive traffic to the local fallback; state passed to Jev
  is trimmed to the fields the decision needs.
- [Policy hot-reload races] → Immutable snapshot per request with version stamping (D6).
- [Fallback classifier answers are not calibrated or schema-native] → Strict validation
  of fallback output into the wire shape (invalid → fail closed), derived confidence from
  distribution concentration, and floors that treat derived confidence as suspect.
- [Signature feed false positives] → Severity-keyed actions with policy overrides;
  provenance in audit (see spec) makes tuning observable.
- [SQLite write contention under load] → WAL mode and single-process Nitro keep this
  within bounds for the expected demo scale; a real deployment would swap the audit sink
  interface to a remote store.

## Migration Plan

Additive, no breaking changes to existing routes. Steps:

1. Dependencies and env: add `@tanstack/ai-typesafe`, `vitest`, `TYPESAFE_API_KEY`
   (optional), keep `DATABASE_URL`.
2. Drizzle schema additions and migration (`bun run db:generate` / `db:migrate`).
3. Ship `policy.json` + sample profiles + `signatures.json`; wire loader and hot reload.
4. Land pipeline stages and seams behind a policy kill-switch (`controls.enabled: false`
   passes traffic through and audits only) so rollout can start in observe-only mode.
5. Enable enforcement per seam; dashboard and export last.

Rollback: set `controls.enabled: false` (traffic flows, auditing continues) or revert to
the previous policy file; the DB additions are unused-but-harmless.

## Open Questions

- Escalation disposition: for the demo, flagged interactions are listed in the dashboard
  with no approve/reject action. A lightweight review action can be added later without
  spec changes (the spec only requires recording and not forwarding).
- Whether the demo showcase traffic source is the existing MCP todos tool or a small chat
  page; both seams are covered by the pipeline either way.
- OpenTelemetry export for telemetry beyond the metrics surface; audit and metrics
  already satisfy the requirement, OTel is additive.
