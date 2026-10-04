# session/mcp-hub-tools-only

## Summary

- Re-scope the MCP hub to a tools-only catalog (task 9.3, design D10): the `askModel` registration and the hub's model-connection assembly are removed, so the served catalog contains hub-hosted tools and connected external MCP tools only.
- Rework the hub test suite onto the tools-only surface: catalog enumeration asserts no model-reaching tool, surface calls assert tool-call governance, and connected-tool outcomes (denied and allowed) are asserted in the audit log. The obsolete askModel prompt-governance tests are removed (prompt governance lives at the chat seam, covered by `tests/chat-seam.test.ts`).
- Scope note: `src/hub/model.ts` and `src/hub/loop.ts` are left in place, unmodified and no longer wired into the hub; their move to the prompt-plane gateway (task 9.4) belongs to the gateway work stream and is not part of this PR.

## Design

The hub becomes the pure tool plane. `createHub` no longer takes a model connection, `runtime.ts` no longer assembles one from env, and the tool catalog admits only builtin tools and connected external MCP tools. Tool-call governance is unchanged: every call, on the MCP surface or direct via `invokeTool`, runs through the governor (grants, pipeline inspection, audit). The enforcement-mode and loop-budget tests now drive `runGovernedLoop` directly with hub-governed tools instead of going through the removed `askModel` tool, which keeps the loop contract pinned until the gateway work stream takes it over.

## Validation

- `bun run verify` (tsc + biome) passes in the session worktree.
- `bun test` → 161 pass, 8 skip, 0 fail (169 tests across 21 files).
- `grep -rn "askModel|AskModel" src tests` → no matches.
- Task 9.3's verify hooks are covered: tools-only catalog (`tests/hub-surface.test.ts`, `tests/smoke.test.ts`), connected-tool calls through governance with outcomes in the audit log (`tests/hub-connections.test.ts`, `tests/hub-tools.test.ts`).
