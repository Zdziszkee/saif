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

## Detailed Solution Design (per requirement)

Concrete solution for each challenge requirement, layered cheap-first. Pipeline stage order
itself is D4; this section specifies what each stage actually does.

### R1. Centralized policy engine

- **Document shape**: `policy.json` = `{ version, defaults { profile, failureVerdict },
  consumers { <key-hash>: { profile, overrides } }, controls { shape, allowlist, signatures,
  redaction, budget, semantic }, observability }`. Zod schema is the single definition,
  shared by runtime loader and tests; unknown keys rejected (`z.strictObject`).
- **Resolution order**: base document → profile overlay (permissive/standard/strict,
  deep-merge) → per-consumer / per-route override. Precedence is deterministic and
  documented in `docs/policy.md`; every merge result is itself schema-valid.
- **Hot reload**: `fs.watch` + 250 ms debounce → parse → validate → compute
  `policyVersion = sha256(canonical JSON)` → atomic snapshot swap (each request pins one
  snapshot and stamps the version into its audit row). Invalid reload keeps last valid
  policy and emits an audit error event. Startup with no valid policy refuses to run
  (fail closed); the explicit `controls.enabled: false` kill-switch is the observe-only mode.
- **Judge tunability**: thresholds, actions, allowlists, question activation/wording are all
  policy fields; nothing security-relevant is hard-coded outside the pattern catalog.

### R2a. Deterministic (non-AI) controls — layered regex defense

The "first line of defense" is a layered detector pipeline. Regex is layer 1, but validators
(layer 2) are what keep it precise enough to act on:

- **L0 Shape & limits**: envelope schema validation (seam, direction, content size ≤ 64 KB),
  control-char stripping, malformed → fail closed. Rejects garbage before any scanning.
- **L1 Pattern catalog (regex)** — one pass, named catalog `{ id, kind, regex, validator? }`,
  compiled once at load:
  - *Provider-shaped secrets (high precision)*: AWS `AKIA[0-9A-Z]{16}`,
    GitHub `gh[pousr]_[A-Za-z0-9]{36,}`, Slack `xox[baprs]-[0-9A-Za-z-]{10,}`,
    Google `AIza[0-9A-Za-z_-]{35}`, Stripe `(sk|pk)_(live|test)_…`, OpenAI-style
    `sk-[A-Za-z0-9_-]{20,}`, JWT `eyJ[A-Za-z0-9_-]+\.eyJ…\.…`,
    PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----`.
  - *Generic credential assignments*: `(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*…`.
  - *PII*: pragmatic email subset, E.164-ish phone with separators and context words,
    payment card `\b(?:\d[ -]?){13,19}\b`, IBAN `\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b`,
    US SSN `\b\d{3}-\d{2}-\d{4}\b`, configurable national-ID patterns.
- **L2 Validators (false-positive killers)**: Luhn for cards, IBAN mod-97, checksums for gov
  IDs, nearby keyword context ("cvv", "iban", "password"). Regex hit without validator pass
  downgrades to `suspect` (default action redact, not block).
- **L3 Entropy scan**: token runs (length ≥ 20, base64/hex-shaped) with Shannon entropy
  ≥ ~3.5–4.0 bits/char → generic-secret `suspect`. Catches unknown credential formats.
- **L4 Encoding-aware re-scan**: bounded decode (base64/URL/hex, depth ≤ 2) then re-run L1
  on decoded text. Catches light obfuscation of secrets/injection.
- **Output contract**: `Detection { kind, span, detectorId, confidence, validated }`.
  Redaction maps kinds to typed placeholders (`[EMAIL]`, `[CARD_LAST4:4242]`, `[API_KEY]`),
  per-kind action (allow/redact/block) comes from policy. Redacted text is the only input
  later stages (semantic tier) may see (D4 + R2b egress rules).
- **Implementation choice**: in-house typed pattern catalog (tables in code), no heavy
  dependency — judge-tunable, license-clean, fixture-tested. Per-pattern length cap and
  match budget; `re2js` (linear-time) is the drop-in if catastrophic backtracking shows up.

### R2b. Semantic (AI-based) controls — Jev

- **Question catalog** (one round trip, questions evaluated in parallel against one `state`):
  `noul` booleans (prompt injection? jailbreak? data exfiltration request? malicious code?),
  `choice` (threat category, full distribution), `score` (severity 0–1). Catalog is typed TS;
  policy toggles activation and may override wording/thresholds (D3).
- **Egress minimization (no sensitive data to Jev)**: `state` is a constructed allowlist
  object (`{ role, direction, content, contentLength, flags[] }`) built in exactly one
  function from post-redaction text of the inspected span only — no history, system prompts,
  tool schemas, or keys. Consistent pseudonyms (`[USER_1]`) preserve relational structure;
  truncation to `maxChars` happens after redaction/pseudonymization.
- **Egress gate**: deterministic detectors run once more over the exact serialized `state`
  before `decide()`; residual sensitive span → policy `residualSensitiveAction`
  (`block` default / `escalate` / `redact-and-send`).
- **Routing**: `controls.semantic.egress.mode`: `minimized` (default) | `local-only`
  (force Ollama/mock classifier for sensitive consumers/routes) | `off` (deterministic-only).
- **Consumption**: confidence floors per action; below floor → profile's uncertainty verdict
  (default `escalate`). Timeout bounded, failure verdict fail-closed. Classification is
  advisory: only `applyPolicy()` maps answers to verdicts (D5).

### R3. Budget and resource governance

- **Pre-flight**: token estimate = chars/4 + per-message overhead → reserve against
  `budget_windows` in one SQLite transaction (conditional upsert: `used + estimate ≤ limit`).
  Model allowlist checked earlier in the pipeline (with shape validation).
- **Post-flight**: settle from actual usage (model response + Jev input tokens — the layer
  meters its own semantic spend), reconcile against the reservation (refund delta).
- **Windows**: tumbling time buckets (hour/day) keyed `(subject, model, window)`; bucket is
  computed from timestamp, so rollover is free (D7). Over-budget → policy's over-budget
  verdict (default `block`).
- **Burst control (optional refinement)**: token-bucket rate limit per consumer for runaway
  agent loops, complementing the windowed spend cap.

### R4. Historical attack mitigation (signature feed)

- **Feed format** `signatures.json`: entries `{ id, name, description, pattern, kind, severity,
  source, addedAt, action? }` with kinds `prompt_injection | jailbreak | tool_abuse |
  unsafe_deserialization | supply_chain`. Loaded at startup and hot-reloaded like the policy;
  per-entry validation, invalid entries skipped with an audit warning (one bad row never
  kills the feed).
- **Matching**: compiled pattern set applied to prompts, tool calls, and outputs (same L1
  pass slot). Severity → default action, overridable in policy. Provenance (`id`, `source`)
  lands in the audit row so false-positive tuning is observable.
- **Seed entries**: classic injection markers ("ignore previous instructions", persona
  overrides), tool-abuse shapes (`rm -rf /`, `curl … | bash`), unsafe deserialization
  (`__reduce__`, `yaml.load(`, `pickle.loads`), supply-chain markers (install-script hooks,
  known-malicious/typosquat package names).

### R5. Security reporting and auditing

- **Audit**: append-only `audit_events` (WAL) — timestamp, interaction id, seam, direction,
  consumer key hash, policy version hash, verdict + control hits, semantic answer summary,
  redaction counts, usage, per-stage latency. Raw outbound state is never logged.
- **Metrics**: aggregation queries over audit/usage (verdicts by control and category,
  redactions, budget consumption, latency p50/p95/p99) served to the dashboard via polling;
  incrementally maintained counters if query cost matters.
- **Export**: `/api/audit/export` as JSONL and CSV with filters (time range, verdict,
  control, consumer key) — parseable output for security teams.

### R6. Self-testing suite

- **Hermetic by default** (D8): `mockDecider` fixtures, temp SQLite, no network/keys.
- **Fixture matrix per control**: positive (allowed) and negative (blocked/redacted) cases;
  every spec scenario maps to at least one test.
- **Cross-cutting tests**: profile divergence (same evidence, different verdicts), budget
  exhaustion and reconciliation, policy/feed hot reload, seam tests (guard API, chat, MCP),
  and the Jev leak suite (captured `decide()` body contains zero raw sensitive spans).
- **Live smoke** (`test:live`, gated on `TYPESAFE_API_KEY`): real Jev path end to end.

### Problem → controls map (challenge §1)

| Problem | Controls |
| --- | --- |
| Over-broad access / impersonation | subject keys + model allowlist, tool-call governance in the MCP seam, per-consumer policy overrides |
| Prompt injection & sensitive output | R2a L1–L4 inbound + output direction, R2b semantic questions, signature feed (R4) |
| Runaway loops / resource blowup | budget windows + reservations (R3), optional token-bucket rate limit, per-stage latency telemetry (R5) |

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
