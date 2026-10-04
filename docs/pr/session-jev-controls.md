## Summary

- Adds a `JEV checks` tab to the Controls panel for configuring the checks performed by the JEV decision model: per-check enable toggles and per-direction `block`/`flag` thresholds, with question wording shown read-only.
- Adds a file-backed semantic store (`src/control/semantic/store.ts`) with content-hash versioning, 409 stale-writer rejection, and atomic writes for `policy.jev.json`.
- Adds `GET`/`POST /api/jev` (`src/routes/api.jev.ts`) plus `getJevDocument`/`updateJevDocument` server functions, and makes hub builds re-read `policy.jev.json` so saves take effect via `refreshHubAfterPolicyWrite()`.
- Wires the Controls page to load and save the policy and JEV documents side by side with a combined dirty state and one Save action.

## Design

- Kept `policy.jev.json` separate from `policy.json`: the new store mirrors `src/control/policy/store.ts` and reuses `parseSemanticConfig`/`validateChecks`, so invalid saves return 400 and never touch the file.
- `buildSemanticControl()` keeps its sync signature and still returns null without a key; it now reads from a mutable `activeSemanticConfig` refreshed on every policy write instead of the import-time `SEMANTIC_DEFAULTS`.
- UI scope is intentionally narrow (toggles + thresholds only): no wording edits, no add/remove, no group mapping, keeping validation and demo risk low.

## Validation

- `bun run verify` (tsc + biome) passes.
- `bun test`: 1143 pass, 9 skip, 0 fail, including new `tests/semantic-store.test.ts` (roundtrip, stale 409, invalid 400).
