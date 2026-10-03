## Summary

- Idiom pass over `src/` and `scripts/`: nullish coalescing, optional
  chaining/calls, logical fallbacks, and one shared predicate. Every change is
  behavior-preserving and covered by the existing suite.
- `AGENTS.md`: new **TypeScript idioms** section recording the accepted forms and
  how each maps onto the repo's strict lint set, so future passes do not
  re-litigate them.
- No dependency, `tsconfig.json`, `biome.json`, or lockfile change.

Specifically:

- `src/control/deterministic/detectors.ts`: `detectionFromMatch` uses an optional
  call (`pattern.validate?.(value) ?? …`) and `pattern.context ?? []` instead of
  three `=== undefined` ternaries.
- `src/control/semantic/state.ts`: `flags: [...(input.flags ?? [])]`.
- `src/control/audit.ts`: `csvCell` collapses a `=== undefined || === null` ternary
  to `String(value ?? "")`.
- `src/control/subjects.ts`: `headers.get(name) || undefined`, with a comment on
  why `||` (an empty header is "no key") and not `??`.
- `src/control/deterministic/control.ts`: `enabledFamilies()` becomes
  `builtinFamilies.filter((family) => builtins[family])`.
- `src/control/types.ts` + `src/control/guard.ts` + `src/hub/catalog.ts`: new
  `isBlockingVerdict()` replaces two copies of `verdict === "block" || verdict === "escalate"`.
- `src/hub/mcp-server.ts`: an exhaustive `Record<ToolRejection["kind"], …>` map
  replaces the `rejectionStatus()` if-chain (adding a kind now fails to compile
  until mapped).
- `src/hub/config.ts`: hoist the wildcard `RegExp` that was constructed twice per
  allowlist entry.
- `src/routes/__root.tsx`: import `ReactNode` from `react` instead of reaching
  through `React.ReactNode`.
- `scripts/build-name-data.ts`: drop the redundant `?? false` on an optional
  `boolean` guard.

## Design

The codebase already used `?.`/`??` pervasively, so this is a curated pass rather
than a mechanical rewrite; anything that would only churn code was skipped. Two
repo-specific constraints shaped it. First, `noEqualsToNull` bans `== null` and
`noUselessUndefined` bans `return undefined;`, while `noImplicitReturns` still
requires a value on every path — so the documented `undefined`-return idiom is an
explicit `T | undefined` local, not a bare `return`. Second, `useExplicitLengthCheck`
requires `xs.length > 0`, and because `noUncheckedIndexedAccess` makes `xs?.length`
`number | undefined` (so `xs?.length > 0` does not typecheck), the accepted form is
`if (xs && xs.length > 0)`. ES2023 array methods (`toSorted`/`toReversed`/`with`)
were deliberately not adopted: Vite's default browser baseline predates them and
they cannot be downleveled, so `[...xs].sort(...)` stays until the build target is
raised. All of this is now written down in `AGENTS.md`.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean, 108 files.
- `bun run test`: 216 pass, 0 fail across 29 files.
- `bun run build`: succeeds (TanStack Start + Nitro).
- Cross-tree differential probe against `origin/master`: byte-identical output
  (detection over text×family matrices, all builtin masks, guard outcomes, JSON
  redaction).
