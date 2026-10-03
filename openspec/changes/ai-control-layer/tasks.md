# Tasks

## 1. Scaffolding and dependencies

- [ ] 1.1 Add `@tanstack/ai-typesafe` and `vitest` to package.json, add `test` and `test:live` scripts, and verify `bun install` and `bunx vitest run` execute a smoke test (verify: smoke test passes via `bun run test`)
- [ ] 1.2 Extend `src/env.ts` with optional `TYPESAFE_API_KEY`, policy/feed paths, and budget window defaults; verify `bun run typecheck` passes and the app starts without the key set (verify: `bun run typecheck` and `bun run dev` both succeed)
- [ ] 1.3 Create the module skeleton `src/control/` (policy, pipeline, tiers, budget, audit) and `src/lib/jev/` (adapter, catalog) with empty index exports; verify typecheck passes (verify: `bun run typecheck`)

## 2. Policy engine

- [ ] 2.1 Implement the zod policy schema (controls, per-direction thresholds, strictness profiles permissive/standard/strict, model allowlist, budget rules, semantic check toggles and thresholds, failure verdicts) and verify schema tests reject invalid documents (verify: policy schema tests pass)
- [ ] 2.2 Implement the policy loader with immutable snapshot, atomic swap, file-watch hot reload, and last-valid fallback; verify reload and invalid-reload tests pass (verify: loader tests cover live edit and rejection rollback)
- [ ] 2.3 Ship `policy.json` plus `policy.permissive.json` and `policy.strict.json` sample variants and document every field in `docs/policy.md`; verify documented example values validate against the schema (verify: tests load all sample files successfully)

## 3. Storage layer

- [ ] 3.1 Add `audit_events`, `usage_records`, and `budget_windows` tables to `src/db/schema.ts`, generate the Drizzle migration, and verify `bun run db:migrate` applies cleanly to a fresh database (verify: migration runs on a temp SQLite file)
- [ ] 3.2 Implement repository modules (append-only audit insert and query, usage insert and aggregation, budget window upsert and read) and verify roundtrip tests on a temp database (verify: repository tests pass)

## 4. Deterministic tier

- [ ] 4.1 Implement detectors for secrets (API keys, tokens) and PII (email, phone, card, government-ID-like) returning kind and span; verify positive and negative detector tests pass (verify: detector tests pass)
- [ ] 4.2 Implement typed-placeholder redaction of detected spans and verify redaction preserves surrounding content (verify: redaction tests pass)
- [ ] 4.3 Document detection kinds and placeholder formats in `docs/controls.md`; verify documented examples match test fixtures (verify: examples in docs correspond 1:1 to passing fixtures)

## 5. Signature engine

- [ ] 5.1 Implement the signature feed schema and loader (identifier, name, description, pattern, kind including `mcp_tool_poisoning` and `exfiltration`, severity, source, references, timestamps, enabled flag) with per-entry validation, skip-invalid behavior, deterministic dedup, feed version hashing, and optional detached-signature verification; verify loader tests pass (verify: feed loader tests cover valid load, skip-invalid, dedup, version hash, and tampered-feed rejection)
- [ ] 5.2 Implement the shared canonicalization and decode module `src/control/text/` (NFKC + casefold, zero-width/bidi stripping, homoglyph folding, leetspeak folding, whitespace/punctuation collapsing, bounded layered base64/URL/hex/HTML-entity decode) with span mapping back to raw content, reused by the deterministic tier L4 re-scan; verify transform-matrix tests pass (verify: each evasion transform variant of a known payload is matched and maps to the raw span)
- [ ] 5.3 Implement the matcher (literal prefilter, per-signature compiled regex over raw/canonical/decoded forms, optional validator stage) and structural suspect signals (invisible-character density, payload splitting, high-entropy blobs); verify exploit-positive and benign-negative tests pass across all kinds and obfuscated forms (verify: matcher tests cover injection, jailbreak, tool-abuse, unsafe-deserialization, supply-chain, tool-poisoning, and exfiltration markers in raw and evasion-variant forms)
- [ ] 5.4 Implement match safety (per-pattern and per-content match budget, bounded feed size, ReDoS containment); verify a pathological pattern is reported and skipped without stalling (verify: match-budget test proves remaining signatures still fire)
- [ ] 5.5 Implement policy-mapped actions (severity to default action, per-signature overrides, suspect action and threshold); verify mapping tests pin every action (verify: severity-mapping and override tests pass)
- [ ] 5.6 Implement feed hot reload and ship `signatures.json` seeded with ~30-50 known historical AI-exploit patterns across all kinds, each with positive and evasion-variant fixtures rewritten from cited public sources; verify a reload test adds a pattern that blocks a matching request (verify: hot-reload integration test passes)
- [ ] 5.7 Implement tool-schema scanning at MCP registration and audit provenance recording (signature id, source, feed version hash, matched form, raw-mapped span); verify poisoned tool descriptions are rejected at catalog admission and provenance lands in audit (verify: registration-scan and provenance tests pass)

## 6. Semantic tier (Jev)

- [ ] 6.1 Load the local Intent skills for `@tanstack/ai` (ai-core and custom-backend-integration) and implement the typed question catalog (prompt injection, jailbreak, data exfiltration, malicious code booleans; threat category choice; severity score) with policy-driven activation and wording overrides; verify catalog tests pass (verify: catalog builds question maps from policy correctly)
- [ ] 6.2 Implement the `SemanticClassifier` interface and the Jev implementation over `decide()` with `@tanstack/ai-typesafe`, wired to `TYPESAFE_API_KEY`; verify a gated live smoke test passes when the key is present and is skipped cleanly otherwise (verify: `bun run test:live` behavior confirmed both ways)
- [ ] 6.3 Implement `mockDecider` (fixed typed answers) and the optional Ollama fallback classifier consuming the same question shapes; verify mock-based classifier tests pass without network (verify: classifier tests pass with `TYPESAFE_API_KEY` unset)
- [ ] 6.4 Verify answer consumption and typing: typed answer shapes carry probability distributions and confidence where required; verify compile-time narrowing test (verify: `bun run typecheck` includes answer-shape assertions)

## 7. Budget governance

- [ ] 7.1 Implement the pre-flight estimator (token estimate, projected cost, projected compute time) and reservation against `budget_windows`; verify reservation and exhaustion tests pass (verify: budget tests cover under-budget pass and exhausted block)
- [ ] 7.2 Implement post-flight settlement from actual usage (tokens, computed cost, compute time, including semantic-tier input tokens) with reconciliation against the reservation; verify settlement tests pass (verify: usage and reconciliation tests pass)
- [ ] 7.3 Implement window rollover by time bucket and per-key/window reporting queries; verify rollover tests pass (verify: rollover and reporting query tests pass)

## 8. Pipeline and verdict mapping

- [ ] 8.1 Implement `applyPolicy(evidence, profile)` as a pure function mapping detections, signatures, semantic answers, and budget state to `allow | redact | block | escalate` per direction; verify threshold boundary tests pin every cutoff (verify: verdict mapping tests pass with fixed evidence fixtures)
- [ ] 8.2 Implement the pipeline orchestrator with the cheap-first stage order from design D4 (shape validation, model allowlist, signature feed, deterministic PII/secrets, budget pre-flight, semantic tier), deterministic-block short-circuit, redact-then-classify flow, and fail-closed handling with timeouts; verify pipeline tests pass including classifier-unavailable failure (verify: orchestrator tests pass with mock classifier)
- [ ] 8.3 Verify profile-driven divergence: identical evidence yields different verdicts under permissive and strict profiles (verify: tests assert both verdicts from one shared fixture)

## 9. Enforcement seams

- [ ] 9.1 Implement the generic guard API route (`/api/guard`) with request shape validation and defined rejection response; verify positive and negative route tests pass (verify: route tests cover allow, redact, block, and malformed request)
- [ ] 9.2 Create a minimal chat route (the chat seam does not exist yet) and wire the pipeline into it (inbound prompt and outbound output) via the `guardInteraction()` wrapper; verify chat seam tests pass (verify: tests cover blocked prompt and redacted output)
- [ ] 9.3 Wire the pipeline into the MCP route so tool calls and tool output are governed; verify MCP seam tests pass with the existing todos tool (verify: tests cover blocked tool call and allowed tool call)

## 10. Observability

- [ ] 10.1 Record audit entries from the pipeline (verdict, evidence, policy version, model, usage, latency) and verify append-only behavior tests pass (verify: audit tests cover allow, redact, block, escalate, and failure entries)
- [ ] 10.2 Implement metrics aggregation (verdicts by control and category, redactions, budget consumption, latency percentiles) and verify aggregation tests pass (verify: metrics tests pass against seeded audit data)
- [ ] 10.3 Implement audit export endpoints (JSONL and CSV with filters: time range, verdict, control, consumer key) and verify export tests pass (verify: export tests assert filter correctness and parseable output)

## 11. Dashboard

- [ ] 11.1 Build the dashboard route (controls and profiles overview, verdict counts, top threat categories, budget vs limits, recent escalations) fed by the metrics and audit queries; verify it renders with seeded data (verify: component renders expected sections against fixture data)
- [ ] 11.2 Add live refresh (polling) and the policy/signature feed state view showing versions in force; verify editing policy.json is reflected after reload (verify: manual check on `bun run dev`)

## 12. Demo, docs, and architecture

- [ ] 12.1 Build the demo showcase traffic (guarded chat page and/or scripted MCP client) exercising allow, redact, block, and escalate paths end to end; verify each path demoable locally (verify: demo walkthrough script in `docs/demo.md` runs as written)
- [ ] 12.2 Write `docs/architecture.md` with the ASCII architecture diagram and the tier/pipeline explanation required by the challenge; verify the diagram matches the implemented stage order (verify: doc review against `src/control` modules)
- [ ] 12.3 Write the judge quickstart (run tests, run the app, edit policy and feed live, read the dashboard, export audit) in README; verify commands run as written from a clean clone (verify: README commands executed successfully)

## 13. Integration verification

- [ ] 13.1 Run the full hermetic suite with no credentials set and verify all spec scenarios pass (verify: `bun run test` green with `TYPESAFE_API_KEY` unset)
- [ ] 13.2 Verify `bun run verify` (typecheck + biome) passes and record performance telemetry for the deterministic and semantic paths (verify: telemetry numbers captured in `docs/performance.md`)
- [ ] 13.3 Run the live smoke suite with `TYPESAFE_API_KEY` set and verify the real Jev path end to end (verify: `bun run test:live` green)
