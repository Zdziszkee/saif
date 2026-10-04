## Summary

- Added regression test `tests/route-tree.test.ts` for the `V1ChatCompletionsRoute` duplicate-identifier crash (`v1.chat-completions.ts` vs `v1.chat.completions.ts` both normalized to one binding and `bun run dev` died with a PARSE_ERROR). It asserts exactly one `v1.chat*` route file exists, the generated tree declares the import and const once, the survivor registers `/v1/chat/completions`, and no route registers `/v1/chat-completions`.
- No production code changed: `origin/master` (#36) already resolved the collision by renaming the legacy seam to `src/routes/api.chat-completions.ts` (`POST /api/chat-completions`); this branch was rebased onto it and now only adds the regression net.

## Design

Upstream kept both seams (canonical `/v1/chat/completions` plus the legacy gateway under `/api/*`, reconciling later), so the fix here is purely additive: a file-level test that fails on the colliding tree and passes on the renamed one, independent of which gateway implementation wins the follow-up.

## Validation

- `bun test tests/route-tree.test.ts` — 4 pass, 0 fail (verified failing against pre-fix HEAD blobs: 2 import decls, 2 const decls, hyphenated registration present).
- `bun run verify` (`tsc --noEmit && biome check .`) — clean, 237 files checked.
- `bun test` (full) — 1140 pass, 9 skip, 0 fail across 81 files.
