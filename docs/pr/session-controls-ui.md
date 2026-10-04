## Summary

- Adds UI-editable controls: new `/controls` route with General, Detection, Allowlist, and Profiles tabs backed by `GET`/`POST /api/policy`.
- Adds file-backed policy store (`src/control/policy/store.ts`): `parsePolicy` validation, `baseVersion` optimistic locking (409 on stale), atomic temp-file rename, and `policyVersion` hash return.
- Wires live enforcement: `POST /api/policy` calls `refreshHubAfterPolicyWrite()` so allowlist, thresholds, profiles, and signatures rebuild on next request; detection stays live-bound.
- Reorganizes UI shell: nav is Overview (`/`) / Activity (`/dashboard`) / Controls (`/controls`) / Playground (`/playground`), shell widened to `max-w-7xl`, dashboard scope hooks extracted to `src/components/dashboard/scope.ts`, Overview variant hides People/escalations.
- Adds `tests/policy-ui-validation.test.ts` and `tests/policy-ui-scope.test.ts` for schema rejection (duplicate id, unbounded regex, unknown keys, bad thresholds) and editor helpers (canonical dirty check, stale detection).

## Design

File writes remain the persistence model: the UI posts a full validated `Policy`, the server rejects invalid/stale documents before touching disk, and the loader's last-valid-wins is the second defense. The hub is not rebuilt inline; the cached promise is dropped and lazily rebuilt so in-flight requests finish on the old pipeline and an invalid rewrite fails closed like a fresh boot. `policy.jev.json` stays import-time and out of scope.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean — Checked 185 files, no fixes applied.
- `bun test --path-ignore-patterns tests/integration`: 702 pass, 0 fail across 55 files.
- `bun --bun vite build`: success, regenerated `src/routeTree.gen.ts` for `/controls` and `/api/policy` (only expected Radix `MODULE_LEVEL_DIRECTIVE` notes).
