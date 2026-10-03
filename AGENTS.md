<!-- intent-skills:start -->
## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:
- Run `bunx --no-install --package @tanstack/intent intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx --no-install --package @tanstack/intent intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Tooling guardrails

TypeScript and Biome are configured for maximum strictness. Keep it that way.

- `npm run verify` (or `tsc --noEmit && biome check .`) must pass before committing;
  `npm run build` is gated on `tsc --noEmit`.
- `tsconfig.json`: all strict + lint-grade flags on (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
  `erasableSyntaxOnly`, ...). `skipLibCheck: true` is the single exception:
  dependency d.ts files reference uninstalled optional peers (pg, bun, @babel/*).
- `biome.json`: every rule group at `error`, curated nursery rules, sorted keys and
  imports enforced. Rules that fight this toolchain are intentionally off:
  `noUnresolvedImports` (biome resolver false positives on package subpath exports;
  tsc covers this), `noReactSpecificProps` (this is a React project),
  `noJsxLiterals`, `useExportsLast` (fight TanStack route conventions).
- Scoped overrides relax rules only where the stack demands it: node/process usage in
  server files (mcp, db, drizzle.config), `noDefaultExport` in config files,
  `noHeadElement` in `src/routes/__root.tsx`, and CONSTANT_CASE object keys for env
  vars and HTTP method keys.
- If a guardrail change is needed, relax the narrowest scope (override or rule) and
  record the reason here.

Installed skill catalog: see [skills.md](./skills.md).
