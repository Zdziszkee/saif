## Summary

- Extract shared control-tier helpers so the severity table in `control/types.ts` is the only ranking: `control/verdicts.ts` (`worstOutcome`, `isMoreSevere`, `splitOutcome`), `control/scan.ts` (`scanMatches`), and `redactionsFromFindings` in `control/redact.ts`, adopted by the deterministic, signature, and semantic tiers and the pipeline.
- Add small `lib/` helpers (`errors`, `json`, `ids`, `guards`) plus `control/hash.ts` (`sha256Hex`), and use them at all call sites: error descriptions, JSON parse fallbacks, id sequences, `isOneOf` guards, and policy/feed version stamps.
- Unify the caller-identity seams: `identityRejection` in `control/subjects.ts`, used by `control/guard-api.ts` and `routes/mcp.ts`, plus `rejectionKind` in `control/guard.ts` for the guard API and `toToolRejection`.
- Unify fail-closed plumbing: `control/policy/unavailable.ts` serves both the live detection control and the hub fallback; `hub/loop.ts` reuses `definedRejection`.
- Fix latent crashes: `redactJson` fails closed on non-JSON input instead of throwing out of `guardInteraction`; `mcp-todos.ts` uses named `node:fs` imports, validates the store on load, and returns copies.
- Apply strictness idioms: named `ComponentProps` imports in `ui/*`, `??` in `progress.tsx`, zod parsing in `hub/tools.ts`, validated narrowing in `catalog.ts`, `audit.ts`, `connections.ts`, and `playground.tsx`, and honest `exactOptionalPropertyTypes` types for `ThresholdLadder`/`SemanticCheck` (this removes two load-bearing `as` casts in `semantic/config.ts`).
- Remove the committed `pnpm.onlyBuiltDependencies` key per the Bun-only toolchain rule.

Rebased onto `origin/master` (`c5d15c4`, caller-identity model): the seam helpers became `identityRejection` under the new `x-user-id`/`x-user-group-id` model, and the hub keeps upstream's null-skipping `buildSemanticControl`.

## Design

Extractions preserve exact runtime behavior (same messages, same verdicts, same version hashes); the only intentional behavior changes are fail-closed safety (redact fallback, validated tool args, validated todo store). Larger spec gaps found during the audit (budget enforcement, profile thresholds, suspect scoring, evasion-resistant matching, SSRF/catalog defaults) are proposal-sized and intentionally left out.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean, 123 files.
- `bun run test`: 247 pass, 0 fail, 704 assertions across 31 files.
