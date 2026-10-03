# Architecture

The AI Control Layer is a hybrid defense system for interactions with agentic AI
systems: agents, MCP services, LLMs, and APIs. It sits between consumers of AI
(capable agents, applications, teams) and the AI systems they reach (models,
tools, MCP servers) and enforces one centralized policy over every interaction,
in both directions: inbound prompts and outbound model/tool output.

The design principle is **cheap-first hybrid enforcement**: deterministic,
non-AI controls decide the common case at near-zero cost and latency; an
AI-based semantic tier is invoked only for the remainder; and policy alone maps
evidence to verdicts. Classification is advisory; policy decides.

## Diagram

```
                       ┌──────────────────────────────────────────────────────────────┐
                       │      Centralized configuration (hot-reloadable, versioned)    │
                       │                                                              │
                       │   policy.json        policy.jev.json        signatures.json  │
                       │   controls,          Jev question catalog   known historical │
                       │   profiles,          (binary checks,        AI-exploit feed  │
                       │   thresholds,        wording, thresholds)   (ext. managed)   │
                       │   budgets, allowlist                                             │
                       │                                                              │
                       │   zod validation ── atomic snapshot swap ── last-valid fallback│
                       └──────────────────────────────┬───────────────────────────────┘
                                                      │ immutable snapshot per request
                                                      │ (version hash stamped into audit)
┌───────────────────┐  ┌────────────────────┐  ┌──────┴───────────────────┐
│ Agents / apps     │  │ Chat clients       │  │ MCP clients              │
│ (one consumer key │  │                    │  │ (agents, other tools)    │
│  per subject)     │  │                    │  │                          │
└─────────┬─────────┘  └──────────┬─────────┘  └──────────┬───────────────┘
          │ x-consumer-key        │                       │
          ▼                       ▼                       ▼
┌───────────────────┐  ┌────────────────────┐  ┌──────────────────────────┐
│ POST /api/guard   │  │ Chat seam          │  │ MCP safety hub           │
│ generic guard API │  │ prompt + answer    │  │ tool-call governance     │
│ (shape-validated) │  │ around `ask`       │  │ grants · connections ·   │
│                   │  │                    │  │ egress allowlist         │
└─────────┬─────────┘  └──────────┬─────────┘  └──────────┬───────────────┘
          └───────────────────────┼───────────────────────┘
                                  ▼
                 ┌────────────────────────────────────┐
                 │  guardInteraction()  — SDK seam     │
                 │  one verdict per inspected          │
                 │  direction, defined rejection shape │
                 └────────────────┬───────────────────┘
                                  ▼
       ┌─────────────────────────────────────────────────────────────┐
       │  Control pipeline — per direction (inbound / outbound)       │
       │  cheap-first order · deterministic block is final ·          │
       │  redact-then-classify · fail-closed on error or timeout      │
       │                                                             │
       │  S1  shape validation        (deterministic)  ── reject   │
       │  S2  model allowlist         (deterministic)  ── reject   │
       │  S3  signature feed          (deterministic)  ── reject   │
       │  S4  PII / secrets detection (deterministic)  ── redact   │
       │  S5  budget pre-flight       (deterministic)  ── reject   │
       │  S6  semantic tier — Jev     (AI-based)       ── evidence │
       │  S7  verdict mapping         (policy only)    ── verdict  │
       └────────────────┬────────────────────────────────────────────┘
                        │
          ┌─────────────┴──────────────┐
          ▼                            ▼
┌──────────────────────┐   ┌─────────────────────────────────────────────┐
│ Enforcement          │   │ Observability                               │
│                      │   │                                             │
│ allow  → forward     │   │ append-only audit log (SQLite)              │
│ redact → forward     │   │ usage + budget windows (SQLite)             │
│        typed         │   │ real-time metrics (verdicts, latency p50/   │
│        placeholders  │   │   p95/p99, budget consumption per key)      │
│ block  → reject 403, │   │ JSONL / CSV audit export (filters)          │
│        never forward │   │ dashboard (posture, threats, budgets)       │
│ escalate → hold for  │   │ performance telemetry per stage             │
│        review        │   │                                             │
└──────────┬───────────┘   └─────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Forwarded targets (outside the control layer)                        │
│   LLM providers / local models (OpenAI-compatible, e.g. Ollama)      │
│   external MCP servers (Confluence, Jira, ...) · hub-hosted tools    │
└──────────────────────────────────────────────────────────────────────┘
```

## The two tiers

**Deterministic tier (non-AI).** Pattern and structure based, no model calls:

- request shape validation and content bounds (`src/control/shape.ts`);
- model allowlist — only policy-permitted model ids may be targeted;
- the signature engine over an externally managed feed of known historical
  AI-exploit patterns: prompt injection, jailbreak, malicious code execution,
  unsafe deserialization, model-repository supply-chain markers. Signatures are
  matched against raw, canonically folded (NFKC, casefold, homoglyph and
  leetspeak folding, zero-width/bidi stripping), and bounded layered-decoded
  forms so evasion variants (encoding, invisible characters, splitting) still
  match, and every match maps back to a span in the raw content;
- secrets and PII detection (API keys, access tokens, email, phone, payment
  cards, government-ID-like numbers) plus policy-defined custom regex rules,
  each with span-precise detection and a policy-mapped action (`redact` or
  `block`);
- budget pre-flight: projected tokens/cost/compute-time reserved against
  per-consumer budget windows before anything is forwarded.

Deterministic `block` is final and short-circuits the semantic call;
deterministic `redact` is applied to the content before the semantic tier sees
it, so a model is never asked to classify text that is already known unsafe.

**Semantic tier (AI-based).** The Jev decision model (TypeSafe AI) evaluates the
content against the binary check catalog defined in `policy.jev.json` —
prompt injection, jailbreak, sensitive topics, and any check a policy author
appends — in a single `decide()` round trip. One probability P(true) per check,
schema-constrained to the declared checks: no free-form model output is
consumed. A check added to the policy file is evaluated on the next interaction
with no code change. Unusable or absent answers fail closed.

## Verdict model

Exactly one verdict per inspected direction — `allow`, `redact`, `block`,
`escalate` — produced by a pure `applyPolicy(evidence, profile)` mapping:
detections, signature matches and severities, semantic probabilities, and
budget state against the resolved strictness profile. Because the mapper is
pure, identical evidence yields different verdicts under permissive and strict
profiles, and every threshold boundary is unit-testable. `escalate` records the
interaction for review and does not forward the content while unresolved.

## Enforcement seams

All three seams run their traffic through the same `guardInteraction()` wrapper
and the shared control pipeline, so verdict semantics cannot diverge by entry
point:

- **Generic guard API** — `POST /api/guard` (`src/control/guard-api.ts`,
  `src/routes/api.guard.ts`): any client posts an interaction envelope and
  receives the defined verdict shape. Malformed requests are rejected before
  any control runs.
- **Chat seam** — `src/control/chat.ts`: wraps the prompt and the answer around
  a model-reaching `ask` callback; both directions are inspected.
- **MCP safety hub** — `src/hub/`: the governed MCP surface. Every tool call —
  hub-hosted or from a connected external MCP server — is grant-checked, its
  arguments are inspected before execution (redacted arguments execute
  redacted), and its result is inspected before being returned. External MCP
  servers connect with per-service credentials that are used only to call their
  target endpoint and are never retained in records or audit; endpoints outside
  the policy egress allowlist are rejected and audited. `askModel` is the only
  model-reaching tool, and a small agentic loop (`src/hub/loop.ts`) exercises
  the whole path.

Every seam accepts a consumer key via the `x-consumer-key` header. The key
identifies the policy subject (agent, application, team); interactions of
different consumers are governed and metered in isolation, and a missing or
unknown key follows the policy's configured default-subject behavior (default
profile or rejection) — it never silently inherits another subject's
configuration.

## Policy engine

One centralized configuration source, zod-validated at load time, hot-reloadable
at runtime without restart (`src/control/policy/`):

- **`policy.json`** — what the policy engine owns: controls and their
  sensitivity thresholds per direction, strictness profiles
  (permissive/standard/strict), consumer definitions and per-consumer
  overrides, model allowlist, custom detection rules, signature severity
  mapping, budget rules, and failure verdicts.
- **`policy.jev.json`** — what the semantic tier is asked: the binary check
  catalog (wording, per-check thresholds, decisiveness floor, deadline, egress
  cap).
- **`signatures.json`** — the seeded historical-exploit feed; signatures can
  also be ingested from externally managed sources (OSV malicious-package
  reports, MITRE ATLAS STIX bundles).

Policy resolution is deterministic: base document, then profile overlay, then
per-consumer override. Each request reads one immutable snapshot and stamps its
version hash (sha256 of canonical JSON) into the audit record. A file watcher
swaps snapshots atomically; an invalid reload is rejected and the last valid
policy stays active, with the validation errors reported. The hosted runtime
binds its deterministic enforcement to the active snapshot
(`src/control/policy/live-control.ts`, rebuilding the detection control per
policy version), so a reload changes enforcement on the next interaction
without a restart; the signature feed reloads through its own store. The
remaining stage configuration (allowlist models, signature severity mapping,
semantic checks, profile enablement) and the consumer-key list are resolved at
startup; per-stage rebinding is follow-up.

## Observability

Every governed interaction produces an append-only audit entry: interaction
identity and consumer key, direction, policy and feed version, verdict with
reasons (fired detections, signature ids and matched form, semantic
probabilities), redactions applied, target model, token usage, computed cost,
and pipeline latency. Audit entries are not modifiable through application
interfaces. On top of the audit log the layer maintains real-time metrics
(verdict counts by control, category, and consumer key, redaction counts,
budget consumption, latency percentiles p50/p95/p99) and exposes JSONL/CSV
exports with filters (time range, verdict, control, consumer key) for security
teams, and a dashboard for management: controls and profiles in force, security
posture, top threat categories, blocked interactions, budget vs limits, recent
escalations, and the policy/signature feed versions live at that moment.

## Storage

SQLite (via `bun:sqlite` and Drizzle, `src/db/`) holds `audit_events`
(append-only, one row per governed interaction with evidence JSON),
`usage_records` (tokens, cost, latency per call, including the semantic tier's
own usage), and `budget_windows` (per key and window; windows are computed by
time bucket, so rollover needs no cron). File-based storage keeps the whole
system runnable on a judge's laptop with zero external services, while the
repository seams keep the store replaceable.

## Multi-tenancy and concurrency

One hosted instance serves many consumers, human users and agents alike,
concurrently. Every seam is a stateless request handler: resolve the subject,
run the pipeline against an immutable policy snapshot, answer. Bun serves the
routes from a single async event loop, so concurrent requests interleave at
await points: the semantic round trip is awaited I/O, not a blocking call, and
the deterministic stages are small bounded CPU work per request. No
per-request state is kept in process memory between requests; shared mutable
state is limited to subject state (hub grants, in memory today) and read-only
caches.

**Isolation axes.** The governance identity is the consumer key: policy
resolution, budget windows, and audit records are keyed by subject, so one
consumer's traffic can never inherit another's configuration, limits, or
history. Human users authenticate in front of the seams (session or token
auth); the audit seam already carries a `subject` field, and the authenticated
principal is recorded alongside the consumer key once the auth work flagged in
the status table lands. Machine callers (agents, apps, MCP clients) present a
consumer key per subject. Bulk-data endpoints such as the audit export require
a known consumer key outright (`requireKnownConsumer` in
`src/control/subjects.ts`) and never fall back to the default subject.

**Shared-state rules** (the real work of multi-tenancy):

- **Policy snapshots** are already per-request immutable and version-stamped,
  so any number of concurrent requests can share one hot-reloadable config
  safely.
- **Budget pre-flight** must be an atomic check-and-reserve inside one
  transaction. A check followed by a separate reserve lets two concurrent
  requests both pass pre-flight and overspend the window.
- **SQLite is single-writer.** One instance with WAL mode and a busy timeout is
  comfortably multi-tenant. Multiple instances require externalizing the store
  (e.g. Postgres) behind the existing repository seams, or a single writer
  service.
- **Hub state** (grants, connections) is keyed per subject, and per-connection
  credentials belong to one connection, travel only as a transport header to
  the target endpoint, and are never retained in records or audit. Grant state
  lives in process memory today: fine for one instance, but durable or
  centralized storage is required before scale-out or whenever grants must
  survive a restart.
- **Long-running agent loops run outside the web process**, as clients of the
  seams (guard API, chat seam, hub). The hub's own `askModel` loop
  (`src/hub/loop.ts`) runs in-process but is bounded by request-count and
  compute-time budgets and terminates with an over-budget verdict, so a runaway
  agent costs its own resources and its own budget window, never the instance's
  memory or scheduler.

**Scaling path.** Run one instance first: it covers a whole team's agents and
users. Scale vertically while the store is file-based. Scale horizontally
(behind a load balancer) only after the store and config distribution are
externalized; the policy version hash stamped into every audit entry shows
which configuration each instance applied, so a mixed-version fleet is
observable rather than silent.

## Testing posture

`bun test` runs the hermetic unit tier with no network and no model keys:
fixed-evidence doubles are injected at the `SemanticClassifier` boundary and
temp SQLite files back the stores. Every control is covered by at least one
positive (allowed) and one negative (blocked/redacted) case, exploit coverage
includes evasion variants and asserts signature id and feed version provenance,
and budget exhaustion tests prove the over-budget verdict. The live semantic
path sits behind an explicit `SEMANTIC_LIVE=1` opt-in (`bun run test:integration`)
so a developer with a real key in `.env` cannot make the unit tier reach the
network.

## Module map

| Diagram box | Modules |
|---|---|
| Generic guard API | `src/control/guard-api.ts`, `src/routes/api.guard.ts` |
| Chat seam | `src/control/chat.ts` |
| MCP safety hub | `src/hub/` (`mcp-server`, `governance`, `grants`, `connections`, `catalog`, `tools`, `loop`, `model`) |
| guardInteraction | `src/control/guard.ts` |
| Pipeline runner | `src/control/pipeline.ts` |
| Shape validation | `src/control/shape.ts` |
| Model allowlist | `src/control/allowlist.ts` |
| Deterministic detection | `src/control/deterministic/` (`control`, `detectors`, `ner`, `name-index`, `placeholders`), `src/control/redact.ts` |
| Signature engine | `src/control/signatures/` (`control`, `feed`: per-row feed validation, SHA-256 versioning, hot reload); shared `src/control/text/` canonicalization remains planned |
| Semantic tier | `src/control/semantic/` (`checks`, `classifier`, `jev`, `config`, `types`, `control`, `double`, `errors`, `index`) |
| Verdict mapping | planned: `applyPolicy(evidence, profile)` in `src/control/pipeline.ts` (design D5) |
| Subjects / consumer keys | `src/control/subjects.ts` |
| Policy engine | `src/control/policy/` (`schema`, `loader`, `live-control`) |
| Audit, usage, budget | `src/control/audit.ts`, `src/db/` |
| Dashboard, audit export, playground | `src/routes/dashboard.tsx`, `src/routes/api.audit.export.ts`, `src/routes/playground.tsx` |

## Implementation status

The diagram is the target architecture; the stage order above is the order the
pipeline runner enforces today (controls execute cheap-first in declared order,
`block` is final, redaction is applied before later stages, and any control
error or timeout fails closed to the policy failure verdict).

| Stage / area | Status |
|---|---|
| Shape validation, guard API, chat seam, MCP hub seams | implemented |
| Consumer-key subject resolution | implemented (policy consumer keys wired into the hosted runtime; the key list is resolved at startup, refresh on policy reload is follow-up) |
| Policy engine (schema, loader, hot reload, samples) | implemented |
| Deterministic detection + redaction + custom rules | implemented |
| Semantic tier (Jev catalog, doubles, fail-closed) | implemented |
| Verdict mapping (`applyPolicy`) | in progress (control verdicts merge by severity today; profile-threshold mapping pending) |
| Signature engine + feed ingestion | implemented (per-row feed validation, SHA-256 versioning, hot reload) |
| Budget pre-flight / settlement | in progress (reservation must be atomic across concurrent requests) |
| Durable audit store, metrics, export | in progress (in-memory sink today) |
| Dashboard route | implemented (`/dashboard`, `/api/audit/export`, `/playground`) |
| Human-user authentication (sessions/tokens in front of the seams) | not started (consumer keys only) |
| Durable hub grants | in process memory today |