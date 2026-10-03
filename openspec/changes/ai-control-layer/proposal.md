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
  govern AI traffic (chat prompts and answers, tool calls, and a generic guard API) and
  apply the verdicts `allow | redact | block | escalate` to prompts and model output.
- Add a **centralized policy engine**: one validated policy document (zod-validated JSON)
  defining content controls, custom regex detection rules for the deterministic tier,
  sensitivity thresholds, strictness profiles, allowed models, budget rules, signature
  severity mapping, and typed check definitions (the "if statements" the semantic tier
  evaluates), with hot-swap reload at runtime.
- Add a **deterministic control tier**: regex/dictionary checks for secrets and PII with
  redaction, model allowlist enforcement, and request-shape validation. Runs first and
  short-circuits when it can decide alone.
- Add a **semantic control tier powered by Jev**: a single `decide()` call per request with
  atomic typed questions (prompt injection, jailbreak, data exfiltration, malicious code,
  threat category, severity score), answered in parallel, mapped to verdicts by the policy
  engine. Includes confidence floors and a fail-closed degradation path.
- Add **historical attack mitigation**: an externally managed signature feed ingested from
  live SOTA-2026 threat-intel sources (OSV/OpenSSF malicious-package reports, MITRE ATLAS
  STIX 2.1, public exploit corpora), covering patterns from known AI exploits — prompt
  injection and jailbreak payloads, malicious code execution, unsafe
  deserialization, model-repo supply-chain markers — matched deterministically and
  evasion-resistant (over raw, canonicalized, and decoded forms with spans mapped back to
  raw content), with structural suspicion signals, feed integrity (version hash,
  provenance), and feed hot-reload with conditional-GET polling.
- Add **budget governance**: token/cost/request accounting per key and time window in
  SQLite, enforced before and after downstream calls, covering commercial APIs and locally
  hosted models.
- Add **security reporting and auditing**: append-only audit log (verdicts, reasons,
  probabilities, latency, token usage, cost), aggregate metrics, exportable audit trail,
  and an interactive dashboard (controls, posture, blocked threats, budget usage).
- Add an **executable self-test suite**: positive (allowed) and negative (blocked/redacted)
  cases for every control, including budget-limit and exploit-mitigation tests, runnable
  with no external credentials.
- Add **sample configurations** demonstrating multiple strictness levels and budget rules,
  plus an architecture diagram and a demo traffic source to showcase the layer.

## Capabilities

### New Capabilities

- `interaction-gateway`: interception of AI interactions across seams (chat, tool calls,
  generic guard API) and enforcement of verdicts (allow/redact/block/escalate), including
  redaction application and fail-closed behavior.
- `policy-engine`: the single policy source — schema, custom regex detection rules,
  semantic check definitions, strictness profiles, thresholds, control enable/disable,
  model allowlists, budget rules, signature severity mapping — with validation and
  hot-swap reload.
- `deterministic-controls`: non-AI checks — secret/PII detection and redaction,
  policy-defined custom regex rules, request shape validation, and the historical-exploit
  signature engine (externally managed feed, evasion-resistant matching over raw,
  canonicalized and decoded forms, structural suspicion signals, feed integrity and
  provenance) — with defined precedence against the semantic tier.
- `semantic-classification`: Jev-based semantic decisions — typed questions defined as
  policy check definitions, parallel evaluation, confidence floors, degradation/fallback
  behavior when the model is unavailable or uncertain.
- `budget-governance`: budget definition, accounting, and enforcement for token spend,
  request counts, and compute time across commercial and local model backends.
- `security-observability`: audit logging, real-time metrics, exportable reports, and the
  dashboard surfaces for management and security teams.
- `self-testing-suite`: the executable, credential-free test suite — positive (allowed) and
  negative (blocked/redacted) cases per control, including budget-limit and
  exploit-mitigation coverage.

### Modified Capabilities

None — the repo has no existing specs (`openspec list --specs` is empty).

## Impact

- **Code**: new `src/control/` (pipeline, policy, tiers, budget, audit) and `src/lib/jev/`
  (decision adapter, question catalog) modules; new server routes for the guard API, audit
  export, and metrics; dashboard routes (posture, versions in force);
  `src/db/schema.ts` gains audit, usage, and budget tables.
- **Dependencies**: `@tanstack/ai-typesafe` (Jev over TypeSafe HTTP; `@tanstack/ai@0.64.0`
  already ships `decide()`, `choice()`, `score()`, `boolean()`, `BaseEvaluateAdapter`),
  `vitest` for the judge-runnable test suite.
- **Config**: new `policy.json` (+ sample variants) and `signatures.json` feed; new env
  vars (`TYPESAFE_API_KEY`, policy/feed paths, budget window settings) via `src/env.ts`.
- **Runtime**: Jev calls add 70-500 ms on the semantic path only; deterministic tier
  short-circuits for the common case. All traffic is metered into SQLite.
- **Constraints**: judges get no paid subscriptions and run the suite themselves, so the
  test suite is credential-free (test doubles at boundaries only) and the semantic tier is
  adapter-swappable (real Jev / mock / local Ollama fallback). Classification stays
  separate from enforcement: Jev flags, the policy engine decides.
