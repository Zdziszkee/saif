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

## Polish batch

- Threshold inputs in `profiles-editor` are spinner-free text inputs: empty input reverts to the current value on blur, non-numeric input reverts, numeric input is clamped to [0, 1] before `onChange`.
- Controls route loader/save goes through SSR-safe server functions (`getPolicyDocument`/`updatePolicyDocument` in `policy-server.ts`) instead of `fetch("/api/policy")`.
- Hub refresh parity: `updatePolicyDocument` calls `refreshHubAfterPolicyWrite()` on success, matching the `POST /api/policy` write path.
- Single Overview: `/` accepts `?consumer=`/`?role=` search params and renders `ActivitySections` below the dashboard; `/dashboard` redirects to `/` forwarding validated search params; `__root` nav keeps Overview only.
- Escalation filter aligns to the subject-or-consumer mapping (`filterEscalationsByRole` over `selectEscalations` output); `dashboard.tsx` no longer duplicates the escalation queue.
- Activity sections use plain anchor `href`s for consumer/scope links instead of router `Link`s.
- Test updates: `dashboard.test.ts` renders `ActivitySections` for escalation scope cases; new `controls-polish.test.ts` covers threshold commit/search validation; new `activity-sections.test.ts` covers scope banner, consumer hrefs, and empty states.

## Validation (polish batch)

- `bun run verify` (`tsc --noEmit && biome check .`): clean — Checked 188 files, no fixes applied.
- `bun test --path-ignore-patterns tests/integration`: 717 pass, 0 fail across 57 files.
- `bun --bun vite build`: success (only expected Radix `MODULE_LEVEL_DIRECTIVE` notes); `routeTree.gen.ts` unchanged (route shapes stable).
