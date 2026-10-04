# Session: mock E2E JEV UI (A5 — UI-vs-TASK.md audit)

## Summary

- Audited the UI (`/`, `/controls`, `/playground`, TierStatusBanner) against
  TASK.md Expected Outcome + Formal Requirements.
- Added the missing semantic (JEV) version stamp to the pure dashboard data
  path (`summarizePolicy` / `buildDashboardData` / `DashboardData`) with
  `"unavailable"` default, mirroring the feed-version pattern.
- Surfaced the stamp in the dashboard header (`jev <version>` / `jev unknown`
  badge) and the `/controls` status bar (`jev v<version>` from the loaded JEV
  document).
- Kept `package.json` `test` as bare `bun test`; mock JEV suites live in
  top-level `tests/*.test.ts` so they run by default; the live JEV tier stays
  gated behind `SEMANTIC_LIVE=1` (+ key), with the hermetic fail-closed block
  running under plain `bun test`.

## Design

- Version stamps stay pure: `summarizePolicy(snapshot, feedVersion,
  semanticVersion)` and `buildDashboardData(snapshot, generatedAt, events,
  versions?: VersionStamps)` take plain strings, so render/unit tests pin
  them without I/O. The versions ride one options object (`useMaxParams`
  caps positional params at 4). `getDashboardData` (server) loads the
  semantic snapshot from `policy.jev.json` and degrades to `"unavailable"`,
  same as the feed.
- Live semantic *mode* (enabled/disabled without `TYPESAFE_API_KEY`) stays a
  runtime concern via `GET /api/status` + `TierStatusBanner` by design — the
  pure data layer cannot read env. Stamps answer "which config", the banner
  answers "is the tier live".
- `/controls` reuses its already-loaded JEV document version (no new data
  path); `/playground` keeps the banner + per-hit engine badges (no loader;
  see checklist).

## TASK.md coverage

| TASK.md requirement | UI / code surface | Status |
| --- | --- | --- |
| Gateway/proxy control layer | `src/routes/api.guard.ts`, `api.chat-completions.ts`, `v1.chat.completions.ts`, `mcp.ts`, `src/hub/` | Covered |
| Sample configs: strictness + budget | `policy.json`, `policy.permissive.json`, `policy.strict.json`, `policy.jev.json`, `policy.mcp.json` | Covered (`tests/policy-samples.test.ts`) |
| Dashboard: controls | Controls in force + strictness profiles sections | Covered |
| Dashboard: posture | PostureSection (allow/redact/block/escalate) | Covered |
| Dashboard: blocked threats | ThreatsSection by control/category | Covered |
| Dashboard: metrics/cost | BudgetSection (usage vs limit, series), LatencySection, People, ActivitySections, audit export links | Covered |
| Version stamps on every view | Header badges (policy/feed/jev), `/controls` status bar | Fixed this session (see gaps) |
| Test suite positive + negative | `tests/` allow + block/redact suites, budget, exploits | Covered |
| Centralized policy | `policy.json` + loader/store, `/controls` editor | Covered |
| Deterministic + semantic tiers | Detection builtins/rules, signature feed, JEV classifier | Covered |
| Budget governance | Budget rules/ledger, `BudgetSection`, over-budget verdicts | Covered |
| Historical-attack signatures feed | `signatures.json` + feed store, signature control | Covered |
| Security reporting/auditing | Audit sink, `/api/audit`, export JSONL/CSV, dashboard | Covered |

## Gap list (this audit)

1. Fixed: `DashboardData` had no semantic version — added `semanticVersion`
   (default `"unavailable"`) via `summarizePolicy`/`buildDashboardData`.
2. Fixed: dashboard header showed only policy + feed badges — added
   `jev <version>` / `jev unknown` badge.
3. Fixed: `/controls` status bar showed only the policy version — added
   `jev v<version>` from the loaded JEV document.
4. Open (by design): `/playground` has no static policy/feed stamps (no route
   loader); semantic mode is banner-only there. Guard verdicts carry per-hit
   engine badges (`regex`/`feed`/`JEV`) as the per-call substitute.
5. Open (by design): `/controls` has no feed-version stamp (not loaded by its
   document calls); policy + JEV stamps present.

## Validation

- [ ] `bun test tests/dashboard.test.ts tests/policy-samples.test.ts` (smoke)
- [ ] `bun test tests/integration/jev.integration.test.ts` (hermetic block passes; live block skips without `SEMANTIC_LIVE=1`)
- [ ] `bunx biome check` on touched files
- [ ] `bun run verify` (full `tsc --noEmit` + biome; skipped in-session if slow)
- [ ] Manual: `/playground` + `/controls` with and without `TYPESAFE_API_KEY`
  (banner on/off, stamps visible, guard verdicts carry engine badges)

## Judges' commands (one-command hermetic suite)

`package.json` `test` stays bare `bun test`; the mock suites live in
top-level `tests/*.test.ts` so the default run includes them. No network,
no `SEMANTIC_LIVE`, no API key required.

| Command | What it proves |
| --- | --- |
| `bun test` | Full suite incl. `tests/mock-suite-config-reload.test.ts` (1589 pass, 0 fail, 91 files) |
| `bun test tests/mock-suite-config-reload.test.ts` | Config-reload suite alone: 21 tests, 61 assertions |
| `bun test tests/gateway-mock-policy-matrix.test.ts tests/gateway-mock-jev-e2e.test.ts tests/gateway-mock-signatures-mcp.test.ts tests/mock-jev.test.ts` | Existing mock E2E coverage alongside the new file |
| `bun run verify` | Full `tsc --noEmit` + `biome check .` gate |
| `SEMANTIC_MOCK=1 bun run dev` + `bun run mock:jev` | Interactive path: app + mock Jev on `:4321` (`MOCK_JEV_CONFIG` retunes scoring without code changes) |

## Config files judges may tweak + expected effect

Proven by `tests/mock-suite-config-reload.test.ts` (edit file, re-run
`bun test tests/mock-suite-config-reload.test.ts`, no restart needed for
detection/feed paths):

| File | Tweak | Expected effect |
| --- | --- | --- |
| `policy.json` | `detection.defaultActions.secret: block` -> `redact` | Secrets redact instead of block (mirrors shipped permissive divergence) |
| `policy.json` | Remove `employee-id` from `detection.rules` | `Badge EMP-482910` allows instead of redact on next inspection (live-bound) |
| `policy.json` | Add custom rule (e.g. block `JUDGEMARKER-[0-9]+` inbound) | Matching content blocks; removal re-allows |
| `policy.json` | `detection.defaultActions.suspect: flag` -> `block` | Luhn-failing card shapes block instead of allow+flag |
| `policy.json` | Empty `allowlist.models` | Any named model blocks; model-less prompts still allow |
| `policy.json` | `signatures.enabled: false` | `do anything now` (DAN) allows without touching the feed |
| `policy.json` | `signatures.suspect.threshold` outside `[0, 1]` | Rejected with issue path `controls.signatures.suspect.threshold`; shipped values are 0.9 / 0.8 / 0.6 (permissive / standard / strict) |
| `policy.json` (any malformed edit) | e.g. `{ "invalid": true }` | Loader keeps last valid snapshot; with none loaded, `policy-unavailable` blocks every interaction |
| `policy.jev.json` | Tighten a check `block` threshold (e.g. 0.9 -> 0.8 at P=0.85) | Allow flips to block; malformed edits throw `SemanticConfigurationError` at load |
| `policy.mcp.json` | Remove a group from `allowedGroups` | That group is denied the tool; unlisted tools deny everyone |
| `signatures.json` | Add/remove entries | `reload()` serves new entries under a new 64-hex version; empty/broken reloads keep the last good feed flagged unhealthy |
| `data/mock-jev-keywords.json` (via `MOCK_JEV_CONFIG`) | Edit keywords / `base` / `hit` / `max` | Mock scores shift accordingly; missing file or invalid JSON/schema fails fast instead of scoring silently wrong |

## TASK.md Formal Requirements traceability (Req 1-6)

| Req | Coverage | Self-test proof |
| --- | --- | --- |
| 1. Centralized Policy Engine | `policy.json` single source: controls, thresholds (Block vs Redact), allowlisted models, budget rules; loader hot-reloads with content-hash versions | New suite: all policy variants validate; edits flip verdicts live; malformed edits fail closed |
| 2a. Deterministic controls | Pattern matching (PII/secrets), custom scoped rules, auth/allowlist, shape limits | New suite: secret block/redact divergence, badge rule add/remove, allowlist emptying, suspect mapping |
| 2b. Semantic (AI) controls | Jev tier: `policy.jev.json` binary checks + per-direction ladders; mock Jev stands in hermetically | New suite: Jev catalog validates; threshold tightening flips allow->block; mock keyword config validates + fails fast |
| 3. Budget governance | Budget rules (tokens/cost/requests/compute) per key/model/period, over-budget verdict, ledger | `tests/gateway-mock-policy-matrix.test.ts` budgets across dimensions and windows (over-budget 403, zero upstream calls) |
| 4. Historical attack mitigation | `signatures.json` feed (MITRE Atlas / OWASP claims), severity/per-signature actions, version-stamped provenance | New suite: DAN block vs disabled-allow, feed reload version change, last-good retention; feed import covered by `tests/signature-feed-import.test.ts` |
| 5. Security reporting & auditing | Dashboard (controls, posture, blocked threats, budget/cost), audit sink + export, version stamps incl. `jev` badge (this session) | `tests/dashboard*.test.ts`, `tests/audit-*.test.ts`, `tests/jev-ui-visibility.test.ts` |
| 6. Self-testing suite | Positive (allowed) + negative (blocked/redacted) cases for every control, runnable via one command | This file + matrix/mock/mcp suites run under bare `bun test`; judges re-run after config edits |

## Validation (config-reload session)

- [x] `bun test tests/mock-suite-config-reload.test.ts` (21 pass, 0 fail)
- [x] `bunx biome check tests/mock-suite-config-reload.test.ts` (clean)
- [x] `bun test` (1589 pass, 9 skip, 0 fail, 91 files — new file included by default)
- [ ] `bun run verify` (full `tsc --noEmit` + biome; run before commit)
