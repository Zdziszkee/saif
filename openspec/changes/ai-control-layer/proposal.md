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
  known AI exploits: prompt injection payloads, malicious tool calls, unsafe
  deserialization, model-repo supply-chain markers) matched deterministically, with feed
  hot-reload.
- Add **budget governance**: token/cost/request accounting per key and time window in
  SQLite, enforced before and after downstream calls, covering commercial APIs and locally
  hosted models.
- Add **security reporting and auditing**: append-only audit log (verdicts, reasons,
  probabilities, latency, token usage, cost), aggregate metrics, exportable audit trail,
  and an interactive dashboard (controls, posture, blocked threats, budget usage).
- Add an **executable self-test suite**: positive (allowed) and negative (blocked/redacted)
  cases for every control, including budget-limit and exploit-mitigation tests, runnable by
  judges with no external credentials (classifier behind a swappable adapter with a mock).
- Add **sample configurations** demonstrating multiple strictness levels and budget rules,
  plus an architecture diagram and a demo agent/traffic source to showcase the layer.

## Capabilities

### New Capabilities

- `interaction-gateway`: interception of AI interactions across seams (chat, MCP tool
  calls, generic guard API) and enforcement of verdicts (allow/redact/block/escalate),
  including redaction application and fail-closed behavior.
- `policy-engine`: the single policy source — schema, strictness profiles, thresholds,
  control enable/disable, model allowlists, budget rules — with validation and hot reload.
- `deterministic-controls`: non-AI checks — secret/PII detection and redaction, allowlist
  and shape validation — with defined precedence against the semantic tier.
- `semantic-classification`: Jev-based semantic decisions — typed questions, parallel
  evaluation, confidence floors, degradation/fallback behavior when the model is
  unavailable or uncertain.
- `attack-signature-mitigation`: historical exploit signature feed management and matching
  (block/flag), including runtime feed updates.
- `budget-governance`: budget definition, accounting, and enforcement for token spend,
  request counts, and compute time across commercial and local model backends.
- `security-observability`: audit logging, real-time metrics, exportable reports, and the
  dashboard surfaces for management and security teams.

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
  semantic tier is adapter-swappable (real Jev / mock / local Ollama fallback) and the test
  suite is hermetic by default. Classification stays separate from authorization: Jev
  flags, the policy engine decides.
