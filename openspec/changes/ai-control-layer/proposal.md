# Proposal

## Why

The challenge in `task.md` asks for a lightweight, flexible AI Control Layer that governs
interactions with agentic AI systems (agents, MCP services, LLMs, APIs): it must enforce
security, privacy, and resource controls from a single policy source, using a hybrid of
deterministic (non-AI) and semantic (AI-based) defenses, and prove itself with an automated
test suite, reporting, and budget governance. The repo is currently a bare TanStack Start
base (demo MCP route, todos, SQLite) with no guardrails at all. We want to grow it into the
control layer, and use **Jev (TypeSafe AI's System One decision model) as the semantic
tier's decision model**: it returns typed choices, scores, and boolean probabilities with
calibrated confidence in 70-500 ms, so guardrail decisions are threshold-testable instead
of prompt-parseable.

## What Changes

- Add an **interaction gateway**: interception points in the TanStack Start server that
  govern AI traffic (app-to-agent chat, agent-to-MCP tool calls, and a generic guard API)
  and apply the verdicts `allow | redact | block | escalate` to prompts and model output.
- Add a **centralized policy engine**: one validated policy file (zod-validated JSON)
  defining controls, sensitivity thresholds, strictness profiles, allowed models, budget
  rules, and question definitions for the semantic tier, hot-reloadable at runtime.
- Add a **deterministic control tier**: regex/dictionary checks for secrets and PII with
  redaction, model allowlist enforcement, and request-shape validation. Runs first and
  short-circuits when it can decide alone.
- Add a **semantic control tier powered by Jev**: a single `decide()` call per request with
  atomic typed questions (prompt injection, jailbreak, data exfiltration, malicious code,
  threat category, severity score), answered in parallel, mapped to verdicts by the policy
  engine. Includes confidence floors and a fail-closed degradation path.
- Add **historical attack mitigation**: an externally managed signature feed (patterns from
  known AI exploits: prompt injection and jailbreak payloads, malicious tool calls, unsafe
  deserialization, model-repo supply-chain markers, MCP tool poisoning, exfiltration)
  matched deterministically and evasion-resistant — matching over raw, canonicalized, and
  decoded forms with spans mapped back to raw content — plus tool-schema scanning at MCP
  registration, structural suspicion signals, feed integrity (version hash, provenance,
  optional verification), and feed hot-reload.
- Add **budget governance**: token/cost/request accounting per key and time window in
  SQLite, enforced before and after downstream calls, covering commercial APIs and locally
  hosted models.
- Add **security reporting and auditing**: append-only audit log (verdicts, reasons,
  probabilities, latency, token usage, cost), aggregate metrics, exportable audit trail,
  and an interactive dashboard (controls, posture, blocked threats, budget usage).
- Add an **executable self-test suite**: positive (allowed) and negative (blocked/redacted)
  cases for every control, including budget-limit and exploit-mitigation tests, in two
  tiers: a unit tier runnable without credentials, and an integration/end-to-end tier that
  exercises the real semantic decision model and a real model endpoint.
- Add **sample configurations** demonstrating multiple strictness levels and budget rules,
  plus an architecture diagram and a demo agent/traffic source to showcase the layer.

## Capabilities

### New Capabilities

- `interaction-gateway`: interception of AI interactions across seams (chat, MCP tool
  calls, generic guard API) and enforcement of verdicts (allow/redact/block/escalate),
  including redaction application and fail-closed behavior. The MCP seam is specified by
  its nested `interaction-gateway/mcp-safety-hub` capability.
- `policy-engine`: the single policy source — schema, strictness profiles, thresholds,
  control enable/disable, model allowlists, budget rules — with validation and hot reload.
- `deterministic-controls`: non-AI checks — secret/PII detection and redaction (including
  connected-service credential protection), allowlist enforcement (models and egress
  targets), and shape validation — with defined precedence against the semantic tier.
- `semantic-classification`: Jev-based semantic decisions — typed questions, parallel
  evaluation, confidence floors, degradation/fallback behavior when the model is
  unavailable or uncertain.
- `attack-signature-mitigation`: historical exploit signature feed management and
  evasion-resistant matching over raw, canonicalized, and decoded forms (block/redact/flag,
  severity-mapped actions), including runtime feed updates, tool-schema scanning at MCP
  registration, structural suspicion signals, and feed integrity and provenance.
- `budget-governance`: budget definition, accounting, and enforcement for token spend,
  request counts, and compute time across commercial and local model backends.
- `security-observability`: audit logging, real-time metrics, exportable reports, and the
  dashboard surfaces for management and security teams.
- `interaction-gateway/mcp-safety-hub`: the MCP server as the single governed path to
  models and tools — `askModel` as the only model-reaching interface, governed tool calls
  (including risky demo tools) with configurable tool/turn enforcement, the governed
  agentic tool loop, the OpenAI-compatible model connection (env-configured endpoint,
  model, key), external MCP server connections with dynamic tool registration, and
  credential custody for connected-service credentials.
- `tool-authorization`: per-user authorization of every tool call before execution —
  grant sets over a tool catalog with capability verbs (`read`, `create`, `modify`,
  `delete`, `execute`, `network`), deny-by-default, `require-approval` via the dashboard
  approvals queue, and a hard gate requiring approval for deletion-classified actions.
- `self-testing-suite`: the executable suite in two tiers — a credential-free unit tier
  (fixed evidence and boundary test doubles, never selectable in the product path) and an
  integration/end-to-end tier that exercises real models and requires credentials.

### Modified Capabilities

None — the repo has no existing specs (`openspec list --specs` is empty).

## Impact

- **Code**: new `src/control/` (pipeline, policy, tiers, budget, audit) and
  `src/lib/jev/` (decision adapter, question catalog) modules; new server routes for the
  guard API, audit export, and metrics; dashboard routes; existing `src/routes/mcp.ts`
  gains guard enforcement; `src/db/schema.ts` gains audit, budget, and metric tables.
- **Dependencies**: `@tanstack/ai-typesafe` (Jev over TypeSafe HTTP; `@tanstack/ai@0.64.0`
  already ships `decide()`, `choice()`, `score()`, `boolean()`, `BaseEvaluateAdapter`),
  `vitest` for the judge-runnable test suite.
- **Config**: new `policy.json` (+ sample variants) and `signatures.json` feed; new env
  vars (`TYPESAFE_API_KEY`, budget window settings) via `src/env.ts`.
- **Runtime**: Jev calls add 70-500 ms on the semantic path only; deterministic tier
  short-circuits for the common case. All traffic is metered into SQLite.
- **Constraints**: judges get no paid subscriptions and run the suite themselves, so the
  unit tier runs credential-free (test doubles at boundaries only) while the
  integration/end-to-end tier requires real model credentials; the semantic tier runs on
  the real decision model (Jev) with no mock classifier in the product path. Classification
  stays separate from authorization: Jev flags, the policy engine decides.
