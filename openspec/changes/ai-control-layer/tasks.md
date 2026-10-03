# Tasks

Scope: TASK.md §4 formal requirements (FR1-FR6) and §3 expected outcomes (EO1-EO4),
plus §6 live config/feed edits and performance telemetry. Nothing beyond the brief.

## 1. Scaffolding and dependencies

- [x] 1.1 Add `@tanstack/ai-typesafe` to package.json, keep the `test`/`test:integration` scripts on `bun test` (unit tier hermetic via `--path-ignore-patterns`, live tier opt-in via `SEMANTIC_LIVE=1`), and verify `bun install` and `bun test` execute the suite (verify: `bun run test` green with no network)
- [ ] 1.2 Extend `src/env.ts` with optional `TYPESAFE_API_KEY`, policy/feed paths, and budget window defaults; verify `bun run typecheck` passes and the app starts without the key set (verify: `bun run typecheck` and `bun run dev` both succeed)
- [ ] 1.3 Create the module skeleton `src/control/` (policy, pipeline, tiers, budget, audit) and `src/lib/jev/` (adapter, catalog) with empty index exports; verify typecheck passes (verify: `bun run typecheck`)

## 2. Policy engine

- [x] 2.1 Implement the zod policy schema (controls, custom regex detection rules with id, kind, pattern, direction scope and mapped action, semantic check definitions with type, wording, criteria, activation and thresholds, per-direction thresholds, strictness profiles permissive/standard/strict, model allowlist, budget rules, signature severity mapping with per-signature overrides and suspect configuration, failure verdicts) and verify schema tests reject invalid documents, including rules with uncompilable or unbounded regexes (verify: policy schema tests pass)
- [x] 2.2 Implement the policy loader with immutable snapshot, atomic swap, file-watch hot reload, and last-valid fallback; verify reload and invalid-reload tests pass (verify: loader tests cover live edit and rejection rollback)
- [x] 2.3 Ship `policy.json` plus `policy.permissive.json` and `policy.strict.json` sample variants and document every field in `docs/policy.md`; verify documented example values validate against the schema (verify: tests load all sample files successfully)

## 3. Storage layer

- [ ] 3.1 Add `audit_events`, `usage_records`, and `budget_windows` tables to `src/db/schema.ts`, generate the Drizzle migration, and verify `bun run db:migrate` applies cleanly to a fresh database (verify: migration runs on a temp SQLite file)
- [ ] 3.2 Implement repository modules (append-only audit insert and query, usage insert and aggregation, budget window upsert and read) and verify roundtrip tests on a temp database (verify: repository tests pass)

## 4. Deterministic tier

- [x] 4.1 Implement detectors for secrets (API keys, tokens) and PII (email, phone, card, government-ID-like) returning kind and span, and wire policy-defined custom regex rules into the same detection pass (rule id as detector id, per-rule direction scope and mapped action); verify positive and negative detector tests pass, including a custom-rule fixture (verify: detector tests pass)
- [x] 4.2 Implement typed-placeholder redaction of detected spans and verify redaction preserves surrounding content (verify: redaction tests pass)
- [ ] 4.3 Document detection kinds and placeholder formats in `docs/controls.md`; verify documented examples match test fixtures (verify: examples in docs correspond 1:1 to passing fixtures)

## 5. Signature engine (historical attack mitigation)

- [ ] 5.1 Implement the signature feed schema and loader (identifier, name, description, pattern, kind, severity, source, references, timestamps, enabled flag) with per-entry validation, skip-invalid behavior, deterministic dedup, feed version hashing, and optional detached-signature verification; verify loader tests pass (verify: feed loader tests cover valid load, skip-invalid, dedup, version hash, and tampered-feed rejection)
- [ ] 5.2 Implement the shared canonicalization and decode module `src/control/text/` (NFKC + casefold, zero-width/bidi stripping, homoglyph folding, leetspeak folding, whitespace/punctuation collapsing, bounded layered base64/URL/hex/HTML-entity decode) with span mapping back to raw content, reused by the deterministic tier L4 re-scan; verify transform-matrix tests pass (verify: each evasion transform variant of a known payload is matched and maps to the raw span)
- [ ] 5.3 Implement the matcher (literal prefilter, per-signature compiled regex over raw/canonical/decoded forms, optional validator stage) and structural suspect signals (invisible-character density, payload splitting, high-entropy blobs); verify exploit-positive and benign-negative tests pass across all kinds and obfuscated forms (verify: matcher tests cover injection, jailbreak, malicious code execution, unsafe-deserialization, and supply-chain markers in raw and evasion-variant forms)
- [ ] 5.4 Implement match safety (per-pattern and per-content match budget, bounded feed size, ReDoS containment); verify a pathological pattern is reported and skipped without stalling (verify: match-budget test proves remaining signatures still fire)
- [ ] 5.5 Implement policy-mapped actions (severity to default action, per-signature overrides, suspect action and threshold); verify mapping tests pin every action (verify: severity-mapping and override tests pass)
- [ ] 5.6 Implement feed hot reload and ship `signatures.json` seeded with known historical AI-exploit patterns (prompt injection, jailbreak, malicious code execution, unsafe deserialization, model-repo supply chain), each with positive and evasion-variant fixtures rewritten from cited public sources; verify a reload test adds a pattern that blocks a matching request (verify: hot-reload integration test passes)
- [ ] 5.7 Implement audit provenance recording (signature id, source, feed version hash, matched form, raw-mapped span); verify provenance lands in audit (verify: provenance tests pass)
- [ ] 5.8 Implement external feed ingestion adapters — OSV malicious-package reports (OpenSSF `MAL-`) and MITRE ATLAS STIX 2.1 bundles — plus an offline corpus importer (JailbreakBench artifacts, in-the-wild jailbreak prompts, public payload collections) normalizing into the internal schema with external references retained; verify adapter and citation tests pass (verify: adapter tests cover OSV report ingest, ATLAS STIX ingest, source outage containment, and reference retention)
- [ ] 5.9 Implement feed currency: conditional-GET polling (ETag/Last-Modified) on a configurable interval, last-known-good retention on refresh failure, per-source refresh state, and a vendored feed snapshot for offline operation; verify poll and failure-retention tests pass without network (verify: currency tests cover new-signature activation, failed-refresh retention, and snapshot fallback)

## 6. Semantic tier (Jev)

- [x] 6.1 Implement the policy-driven binary check catalog in `src/control/semantic/checks.ts`: each policy check is one TypeSafe `noul` question (`id`, `type: "boolean"`, `instructions`, `enabled`, per-direction threshold ladders) built into a single question map for one `decide()` round trip; verify catalog tests pass (verify: `bun run test` covers buildQuestions mapping, disabled-check omission, and rejection of duplicate/reserved/empty ids, empty instructions, non-boolean types and out-of-range thresholds)
- [x] 6.2 Implement the `SemanticClassifier` interface and the Jev implementation over `decide()` with `@tanstack/ai-typesafe`, wired to `TYPESAFE_API_KEY` as the only product-path classifier; verify behavior with and without the key (verify: `bun run test:integration` reports a clear `SemanticConfigurationError` naming `TYPESAFE_API_KEY` when unset, and exercises the real decision model when set)
- [x] 6.3 Implement fixed-evidence classifier doubles for the unit tier, injected only through the test harness (kept out of the module's public `index.ts`); verify unit classifier tests pass without network (verify: `bun run test` green with `TYPESAFE_API_KEY` and `MODEL_*` unset)
- [x] 6.4 Verify answer consumption and typing: binary answers carry P(true) with no confidence field, unusable answers fail closed, and the evidence type carries no verdict; verify compile-time narrowing test (verify: `bun run typecheck` includes `@ts-expect-error` answer-shape and no-verdict assertions)

## 7. Budget governance

- [ ] 7.1 Implement the pre-flight estimator (token estimate, projected cost, projected compute time) and reservation against `budget_windows`; verify reservation and exhaustion tests pass (verify: budget tests cover under-budget pass and exhausted block)
- [ ] 7.2 Implement post-flight settlement from actual usage (tokens, computed cost, compute time, including semantic-tier input tokens) with reconciliation against the reservation; verify settlement tests pass (verify: usage and reconciliation tests pass)
- [ ] 7.3 Implement window rollover by time bucket and per-key/window reporting queries; verify rollover tests pass (verify: rollover and reporting query tests pass)

## 8. Pipeline and verdict mapping

- [ ] 8.1 Implement `applyPolicy(evidence, profile)` as a pure function mapping detections, signatures, semantic answers, and budget state to `allow | redact | block | escalate` per direction; verify threshold boundary tests pin every cutoff (verify: verdict mapping tests pass with fixed evidence fixtures)
- [ ] 8.2 Implement the pipeline orchestrator with the cheap-first stage order from design D4 (shape validation, model allowlist, signature feed, deterministic PII/secrets, budget pre-flight, semantic tier), deterministic-block short-circuit, redact-then-classify flow, and fail-closed handling with timeouts; verify pipeline tests pass including classifier-unavailable failure (verify: orchestrator tests pass with the harness classifier double)
- [ ] 8.3 Verify profile-driven divergence: identical evidence yields different verdicts under permissive and strict profiles (verify: tests assert both verdicts from one shared fixture)

## 9. Enforcement seams

- [x] 9.1 Implement the generic guard API route (`/api/guard`) with request shape validation and defined rejection response; verify positive and negative route tests pass (verify: route tests cover allow, redact, block, and malformed request)
- [x] 9.2 Create a minimal chat demo seam wired through the `guardInteraction()` wrapper over prompt and answer; verify chat seam tests pass (verify: tests cover blocked prompt and redacted answer)

## 10. Observability

- [ ] 10.1 Record audit entries from the pipeline (verdict, evidence, policy version, feed version, model, usage, latency) and verify append-only behavior tests pass (verify: audit tests cover allow, redact, block, escalate, and failure entries)
- [ ] 10.2 Implement metrics aggregation (verdicts by control and category, redactions, budget consumption, latency percentiles) and verify aggregation tests pass (verify: metrics tests pass against seeded audit data)
- [ ] 10.3 Implement audit export endpoints (JSONL and CSV with filters: time range, verdict, control, consumer key) and verify export tests pass (verify: export tests assert filter correctness and parseable output)

## 11. Dashboard

- [ ] 11.1 Build the dashboard route (controls and profiles overview, verdict counts, top threat categories, budget vs limits, recent escalations, policy and signature feed versions in force) fed by the metrics and audit queries; verify it renders with seeded data (verify: component renders expected sections against fixture data)
- [ ] 11.2 Add live refresh (polling); verify updates appear within one refresh interval (verify: manual check on `bun run dev`)

## 12. Demo, docs, and architecture

- [ ] 12.1 Build the demo showcase traffic (guarded chat prompt and scripted interactions exercising allow, redact, block, and escalate paths end to end); verify each path demoable locally (verify: demo walkthrough script in `docs/demo.md` runs as written)
- [ ] 12.2 Write `docs/architecture.md` with the ASCII architecture diagram and the tier/pipeline explanation required by the challenge; verify the diagram matches the implemented stage order (verify: doc review against `src/control` modules)
- [ ] 12.3 Write the judge quickstart (run tests, run the app, edit policy and feed live, read the dashboard, export audit) in README; verify commands run as written from a clean clone (verify: README commands executed successfully)

## 13. Test suite and verification

- [ ] 13.1 Run the test suite with no credentials set and verify all spec scenarios pass (verify: `bun run test` green with `TYPESAFE_API_KEY` unset)
- [ ] 13.2 Verify `bun run verify` (typecheck + biome) passes and record performance telemetry for the deterministic and semantic paths (verify: telemetry numbers captured in `docs/performance.md`)
