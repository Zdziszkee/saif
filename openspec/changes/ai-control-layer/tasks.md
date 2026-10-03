# Tasks

## 1. Scaffolding and dependencies

- [ ] 1.1 Add `@tanstack/ai-mcp` (TanStack MCP module: hub server surface + external MCP clients) and `@tanstack/ai-typesafe` and `vitest` to package.json, remove the `@modelcontextprotocol/sdk` dependency and `src/utils/mcp-handler.ts`, add `test` (unit tier) and `test:integration` scripts, and verify `bun install` and `bunx vitest run` execute a smoke test (verify: smoke test passes via `bun run test`)
- [ ] 1.2 Extend `src/env.ts` with optional `TYPESAFE_API_KEY`, the OpenAI-compatible model connection (`MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY`), policy/feed paths, and budget window defaults; verify `bun run typecheck` passes and the app starts without the keys set (verify: `bun run typecheck` and `bun run dev` both succeed)
- [ ] 1.3 Create the module skeleton `src/control/` (policy, pipeline, tiers, budget, audit, authorization), `src/lib/jev/` (adapter, catalog), and `src/hub/` (mcp-server, tool catalog, agentic loop, connections) with empty index exports; verify typecheck passes (verify: `bun run typecheck`)

## 2. Policy engine

- [ ] 2.1 Implement the zod policy schema (tool and action catalog with capability verbs, confirmation flags and classification overrides, per-user grants, network egress allowlist, tool-call enforcement mode, custom regex detection rules with id, kind, pattern, target directions and mapped action, controls, per-direction thresholds, strictness profiles permissive/standard/strict, model allowlist, budget rules, semantic check definitions with type, wording, criteria, activation and thresholds, failure verdicts) and verify schema tests reject invalid documents, including rules with uncompilable or unbounded regexes (verify: policy schema tests pass)
- [ ] 2.2 Implement the policy store (versioned documents in SQLite, create-on-edit with schema validation, rollback to prior versions, JSON import/export) and the runtime loader with immutable snapshot, atomic swap, and last-valid fallback; verify versioning and reload tests pass (verify: tests cover new-version-on-edit, invalid-edit rejection, rollback, and import/export round-trip)
- [ ] 2.3 Ship `policy.json` plus `policy.permissive.json` and `policy.strict.json` sample variants and document every field in `docs/policy.md`; verify documented example values validate against the schema (verify: tests load all sample files successfully)

## 3. Storage layer

- [ ] 3.1 Add `audit_events`, `usage_records`, `budget_windows`, `policy_versions`, `mcp_connections`, and `approval_items` tables to `src/db/schema.ts`, generate the Drizzle migration, and verify `bun run db:migrate` applies cleanly to a fresh database (verify: migration runs on a temp SQLite file)
- [ ] 3.2 Implement repository modules (append-only audit insert and query, usage insert and aggregation, budget window upsert and read, policy version create/read/activate, MCP connection and tool registration, approval item lifecycle) and verify roundtrip tests on a temp database (verify: repository tests pass)

## 4. Deterministic tier

- [ ] 4.1 Implement detectors for secrets (API keys, tokens) and PII (email, phone, card, government-ID-like) returning kind and span, and wire policy-defined custom regex rules into the same detection pass (rule id as detector id, per-rule direction scope and mapped action); verify positive and negative detector tests pass, including a custom-rule fixture (verify: detector tests pass)
- [ ] 4.2 Implement typed-placeholder redaction of detected spans and verify redaction preserves surrounding content (verify: redaction tests pass)
- [ ] 4.3 Document detection kinds and placeholder formats in `docs/controls.md`; verify documented examples match test fixtures (verify: examples in docs correspond 1:1 to passing fixtures)
- [ ] 4.4 Implement connected-service credential detection and redaction for user-connected MCP service tokens; verify leak tests pass (verify: no service token appears in model-visible content, logs, or audit rows)
- [ ] 4.5 Implement domain egress enforcement (network-classified call targets and MCP connection endpoints against the policy allowlist) and verify deterministic block tests pass (verify: non-allowlisted target blocked without invoking the semantic tier)

## 5. Signature engine

- [ ] 5.1 Implement the signature feed schema and loader (identifier, name, description, pattern, kind including `mcp_tool_poisoning` and `exfiltration`, severity, source, references, timestamps, enabled flag) with per-entry validation, skip-invalid behavior, deterministic dedup, feed version hashing, and optional detached-signature verification; verify loader tests pass (verify: feed loader tests cover valid load, skip-invalid, dedup, version hash, and tampered-feed rejection)
- [ ] 5.2 Implement the shared canonicalization and decode module `src/control/text/` (NFKC + casefold, zero-width/bidi stripping, homoglyph folding, leetspeak folding, whitespace/punctuation collapsing, bounded layered base64/URL/hex/HTML-entity decode) with span mapping back to raw content, reused by the deterministic tier L4 re-scan; verify transform-matrix tests pass (verify: each evasion transform variant of a known payload is matched and maps to the raw span)
- [ ] 5.3 Implement the matcher (literal prefilter, per-signature compiled regex over raw/canonical/decoded forms, optional validator stage) and structural suspect signals (invisible-character density, payload splitting, high-entropy blobs); verify exploit-positive and benign-negative tests pass across all kinds and obfuscated forms (verify: matcher tests cover injection, jailbreak, tool-abuse, unsafe-deserialization, supply-chain, tool-poisoning, and exfiltration markers in raw and evasion-variant forms)
- [ ] 5.4 Implement match safety (per-pattern and per-content match budget, bounded feed size, ReDoS containment); verify a pathological pattern is reported and skipped without stalling (verify: match-budget test proves remaining signatures still fire)
- [ ] 5.5 Implement policy-mapped actions (severity to default action, per-signature overrides, suspect action and threshold); verify mapping tests pin every action (verify: severity-mapping and override tests pass)
- [ ] 5.6 Implement feed hot reload and ship `signatures.json` seeded with ~30-50 known historical AI-exploit patterns across all kinds, each with positive and evasion-variant fixtures rewritten from cited public sources; verify a reload test adds a pattern that blocks a matching request (verify: hot-reload integration test passes)
- [ ] 5.7 Implement tool-schema scanning at MCP registration and audit provenance recording (signature id, source, feed version hash, matched form, raw-mapped span); verify poisoned tool descriptions are rejected at catalog admission and provenance lands in audit (verify: registration-scan and provenance tests pass)
- [ ] 5.8 Implement external feed ingestion adapters — MITRE ATLAS STIX 2.1 bundles and OSV malicious-package reports (OpenSSF `MAL-`) — plus an offline corpus importer (JailbreakBench artifacts, in-the-wild jailbreak prompts, AISec 2026 prompt-injection benchmark, tldrsec, PayloadsAllTheThings) normalizing into the internal schema with external references (ATLAS / OWASP LLM Top 10 2026 / Agentic AI Top 10 / MCP Top 10 / MAL-) retained; verify adapter and citation tests pass (verify: adapter tests cover ATLAS STIX ingest, OSV report ingest, source outage containment, and reference retention)
- [ ] 5.9 Implement feed currency: conditional-GET polling (ETag/Last-Modified) on a configurable interval, last-known-good retention on refresh failure, per-source refresh state, and a vendored feed snapshot for offline operation; verify poll and failure-retention tests pass without network (verify: currency tests cover new-signature activation, failed-refresh retention, and snapshot fallback)

## 6. Semantic tier (Jev)

- [ ] 6.1 Load the local Intent skills for `@tanstack/ai` (ai-core and custom-backend-integration) and implement the typed question catalog (prompt injection, jailbreak, data exfiltration, malicious code booleans; threat category choice; severity score) plus policy-defined custom typed checks (boolean/choice/score), with policy-driven activation, wording and criteria overrides, and threshold-to-verdict conditions; verify catalog tests pass (verify: catalog builds question maps from policy check definitions correctly)
- [ ] 6.2 Implement the `SemanticClassifier` interface and the Jev implementation over `decide()` with `@tanstack/ai-typesafe`, wired to `TYPESAFE_API_KEY` as the only product-path classifier; verify the integration smoke reports a clear configuration error without the key and passes with it (verify: `bun run test:integration` behavior confirmed both ways)
- [ ] 6.3 Implement fixed-evidence classifier doubles for the unit tier, injected only through the test harness (never selectable via policy or runtime configuration); verify unit classifier tests pass without network (verify: classifier tests pass with `TYPESAFE_API_KEY` and `MODEL_*` unset)
- [ ] 6.4 Verify answer consumption and typing: typed answer shapes carry probability distributions and confidence where required; verify compile-time narrowing test (verify: `bun run typecheck` includes answer-shape assertions)

## 7. Budget governance

- [ ] 7.1 Implement the pre-flight estimator (token estimate, projected cost, projected compute time) and reservation against `budget_windows`; verify reservation and exhaustion tests pass (verify: budget tests cover under-budget pass and exhausted block)
- [ ] 7.2 Implement post-flight settlement from actual usage (tokens, computed cost, compute time, including semantic-tier input tokens) with reconciliation against the reservation; verify settlement tests pass (verify: usage and reconciliation tests pass)
- [ ] 7.3 Implement window rollover by time bucket and per-key/window reporting queries; verify rollover tests pass (verify: rollover and reporting query tests pass)

## 8. Pipeline and verdict mapping

- [ ] 8.1 Implement `applyPolicy(evidence, profile)` as a pure function mapping detections, signatures, semantic answers, and budget state to `allow | redact | block | escalate` per direction; verify threshold boundary tests pin every cutoff (verify: verdict mapping tests pass with fixed evidence fixtures)
- [ ] 8.2 Implement the pipeline orchestrator with the cheap-first stage order from design D4 (shape validation, model allowlist, tool authorization, egress allowlist, signature feed, deterministic PII/secrets, budget pre-flight, semantic tier), deterministic-block short-circuit, redact-then-classify flow, and fail-closed handling with timeouts; verify pipeline tests pass including classifier-unavailable failure (verify: orchestrator tests pass with the harness classifier double)
- [ ] 8.3 Verify profile-driven divergence: identical evidence yields different verdicts under permissive and strict profiles (verify: tests assert both verdicts from one shared fixture)

## 9. Tool authorization

- [ ] 9.1 Implement action classification (catalog override first, name/description inference into `read | create | modify | delete | execute | network` otherwise); verify classification tests pass (verify: tests cover `createIssue`→`create`, `deletePage`→`delete`, and override precedence)
- [ ] 9.2 Implement grant evaluation with deny-by-default and the deletion hard gate (`require-approval` on every delete-classified call regardless of configuration); verify authorization decision tests pass (verify: tests cover granted allow, ungranted deny, per-user divergence, and deletion always require-approval)
- [ ] 9.3 Implement the approvals queue (hold require-approval calls with tool/action/arguments, approve and deny actions with actor and timestamp, pass-through on approved next attempt); verify workflow tests pass (verify: tests cover hold, approve-then-pass, and deny-stays-blocked)
- [ ] 9.4 Wire tool authorization into the hub tool-call surface and the guard API's subject/tool check; verify seam authorization tests pass (verify: route and hub tests cover allowed and denied tool decisions)

## 10. MCP safety hub

- [ ] 10.1 Implement the hub's MCP server surface with `createMCPServer` from `@tanstack/ai-mcp` in `src/routes/mcp.ts` (replacing the `@modelcontextprotocol/sdk` demo handler), with `askModel` as the only model-reaching interface backed by the OpenAI-compatible connection from env (endpoint, model, key); verify hub prompt tests pass (verify: tests cover governed prompt flow and absence of any bypass route)
- [ ] 10.2 Implement hub-hosted tools including risky demo tools (`fetchUrl`, `deleteAllTodos`) with tool arguments and results inspected by the pipeline; verify tool governance tests pass (verify: tests cover blocked call, redacted arguments, and inspected results)
- [ ] 10.3 Implement configurable tool-call enforcement (tool-scoped vs turn-scoped per strictness profile) and the governed agentic tool loop bounded by request-count and compute-time budgets; verify enforcement and loop tests pass (verify: tests cover both enforcement modes and budget-bounded loop termination)
- [ ] 10.4 Implement external MCP connections via `createMCPClient`/`createMCPClients` from `@tanstack/ai-mcp` (endpoint plus user-provided service token carried only in per-connection transport headers, egress-allowlist check on connect, dynamic tool registration into the catalog ungranted) and credential custody (tokens used only to call the target server, never in model-visible content or logs); verify hub connection and custody tests pass (verify: tests cover connect-then-deny-until-granted, non-allowlisted endpoint rejection, and token leak prevention)

## 11. Enforcement seams

- [ ] 11.1 Implement the generic guard API route (`/api/guard`) with request shape validation and defined rejection response; verify positive and negative route tests pass (verify: route tests cover allow, redact, block, and malformed request)
- [ ] 11.2 Create the chat demo page as a client of the hub (`askModel`) and wire the pipeline over prompt and answer via the `guardInteraction()` wrapper; verify chat seam tests pass (verify: tests cover blocked prompt and redacted answer)
- [ ] 11.3 Wire the pipeline and tool authorization into the hub tool-call surface so built-in and connected tools are governed; verify hub seam tests pass (verify: tests cover denied ungranted call, require-approval call, and allowed call)

## 12. Observability

- [ ] 12.1 Record audit entries from the pipeline (verdict, evidence, policy version, model, usage, latency, tool authorization decisions, approval outcomes with actor and timestamp) and verify append-only behavior tests pass (verify: audit tests cover allow, redact, block, escalate, approval, and failure entries)
- [ ] 12.2 Implement metrics aggregation (verdicts by control and category, redactions, budget consumption, latency percentiles) and verify aggregation tests pass (verify: metrics tests pass against seeded audit data)
- [ ] 12.3 Implement audit export endpoints (JSONL and CSV with filters: time range, verdict, control, consumer key) and verify export tests pass (verify: export tests assert filter correctness and parseable output)

## 13. Dashboard

- [ ] 13.1 Build the dashboard route (controls and profiles overview, verdict counts, top threat categories, budget vs limits, recent escalations) fed by the metrics and audit queries; verify it renders with seeded data (verify: component renders expected sections against fixture data)
- [ ] 13.2 Build the policy editing surface (edit, validate, save as new version, version history, rollback, JSON import/export); verify editing and rollback tests pass (verify: tests cover valid save, invalid save rejected, and rollback)
- [ ] 13.3 Build the approvals queue UI (pending tool calls with tool, action, arguments and approve/deny actions) and the tool decision log view; verify it renders and dispatches decisions (verify: UI tests cover approve and deny actions against a fixture queue)
- [ ] 13.4 Add live refresh (polling) and the policy/signature feed state view showing versions in force; verify policy edits are reflected after reload (verify: manual check on `bun run dev`)
- [ ] 13.5 Build the signature feed operations view (top firing signatures with counts and sources, per-source refresh state, per-signature enable/disable and mark-as-false-positive actions writing policy overrides); verify actions change subsequent verdicts without editing the feed (verify: dashboard tests cover signature counts, refresh state, and the false-positive override flow)

## 14. Demo, docs, and architecture

- [ ] 14.1 Build the demo showcase traffic through the hub (governed `askModel` prompt, risky tool call flowing through the approval queue, block and redact paths) exercising allow, redact, block, and require-approval end to end; verify each path demoable locally (verify: demo walkthrough script in `docs/demo.md` runs as written)
- [ ] 14.2 Write `docs/architecture.md` with the ASCII architecture diagram and the tier/pipeline explanation required by the challenge; verify the diagram matches the implemented stage order (verify: doc review against `src/control` modules)
- [ ] 14.3 Write the judge quickstart (run the unit suite, run the app, edit the policy in the dashboard and via JSON import/export, process an approval, export audit) in README; verify commands run as written from a clean clone (verify: README commands executed successfully)

## 15. Test suite and integration verification

- [ ] 15.1 Run the unit tier with no credentials set and verify all spec scenarios pass (verify: `bun run test` green with `TYPESAFE_API_KEY` and `MODEL_*` unset)
- [ ] 15.2 Run the integration/end-to-end tier and verify it reports a clear configuration error without credentials and passes with them (verify: `bun run test:integration` both ways)
- [ ] 15.3 Verify `bun run verify` (typecheck + biome) passes and record performance telemetry for the deterministic and semantic paths (verify: telemetry numbers captured in `docs/performance.md`)
