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
- Identity/authn provider integration; consumer keys are presented via header and mapped
  to policy subjects, not authenticated against an IdP.
- A full multi-step human-review workflow; the approvals queue resolves tool calls with
  approve/deny, while content escalations stay record-only in the dashboard.
- Multi-provider model routing; the hub owns one OpenAI-compatible model connection
  (env-configured endpoint, model, key) and the governed agentic tool loop.

## Decisions

### D1. In-process middleware pipeline inside TanStack Start, not a separate proxy service
The control layer is a `src/control/` pipeline module invoked by three enforcement seams:
the generic guard API (`src/routes/api.guard.ts`), the MCP safety hub's `askModel`
prompt/answer direction (the chat demo page is a client of the hub; no separate
model-reaching route is exposed), and the hub's tool-call surface (`src/routes/mcp.ts`,
which also proxies user-connected external MCP servers). A thin `guardInteraction()`
wrapper exposes the SDK-style integration the challenge mentions. Alternative: standalone reverse proxy (extra deployable, harder for judges to
run) or SDK-only (trivially bypassed, no central reporting). Single-process keeps the
"lightweight" requirement and reuses the existing Nitro deployment story.

### D2. Jev through TanStack AI `decide()` with `@tanstack/ai-typesafe`, behind a `SemanticClassifier` interface
`@tanstack/ai@0.64.0` already exports `decide()`, `choice()`, `score()`, `boolean()`, and
`BaseEvaluateAdapter` with the exact TypeSafe wire format (`choice`/`score`/`noul`).
`@tanstack/ai-typesafe` (the official direct-TypeSafe adapter) supplies the transport;
our `SemanticClassifier` interface wraps `decide()`; the product path wires only the
real Jev implementation (no test double is selectable via policy or runtime
configuration), while the unit tier injects fixed-answer doubles at the interface
boundary in the test harness. Alternatives: Vercel AI
Gateway (requires Vercel account/OIDC, conflicts with self-host constraint), raw fetch to
the TypeSafe REST API (reimplements answer mapping and typing), AI SDK
`experimental_evaluate` (second AI stack in a TanStack AI repo). Configuration injected at
the module boundary so tests never touch the network.

### D3. Typed checks: built-in catalog in code, policy-defined checks first-class
Built-in semantic question definitions (instructions, criteria) live in a typed TS catalog
so answer handling keeps `decide()`'s compile-time unions. The policy defines checks
first-class: it enables/disables built-in checks, sets per-profile
probability/confidence thresholds and explicit threshold-to-verdict conditions, overrides
check wording/criteria, and may define custom typed checks (`boolean`/`choice`/`score`)
consumed through the same answer contract — this is the "if statement" judges write: if
`probability(check) ≥ blockThreshold` then `block`, else `redact`/`flag`/`allow`.
Rationale: judges need to define what the model checks, not only flip toggles (explicitly
named in the challenge), while built-in typed answers keep the verdict mapper safe.
Custom checks trade compile-time narrowing for tunability; their answers flow through the
generic typed-answer path, never free-form text.

### D4. Cheap-first pipeline order
`shape validation -> model allowlist -> tool authorization -> egress allowlist ->
signature feed -> deterministic PII/secrets -> budget pre-flight -> semantic tier ->
verdict mapping`. Deterministic `block` is final and
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
unit-testable. Tool calls carry an additional authorization decision
(`allow | deny | require-approval`) from the policy engine's grants and confirmation
rules; `require-approval` maps to `escalate` (call held for the approvals queue) and
deletions are hard-gated to it.

### D6. Policy as versioned zod-validated JSON, stored in SQLite and edited via the dashboard
One policy document (plus seed variants `policy.permissive.json`, `policy.strict.json`)
validated by a zod schema shared with runtime checks. The active document is stored as
immutable version rows in SQLite: dashboard edits and JSON imports validate, then create a
new version; the runtime swaps an immutable policy snapshot atomically and each request
reads one snapshot and stamps its version hash into the audit record. Rollback re-activates
any prior version row. Invalid edits or imports are rejected with the validation errors and
the last valid policy stays active. JSON over YAML: zod-native, no parser dependency,
diff-friendly for judges and for import/export round-trips.

### D7. SQLite (Drizzle) for audit, usage, and budget state
Core tables: `audit_events` (append-only, one row per governed interaction with
evidence JSON), `usage_records` (tokens, cost, latency per call, incl. Jev's own usage),
and `budget_windows` (key, window, counters; windows are computed by time bucket, so
rollover needs no cron). Governance tables: `policy_versions` (immutable policy
documents), `mcp_connections` (user-connected MCP servers and their registered tools), and
`approval_items` (pending and resolved tool-call approvals). Alternatives: Postgres (operational overhead), in-memory (loses
audit durability), files (no queryability for dashboards/exports).

### D8. Two-tier test suite: credential-free unit tier, real-model integration tier
Vitest drives a unit tier with fixed-evidence doubles injected at the
`SemanticClassifier` boundary and temp SQLite files; every spec scenario maps to a test,
and it runs with no network or keys — mandatory given the no-paid-services evaluation
setup. The integration/end-to-end tier exercises the real Jev path and a real
OpenAI-compatible model endpoint through the hub; missing credentials fail the run fast
with a clear configuration error instead of silently skipping. Test doubles are never
selectable as a product classifier.

### D9. Budget enforcement: estimate pre-flight, settle post-flight
Token estimates (chars/4 heuristic plus fixed overhead) reserve budget before forwarding;
actual usage from the model response settles and reconciles. Jev input tokens count toward
the layer's own metering so semantic cost is visible. Over-budget uses the policy's
over-budget verdict (default `block`).

### D10. TanStack MCP module (`@tanstack/ai-mcp`) for both MCP roles
The hub's MCP server surface is `createMCPServer()` from `@tanstack/ai-mcp/server` (the
module's server subpath; the root `@tanstack/ai-mcp` exports the client side): hub tools are
defined once with `toolDefinition()` (`@tanstack/ai`), instantiated with `.server(execute)`,
and the same `AnyServerTool` list is both served over MCP (`server.fetch` mounted in
`src/routes/mcp.ts`) and passed to `chat({ tools })` for the governed agentic loop, so the
catalog cannot drift between the two surfaces. External MCP servers connect through
`createMCPClient` / `createMCPClients` (http/sse/stdio transports; per-connection
`headers` carry the user's service token, keeping it out of tool content) and feed
`chat({ mcp: { clients } })`. The
package runs on the modular `@modelcontextprotocol/{core,client,server}@2.x`, so the
monolithic `@modelcontextprotocol/sdk@1.x` and the `InMemoryTransport` request/response
hack in `src/utils/mcp-handler.ts` are removed. Alternatives: keep sdk v1 for the server
half while ai-mcp handles the client half (two SDK generations with duplicated tool
shapes and transport code), or hand-roll JSON-RPC (reimplements protocol, transport, and
version negotiation for no gain).

## Detailed Solution Design (per requirement)

Concrete solution for each challenge requirement, layered cheap-first. Pipeline stage order
itself is D4; this section specifies what each stage actually does.

### R1. Centralized policy engine

- **Document shape**: `policy.json` = `{ version, defaults { profile, failureVerdict,
  toolEnforcement }, consumers { <id>: { profile, overrides, grants } }, tools { <name>:
  { source, verbs, confirm, classificationOverride? } }, network { allowedDomains[],
  allowedMcpEndpoints[] }, controls { shape, allowlist, signatures, detection, redaction, budget,
  semantic }, observability }` where `consumers` identifies users (one agent per user in
  this version) and `grants` lists allowed `[tool, verb]` pairs — deny-by-default.
  `controls.detection` carries custom regex rules (`rules[]` with id, kind, pattern,
  target directions, mapped action) plus built-in detector-family toggles and per-kind
  default actions; `controls.semantic` carries the typed check definitions (`checks[]`
  with id, type, wording/criteria, activation, per-direction thresholds). Zod
  schema is the single definition, shared by runtime loader and tests; unknown keys
  rejected (`z.strictObject`).
- **Resolution order**: base document → profile overlay (permissive/standard/strict,
  deep-merge) → per-consumer / per-route override. Precedence is deterministic and
  documented in `docs/policy.md`; every merge result is itself schema-valid.
- **Versioned activation**: dashboard save or JSON import → validate → new version row
  (`policyVersion = sha256(canonical JSON)`) → atomic snapshot swap (each request pins one
  snapshot and stamps the version into its audit row). Invalid edits are rejected and the
  last valid policy stays active; rollback re-activates a prior version row. Startup with
  no valid policy refuses to run (fail closed); the explicit `controls.enabled: false`
  kill-switch is the observe-only mode.
- **Judge tunability**: thresholds, actions, allowlists, custom regex rules, and semantic
  check definitions (type, wording, criteria) are all policy fields; nothing
  security-relevant is hard-coded outside the built-in pattern and question catalogs.

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
  `noul` booleans (prompt injection? jailbreak? data exfiltration request? malicious code?),
  `choice` (threat category, full distribution), `score` (severity 0–1). Catalog is typed TS
  for the built-ins; policy toggles activation, overrides wording/thresholds, and may
  define additional typed checks consumed through the same answer contract (D3).
- **Egress minimization (no sensitive data to Jev)**: `state` is a constructed allowlist
  object (`{ role, direction, content, contentLength, flags[] }`) built in exactly one
  function from post-redaction text of the inspected span only — no history, system prompts,
  tool schemas, or keys. Consistent pseudonyms (`[USER_1]`) preserve relational structure;
  truncation to `maxChars` happens after redaction/pseudonymization.
- **Egress gate**: deterministic detectors run once more over the exact serialized `state`
  before `decide()`; residual sensitive span → policy `residualSensitiveAction`
  (`block` default / `escalate` / `redact-and-send`).
- **Routing**: `controls.semantic.egress.mode`: `minimized` (default) | `off`
  (deterministic-only for sensitive consumers/routes). The earlier `local-only` fallback
  classifier mode is gone: the product path runs only the real decision model.
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
  consumer key hash, policy version hash, verdict + control hits, semantic answer summary,
  redaction counts, usage, per-stage latency. Raw outbound state is never logged.
- **Metrics**: aggregation queries over audit/usage (verdicts by control and category,
  redactions, budget consumption, latency p50/p95/p99) served to the dashboard via polling;
  incrementally maintained counters if query cost matters.
- **Export**: `/api/audit/export` as JSONL and CSV with filters (time range, verdict,
  control, consumer key) — parseable output for security teams.
- **Dashboard surfaces**: posture overview, policy editor with version history and
  rollback, approvals queue (approve/deny pending tool calls), and tool decision log.

### R6. Self-testing suite

- **Unit tier, credential-free** (D8): fixed-evidence doubles at the classifier boundary,
  temp SQLite, no network/keys; positive (allowed) and negative (blocked/redacted) cases
  for every control, every spec scenario mapped to at least one test.
- **Cross-cutting tests**: profile divergence (same evidence, different verdicts), budget
  exhaustion and reconciliation, policy/feed reload, seam tests (guard API, hub prompts,
  hub tool calls), and the Jev leak suite (captured `decide()` body contains zero raw
  sensitive spans).
- **Integration/end-to-end tier with real models**: real Jev plus a real OpenAI-compatible
  endpoint through the hub, covering allow/redact/block/escalate end to end; missing
  credentials fail fast with a clear configuration error (never silent skip).

### R7. Tool/action authorization and MCP safety hub

- **Single governed path**: prompts reach the model only through the hub's `askModel`
  tool and all tool calls execute through hub-hosted or hub-proxied tools, so no traffic
  bypasses inspection (spec `interaction-gateway/mcp-safety-hub`). The chat demo page is a
  client of the hub.
- **Authorization per call**: tool calls are classified into capability verbs (catalog
  override first, name/description inference otherwise) and decided as
  `allow | deny | require-approval` from the user's grants (deny-by-default) plus the
  catalog's confirmation flag; deletions are hard-gated to `require-approval`.
- **Approval flow**: `require-approval` calls do not execute and land in the dashboard
  approvals queue with tool, action, and arguments; approval authorizes the agent's next
  attempt at the same call, denial keeps it blocked; every decision is audited with actor
  and timestamp.
- **Hub connections and credential custody**: users connect external MCP servers
  (Confluence, Jira, ...) with per-service credentials; connected tools register
  dynamically into the catalog ungranted; endpoints are checked against the egress
  allowlist; service tokens are used only to call their target server and never appear in
  model-visible content or logs.
- **Enforcement modes and loop**: per profile, blocked tool calls are enforced tool-scoped
  (defined tool error, turn continues) or turn-scoped (whole turn rejected); the governed
  agentic tool loop executes model-requested calls under tool-call governance, bounded by
  request-count and compute-time budgets.

### Problem → controls map (challenge §1)

| Problem | Controls |
| --- | --- |
| Over-broad access / impersonation | per-user grants with deny-by-default, action classification, deletion hard gate + approvals queue, MCP hub credential custody, model allowlist |
| Prompt injection & sensitive output | R2a L1–L4 inbound + output direction, R2b semantic questions, signature feed (R4) |
| Runaway loops / resource blowup | budget windows + reservations (R3), optional token-bucket rate limit, per-stage latency telemetry (R5) |

## Risks / Trade-offs

- [Jev is early-access; judges may lack a key] → The unit tier is credential-free (D8);
  the integration tier fails fast with a clear configuration message; docs state plainly
  which tier needs the key.
- [Semantic misclassification / overconfidence] → Calibrated probabilities with per-action
  confidence floors (D5); deterministic tier is independent and final for its classes;
  thresholds tuned per profile with the fail-closed default.
- [Added latency on the guarded path] → Cheap-first ordering (D4); single `decide()` call
  with questions in parallel; per-stage latency recorded in audit for the telemetry the
  challenge asks for. Budget a p95 target of ~100 ms deterministic / ~600 ms with semantic.
- [Prompts leave the house when using hosted Jev] → Policy option to disable the semantic
  tier per consumer (`off` egress mode, deterministic-only); state passed to Jev is
  trimmed to the fields the decision needs.
- [Policy hot-reload races] → Immutable snapshot per request with version stamping (D6).
- [Test doubles leaking into the product path] → The classifier interface accepts only
  real implementations at runtime; doubles are injected exclusively by the test harness
  and are not selectable via policy or runtime configuration.
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

1. Dependencies and env: add `@tanstack/ai-mcp`, `@tanstack/ai-typesafe`, `vitest`,
   `TYPESAFE_API_KEY` (optional), drop `@modelcontextprotocol/sdk` (and
   `src/utils/mcp-handler.ts`), keep `DATABASE_URL`.
2. Drizzle schema additions and migration (`bun run db:generate` / `db:migrate`).
3. Ship seed `policy.json` + sample profiles + `signatures.json`; wire the versioned
   policy store (dashboard editing, import/export) and snapshot loader.
4. Land pipeline stages and seams behind a policy kill-switch (`controls.enabled: false`
   passes traffic through and audits only) so rollout can start in observe-only mode.
5. Enable enforcement per seam; dashboard and export last.

Rollback: set `controls.enabled: false` (traffic flows, auditing continues) or revert to
the previous policy file; the DB additions are unused-but-harmless.

## Open Questions

- Escalation disposition: tool-call escalations (`require-approval`) resolve in the
  dashboard approvals queue (approve/deny); content escalations stay record-only in the
  review list.
- Whether the demo showcase traffic source is the existing MCP todos tool or a small chat
  page; both seams are covered by the pipeline either way.
- OpenTelemetry export for telemetry beyond the metrics surface; audit and metrics
  already satisfy the requirement, OTel is additive.
