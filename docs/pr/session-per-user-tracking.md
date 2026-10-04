## Summary

- Adapts per-user tracking to master's user/group identity model (PR #22): identity arrives via `x-user-id` / `x-user-group-id`, audit events carry `groupId` + `userId`, and the `consumerKey` field is kept as a compat label set to the `userId` (`?? "(none)"`).
- Threads identity through every seam: guard API records `consumerKey: identity.userId` on decisions and malformed-request rejections, the MCP route threads `userId` as the per-user tracking key, and the chat seam passes `userId`/`groupId` on both inbound and outbound `guardInteraction()` calls so chat no longer records `"(none)"`.
- Rejection attribution is closed: every decision records `controlId: blockingControl ?? "pipeline"`, so clean allows attribute to the pipeline instead of `"none"`.
- Dashboard fits into master's shadcn base (#23): keeps the shadcn dashboard on top and layers a By-consumer card, `?consumer=` scoping with isolation view, and a Consumer escalation column below it; export accepts `consumer`/`consumerKey` + `since`/`until`.
- Adds `dashboard-consumers.ts` / `dashboard-meta.ts` shaping helpers (`consumerKeyOf` prefers `consumerKey`, falls back to `groupId`, then `"(none)"`; `filterByConsumerKey`; decisions-only summaries; escalations queue) plus test files covering audit, guard, governance, export, dashboard, and identity invariants.

## Design

Per-user tracking reuses the existing `consumerKey` audit field as a compat label for the new `userId` rather than renaming the schema, keeping CSV/JSONL formats append-only and backward-compatible. Dashboard scoping treats the URL (`?consumer=`) as the source of truth, applying `filterByConsumerKey` at the loader so every card and the escalation queue respect one selection. Redact stays fail-closed: `block`/`escalate` never forward content and `redact` forwards only the typed-placeholder replacement.

## Validation

- `bun run verify` (`tsc --noEmit && biome check .`): clean — Checked 168 files, no fixes applied.
- `bun test`: 638 pass, 9 skip, 0 fail — 647 tests (1851 `expect()` calls) across 53 files.
- `bun run build`: success (exit 0, built in ~440ms; nitro output generated; only expected `MODULE_LEVEL_DIRECTIVE` "use client" notes from Radix packages).
- Figures above are post-rebase, measured in this session.
- Rebase adaptations included in these figures: user/group identity threading (guard API, MCP route, chat seam threads `userId` as the tracking key), `consumerKey`-as-`userId` compat recording, rejection attribution (`blockingControl ?? "pipeline"`), and fitting the By-consumer card plus `?consumer=` scoping (route threads `?consumer=` into Dashboard `initialConsumer`) plus Consumer escalation column into the shadcn dashboard base.
- Known remaining gaps: budget/cost and latency instrumentation do not exist yet, and the `"none"` (audit summary) vs `"(none)"` (compat label) keyless marker is still not unified.
