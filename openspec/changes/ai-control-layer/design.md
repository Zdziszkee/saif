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
- Semantic tier behind an interface with the real Jev decision model as the only
  product-path implementation; test doubles live in the test harness only.
- Deterministic tier must be able to decide the common case without any model call.
- Every decision observable: audit, metrics, budget state.
- Test suite deterministic and credential-free by default.

**Non-Goals:**

- Training or fine-tuning any classifier; Jev is consumed as a hosted decision model.
- Identity/authn provider integration; user and group ids are presented via header and mapped
  to policy subjects, not authenticated against an IdP.
- A full human-review workflow; escalations are recorded and surfaced in the dashboard,
  resolution is out of scope.
- Multi-provider model routing; the layer wraps one configured OpenAI-compatible model
  connection.

## Decisions

### D1. In-process middleware pipeline inside TanStack Start, not a separate proxy service
The control layer is a `src/control/` pipeline module invoked by three enforcement seams:
the generic guard API (`src/routes/api.guard.ts`), a chat seam (the guarded chat demo page
and its prompt/answer direction), and the tool-call surface (`src/routes/mcp.ts`). A thin `guardInteraction()`
wrapper exposes the SDK-style integration the challenge mentions. Alternative: standalone reverse proxy (extra deployable, harder for judges to
run) or SDK-only (trivially bypassed, no central reporting). Single-process keeps the
"lightweight" requirement and reuses the existing Nitro deployment story.

### D2. Jev through TanStack AI `decide()` with `@tanstack/ai-typesafe`, behind a `SemanticClassifier` interface
`@tanstack/ai@0.64.0` already exports `decide()`, `choice()`, `score()`, `boolean()`, and
`BaseEvaluateAdapter` with the exact TypeSafe wire format (`choice`/`score`/`noul`).
`@tanstack/ai-typesafe` (the official direct-TypeSafe adapter) supplies the transport;
our `SemanticClassifier` interface wraps `decide()`; fixed-answer doubles are injected at
the interface boundary only by the unit-test harness. Alternatives: Vercel AI
Gateway (requires Vercel account/OIDC, conflicts with self-host constraint), raw fetch to
the TypeSafe REST API (reimplements answer mapping and typing), AI SDK
`experimental_evaluate` (second AI stack in a TanStack AI repo). Configuration injected at
the module boundary so tests never touch the network.

### D3. Binary semantic checks defined by `policy.jev.json`
Every semantic check is a binary yes/no question authored in `policy.jev.json` at the
project root and answered by Jev in one round trip. There is no question catalog in code:
that file is the catalog, and a judge adds a guardrail — "Does this text contain insider
trading information?" — by appending a check entry. Each check carries `id`,
`type: "boolean"`, `instructions`, `enabled`, and per-direction threshold ladders.

Jev configuration is deliberately kept out of the policy engine's `policy.json`. That
document owns *whether* the semantic tier runs and *how strictly* its evidence maps to
verdicts (`profiles.*.thresholds.semantic`, `enabledControls.semantic`); `policy.jev.json`
owns *what the model is asked*, plus the deadline, decisiveness floor and egress cap. One
concern per file, so a Jev change is one edit in one place and the two owners can work
independently.

Binary-only keeps the answer contract uniform — one P(true) per check — so the verdict
mapper is a single generic ladder rather than a switch over question kinds. Rationale:
judges need to define what the model checks, not only flip toggles (explicitly named in
the challenge). Trade-off: no compile-time narrowing on answer *ids* (they are config
data), so answers are runtime-validated against their declared check definitions and
unusable answers fail closed.

### D4. Cheap-first pipeline order
`shape validation -> model allowlist -> signature feed -> deterministic PII/secrets ->
budget pre-flight -> semantic tier -> verdict mapping`. Deterministic `block` is final and
skips the semantic call; deterministic `redact` is applied before semantic evaluation sees
the text. Rationale: latency and cost stay near zero for the common case, and signature
detections never depend on model availability. Alternative (parallel tiers) reduces
worst-case latency but spends Jev tokens on requests deterministic rules would have
blocked.

### D5. Verdict model: `allow | redact | block | escalate`, per direction, decided only by policy
Evidence (matches, probabilities) flows into a pure
`applyPolicy(evidence, profile)` function. Uncertainty and tool failures map to the
profile's failure verdict (default `block` for failures, `escalate` for low decisiveness).
Escalation = audit entry flagged for review, content not forwarded. This is the
"classification is advisory to policy" boundary: identical Jev answers can yield different
verdicts under different profiles, which is also what makes the threshold behavior
unit-testable.

### D6. Policy as zod-validated JSON with file-watch hot reload
One policy document (plus sample variants `policy.permissive.json`, `policy.strict.json`)
validated by a zod schema shared with runtime checks. A watcher swaps an immutable policy
snapshot atomically; each request reads one snapshot and stamps its version hash (sha256 of
canonical JSON) into the audit record. Invalid reloads keep the last valid policy and log
the error. JSON over YAML: zod-native, no parser dependency, diff-friendly for judges.

### D7. SQLite (Drizzle) with two tables sized for the dashboard
`audit_events` (one row per governed interaction) and `usage_records` (one row
per forwarded model call). Both are indexed on `ts`, `user_id + ts` and
`user_group_id + ts` so every dashboard dimension is a covered query rather than
a scan.

Deliberately not stored: pipeline latency, per-hit detail rows, raw upstream
status, and a separate budget table. Budget limits are enforced by aggregating
`usage_records` over a time window, so recorded spend is the single source of
truth and there is no reservation state to reconcile. `prompt_text` is kept only
for `block`/`escalate`, where it is evidence; allowed traffic is stored without
content. Rationale: the reporting surfaces are the only consumer of this data,
so each column has to earn its place against a dashboard query.

### D8. Hermetic test suite by default, live smoke opt-in
`bun test` drives the suite (the repo standardised on bun alone) with fixed-evidence
doubles injected at the `SemanticClassifier` boundary and temp SQLite files; every spec
scenario maps to a test, and it runs with no network or keys — mandatory given the
no-paid-services evaluation setup, and CI gates merges on bare `bun test`. Live tests sit
behind an explicit `SEMANTIC_LIVE=1` opt-in rather than mere key presence, so a developer
with a real key in their gitignored `.env` cannot make the unit tier reach the network.
`bun run test:integration` sets that flag and exercises the real Jev path, reporting a
clear configuration error when credentials are missing.

### D9. Budget enforcement: estimate pre-flight, settle post-flight
Token estimates (chars/4 heuristic plus fixed overhead) reserve budget before forwarding;
actual usage from the model response settles and reconciles. Jev input tokens count toward
the layer's own metering so semantic cost is visible. Over-budget uses the policy's
over-budget verdict (default `block`).

### D10. LLM gateway seam: OpenAI-compatible endpoint with user/group identity
The control layer is exposed as `POST /v1/chat/completions` in the OpenAI wire
format with SSE token streaming, so a developer agent harness (Claude Code and
similar) can point its `baseURL` at us and work unchanged. Only inbound prompts
are gated; answers stream through untouched and the call is metered on
completion.

Identity is `x-user-id` + `x-user-group-id` rather than an opaque consumer key:
the user is the unit of usage limiting and per-user reporting, the group selects
the policy profile and the semantic check set and is the unit of group
reporting. A missing identity or an unknown group is rejected and audited, never
silently defaulted. This supersedes the consumer-key model the interaction
gateway originally assumed.

Lifecycle order is identity -> usage limit -> deterministic -> semantic ->
forward. Limits run before content validation so an over-limit caller never
consumes decision-model calls. Cost is computed at runtime from the LiteLLM
model price table (cached at startup, cost fields only) — prices are never
hard-coded, and an unpriced model is recorded as unknown cost rather than zero.

## Detailed Solution Design (per requirement)

Concrete solution for each challenge requirement, layered cheap-first. Pipeline stage order
itself is D4; this section specifies what each stage actually does.

### R1. Centralized policy engine

- **Document shape**: `policy.json` = `{ version, defaults { profile, failureVerdict },
  groups { <id>: { profile, overrides } }, controls { shape, allowlist, signatures,
  detection, redaction, budget }, observability }` where `groups` identifies the policy
  subjects (the user groups callers present via `x-user-group-id`).
  `controls.detection` carries custom regex rules (`rules[]` with id, kind, pattern,
  target directions, mapped action) plus built-in detector-family toggles and per-kind
  default actions. Jev question definitions are NOT here: they live in
  `policy.jev.json` at the project root (D3). Zod schema is the single definition,
  shared by runtime loader and tests; unknown keys rejected (`z.strictObject`).
- **Resolution order**: base document → profile overlay (permissive/standard/strict,
  deep-merge) → per-group / per-route override. Precedence is deterministic and
  documented in `docs/policy.md`; every merge result is itself schema-valid.
- **Versioned activation**: dashboard save or JSON import → validate → new version row
  (`policyVersion = sha256(canonical JSON)`) → atomic snapshot swap (each request pins one
  snapshot and stamps the version into its audit row). Invalid edits are rejected and the
  last valid policy stays active; rollback re-activates a prior version row. Startup with
  no valid policy refuses to run (fail closed); the explicit `controls.enabled: false`
  kill-switch is the observe-only mode.
- **Judge tunability**: thresholds, actions, allowlists, custom regex rules, and semantic
  check definitions (type, wording, criteria) are all policy fields; nothing
  security-relevant is hard-coded outside the built-in pattern catalog; semantic checks
  are policy data in their entirety (D3).

### R2a. Deterministic (non-AI) controls — layered regex defense

The "first line of defense" is a layered detector pipeline. Regex is layer 1, but validators
(layer 2) are what keep it precise enough to act on:

- **L0 Shape & limits**: envelope schema validation (seam, direction, content size ≤ 64 KB),
  control-char stripping, malformed → fail closed. Rejects garbage before any scanning.
- **L1 Pattern catalog (regex)** — one pass, named catalog `{ id, kind, regex, validator? }`,
  compiled once at load; policy-defined custom rules (`controls.detection.rules[]`) join
  the same catalog and are regex-validated at policy load:
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
  on decoded text, via the shared `src/control/text/` canonicalization module (also used by
  the signature engine, R4). Catches light obfuscation of secrets/injection.
- **Output contract**: `Detection { kind, span, detectorId, confidence, validated }`.
  Redaction maps kinds to typed placeholders (`[EMAIL]`, `[CARD_LAST4:4242]`, `[API_KEY]`),
  per-kind action (allow/redact/block/flag) comes from policy. Redacted text is the only input
  later stages (semantic tier) may see (D4 + R2b egress rules).
- **Implementation choice**: in-house typed pattern catalog (tables in code), no heavy
  dependency — judge-tunable, license-clean, fixture-tested. Per-pattern length cap and
  match budget; `re2js` (linear-time) is the drop-in if catastrophic backtracking shows up.

### R2b. Semantic (AI-based) controls — Jev

- **Question catalog** (one round trip, questions evaluated in parallel against one `state`):
  the enabled binary checks from `policy.jev.json`, each a TypeSafe `noul` question keyed
  by its check id. Adding, disabling or rewording a check is an edit to that file only
  (D3). The shipped document seeds `prompt_injection`, `jailbreak`, `data_exfiltration`,
  `malicious_code`, `privacy_violation` and `insider_trading` as examples.
- **Egress minimization (no sensitive data to Jev)**: `state` is a constructed allowlist
  object (`{ role, direction, content, contentLength, flags[] }`) built in exactly one
  function from post-redaction text of the inspected span only — no history, system prompts,
  tool schemas, or keys. Consistent pseudonyms (`[USER_1]`) preserve relational structure;
  truncation to `maxChars` happens after redaction/pseudonymization.
- **Egress gate**: deterministic detectors run once more over the exact serialized `state`
  before `decide()`; residual sensitive span → policy `residualSensitiveAction`
  (`block` default / `escalate` / `redact-and-send`).
- **Routing**: the policy's `enabledControls.semantic` turns the tier off for a profile
  (deterministic-only); the egress truncation cap is `maxChars` in `policy.jev.json`.
- **Consumption**: binary answers carry P(true) and no confidence value, so uncertainty is
  measured as decisiveness `max(p, 1 - p)` against a per-action floor; below floor →
  profile's uncertainty verdict (default `escalate`). Answers that do not match their
  declared check definition fail closed. Timeout bounded (the deadline races the call, so
  it holds even against a non-cooperative adapter), failure verdict fail-closed.
  Classification is advisory: only `applyPolicy()` maps answers to verdicts (D5).

### R3. Budget and resource governance

- **Pre-flight**: token estimate = chars/4 + per-message overhead → reserve against
  `budget_windows` in one SQLite transaction (conditional upsert: `used + estimate ≤ limit`).
  Model allowlist checked earlier in the pipeline (with shape validation).
- **Post-flight**: settle from actual usage (model response + Jev input tokens — the layer
  meters its own semantic spend), reconcile against the reservation (refund delta).
- **Windows**: tumbling time buckets (hour/day) keyed `(subject, model, window)`; bucket is
  computed from timestamp, so rollover is free (D7). Over-budget → policy's over-budget
  verdict (default `block`).
- **Burst control (optional refinement)**: token-bucket rate limit per user for runaway
  agent loops, complementing the windowed spend cap.

### R4. Historical attack mitigation (signature engine)

A signature engine detects known historical AI exploits — the L1 pass slot in D4 — designed
to 2025/2026 practice: character-transform evasion defeats naive string matching (studies
show 100% → 0% detection under base64/homoglyph/zero-width/leetspeak transforms), so
matching runs over canonicalized and decoded forms, and MCP tool schemas are an inspection
surface, not just message content.

- **Feed format** `signatures.json`: entries
  `{ id, name, description, pattern, kind, severity, source, references[], addedAt,
  updatedAt, enabled, validator?, action? }` with kinds
  `prompt_injection | jailbreak | tool_abuse | unsafe_deserialization | supply_chain |
  mcp_tool_poisoning | exfiltration`. `references[]` carries external technique ids
  (MITRE ATLAS / OWASP). Feed-level `version` hash computed over canonical content.
  Plain JSON core (judge-editable, zod-validated); external sources are first-class
  ingestion adapters normalizing into the internal schema with external ids retained in
  `references[]` — MITRE ATLAS STIX 2.1 (`mitre-atlas/atlas-data`), OSV API
  malicious-package reports (OpenSSF `MAL-`), and an offline corpus importer
  (JailbreakBench artifacts, in-the-wild jailbreak prompts, the AISec 2026 prompt-injection
  benchmark, tldrsec, PayloadsAllTheThings) — classified against OWASP LLM Top 10 2026,
  Agentic AI Top 10 (2025), and MCP Top 10 (2025).
- **Lifecycle**: loaded at startup and hot-reloaded like the policy (file watch + atomic
  snapshot swap); per-entry validation, invalid entries skipped with an audit warning (one
  bad row never kills the feed); deterministic dedup of repeated ids; `enabled: false`
  tombstones signatures without losing history; optional detached-signature verification
  (e.g. ed25519) for externally managed feeds — a feed failing verification is not loaded
  and the previous feed stays in force. External sources are refreshed on a configurable
  poll interval with conditional GET (ETag/Last-Modified) — enabled by default, with the
  vendored snapshot and locally edited feed file as fallback and override inputs — so newly
  published signatures
  reach the running system without operator action; refresh failures keep the
  last-known-good feed and record per-source last-success. A vendored feed snapshot keeps
  the hermetic suite and offline demos fully functional.
- **Inspection surfaces**: raw prompts, tool calls and arguments, tool schemas and
  descriptions at MCP registration (poisoned tool descriptions are rejected at catalog
  admission, before any call), and outbound model/tool output.
- **Canonicalization + decode** (shared `src/control/text/` module, also feeding the
  deterministic tier L4 re-scan): NFKC + casefold, zero-width and bidi-control stripping,
  homoglyph folding, leetspeak folding, whitespace/punctuation collapsing; bounded layered
  decode (base64/URL/hex/HTML entities, depth ≤ 2). Every match carries a span map back to
  raw content so redaction and audit point at the original text, and the matched form
  (raw/canonical/decoded) is recorded.
- **Matching**: cheap literal prefilter (Aho-Corasick over canonical + decoded forms) →
  per-signature compiled regex → optional validator stage → severity → policy-mapped
  action (severity defaults with per-id overrides; `suspect` structural signals —
  invisible-char density, payload splitting/fragmentation, high-entropy encoded blobs —
  map to the policy's suspect action, default redact/escalate). Deterministic `block` is
  final per D4; matched form never changes the verdict path, only the evidence.
- **Match safety**: bounded pattern count per feed, per-pattern and per-content match
  budget, ReDoS-safe compilation (linear-time `re2js` is the drop-in if backtracking shows
  up); a pattern exhausting its budget is reported and skipped without stalling the
  pipeline.
- **Seed entries** (~30-50, each with positive + evasion-variant fixtures; rewritten from
  public sources — OWASP prompt-injection cheat sheet, tldrsec/prompt-injection-defenses,
  MCP attack matrix — so licensing stays clean): classic injection markers ("ignore
  previous instructions", persona overrides), jailbreak templates (DAN-style, role-play
  envelopes), tool-abuse shapes (`rm -rf /`, `curl … | bash`), unsafe deserialization
  (`__reduce__`, `yaml.load(`, `pickle.loads`), supply-chain markers (install-script
  hooks, known typosquat package names), MCP tool-poisoning markers (hidden instructions in
  tool descriptions, schema fields carrying directives), and exfiltration patterns
  (markdown-image/beacon URLs, encoded outbound blobs).
- **Audit provenance**: signature id, source, feed version hash, matched form, raw-mapped
  span land in the audit row so false-positive tuning and feed attribution are observable.

### R5. Security reporting and auditing

- **Audit**: append-only `audit_events` (WAL) — timestamp, interaction id, seam, direction,
  user id, user group id, policy version hash, verdict, decisive check and score,
  redaction counts, usage, per-stage latency. Raw outbound state is never logged.
- **Metrics**: aggregation queries over audit/usage (verdicts by control and category,
  redactions, budget consumption, latency p50/p95/p99) served to the dashboard via polling;
  incrementally maintained counters if query cost matters.
- **Export**: `/api/audit/export` as JSONL and CSV with filters (time range, verdict,
  control, user id, user group id) — parseable output for security teams.
- **Dashboard surfaces**: posture overview and policy/feed versions in force.

### R6. Self-testing suite

- **Hermetic, credential-free** (D8): fixed-evidence doubles at the classifier boundary,
  temp SQLite, no network/keys; positive (allowed) and negative (blocked/redacted) cases
  for every control, every spec scenario mapped to at least one test.
- **Cross-cutting tests**: profile divergence (same evidence, different verdicts), budget
  exhaustion and reconciliation, policy/feed reload, seam tests (guard API, chat, tool
  calls), and the Jev leak suite (captured `decide()` body contains zero raw
  sensitive spans).

### Problem → controls map (challenge §1)

| Problem | Controls |
| --- | --- |
| Over-broad access / impersonation | model allowlist, per-group policy subjects and overrides |
| Prompt injection & sensitive output | R2a L1–L4 inbound + output direction, R2b semantic questions, signature feed (R4) |
| Runaway loops / resource blowup | budget windows + reservations (R3), optional token-bucket rate limit, per-stage latency telemetry (R5) |

## Risks / Trade-offs

- [Jev is early-access; judges may lack a key] → The suite is credential-free (D8);
  docs state plainly which tier needs the key.
- [Semantic misclassification / overconfidence] → Calibrated probabilities with per-action
  decisiveness floors (D5); deterministic tier is independent and final for its classes;
  thresholds tuned per profile with the fail-closed default.
- [Added latency on the guarded path] → Cheap-first ordering (D4); single `decide()` call
  with questions in parallel; per-stage latency recorded in audit for the telemetry the
  challenge asks for. Budget a p95 target of ~100 ms deterministic / ~600 ms with semantic.
- [Prompts leave the house when using hosted Jev] → Policy option to disable the semantic
  tier per group (`off` egress mode, deterministic-only); state passed to Jev is
  trimmed to the fields the decision needs.
- [Policy hot-reload races] → Immutable snapshot per request with version stamping (D6).
- [Signature feed false positives] → Severity-keyed actions with policy overrides;
  provenance in audit (see spec) makes tuning observable.
- [Signature evasion via character transforms or encoding] → Canonicalized + decoded
  matching with raw-span mapping (R4); an evasion-variant fixture per transform proves
  coverage, and the semantic tier remains behind signatures for anything obfuscated
  enough to slip past deterministic matching.
- [SQLite write contention under load] → WAL mode and single-process Nitro keep this
  within bounds for the expected demo scale; a real deployment would swap the audit sink
  interface to a remote store.

## Migration Plan

Additive, no breaking changes to existing routes. Steps:

1. Dependencies and env: add `@tanstack/ai-typesafe`, `@types/bun`, `TYPESAFE_API_KEY`
   (optional), keep `DATABASE_URL`.
2. Drizzle schema additions and migration (`bun run db:generate` / `db:migrate`).
3. Ship seed `policy.json` + sample profiles + `signatures.json`; wire the loader and
   hot reload.
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
