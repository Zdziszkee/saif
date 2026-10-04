## Summary

- Replaces the old custom styling with the shadcn default semantic theme
  tokens in `src/styles.css`: the light (`:root`) and dark (`.dark`) oklch
  token sets with `@theme inline` mappings, including the `chart-1..5` tokens
  the shadcn chart components consume.
- Adds switchable color palettes (neutral, blue, green, amber, rose, violet)
  as `[data-palette]` token overrides layered over the light/dark base blocks,
  per the shadcn theming docs.
- Adds the theme system: light/dark/system mode plus a palette switcher
  (`src/lib/theme.ts`, `src/components/theme-provider.tsx`,
  `src/components/theme-switcher.tsx`), persisted in localStorage and applied
  pre-hydration by a blocking `public/theme-init.js` script wired in
  `src/routes/__root.tsx`, so the correct tokens render with no flash of the
  wrong theme.
- Builds the dashboard required by the security-observability spec at `/`
  (with `/dashboard` kept working): controls and strictness profiles in
  force, verdict counts for allow/redact/block/escalate, threats by control
  and category, budget usage against configured limits over time, latency
  percentiles (p50/p95/p99), the escalation queue awaiting review, policy and
  signature-feed versions in force, and live refresh polling on a 15-second
  interval.
- Every metric section reads through a consumer-key scope selector (pooled
  aggregate or one key in isolation), covering the spec's per-consumer-key
  breakdown requirement across sections rather than per chart.
- Adds the `src/dashboard/` data layer: a typed `DashboardData` model shaped
  like what the metrics/audit queries (tasks 10.2-10.3) will return, a real
  policy projection (`PolicyLoader` over `policy.json` in a TanStack Start
  `createServerFn`), and seeded fixture metrics for the sections whose
  queries are still pending. `/dashboard` keeps reading the audit sink
  directly, so verdict/redaction/escalation counts are live wherever the sink
  has events.

## Design

Theme choice is stored as two orthogonal fields (mode, palette) and applied by
toggling the `dark`/`light` class and a `data-palette` attribute on `<html>`.
Palettes override only the primary and chart tokens, so every other token
keeps its canonical shadcn value, and the `.dark[data-palette=...]` blocks win
over both single-source blocks by specificity. `public/theme-init.js`
duplicates the small parse/apply logic from `src/lib/theme.ts` as
dependency-free plain JS so it can run blocking in `<head>` before hydration;
the provider starts at the defaults to match the SSR markup and syncs to the
stored choice after mount. On the dashboard, fixture metrics are not a
parallel data path: `src/dashboard/types.ts` mirrors the result shapes the
tasks 10.2-10.3 queries will produce, so swapping fixtures for real queries
confines the change to `src/dashboard/server.ts`. Sections render from one
scope-selected `ConsumerMetrics` instead of embedding per-key breakdowns, so
the aggregate and isolated views cannot drift apart.

## Validation

- `bun test`: 234 pass, 0 fail (9 live-model skips, opt-in via SEMANTIC_LIVE=1),
  677 expect() calls across 31 files.
- `bun run verify` (`tsc --noEmit && biome check .`): tsc clean; biome reports
  8 errors, all in `src/` files still being finished by concurrent agents on
  this shared worktree, none in this PR's files:
  `src/components/dashboard/dashboard.tsx` (organizeImports,
  useSortedAttributes, 2x noMagicNumbers, format),
  `src/components/dashboard/metric-sections.tsx` (format),
  `src/components/dashboard/policy-sections.tsx` (format), and
  `src/routes/index.tsx` (useSortedKeys). A teammate's src land is pending;
  this doc's own files are markdown and unaffected.
- Dashboard rendering against the fixture data layer and the live
  `policy.json` projection was checked on `bun run dev` (see the 11.1 note in
  `openspec/changes/ai-control-layer/tasks.md`).
