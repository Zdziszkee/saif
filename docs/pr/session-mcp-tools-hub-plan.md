# session/mcp-tools-hub-plan

## Summary

- Revise the `ai-control-layer` change so the MCP surface is a tools-only hub: the `askModel` MCP tool is dropped from the plan, and AI prompt/answer traffic is handled by the TanStack AI gateway at the chat seam.
- Add design decision D10 (two-plane split: prompt plane on the TanStack AI gateway, tool plane on the MCP hub) and an interaction-gateway requirement "Tools-only MCP hub" with two scenarios (no model-reaching entry in the catalog; connected MCP tool calls pass tool-call governance).
- Add tasks 9.3 and 9.4: re-scope `src/hub` to a tools-only catalog and wire the chat seam's `ask` to the TanStack AI gateway with the bounded tool loop on the gateway side.

## Design

Model access and MCP tool access no longer share a plane. The prompt plane is the TanStack AI `chat()` stack over the configured OpenAI-compatible adapter, guarded inbound (prompt) and outbound (answer) by the shared control pipeline. The tool plane is the MCP server (`createMCPServer` at `src/routes/mcp.ts`) serving the governed tool catalog — hub-hosted tools plus tools from connected external MCP servers — where every call executes under tool-call governance (grants, verdicts, audit, budgets). The bounded tool loop (request-count and compute-time caps) moves to the gateway side; each of its tool calls still routes through hub governance. An `askModel`-style MCP tool is rejected because it launders inference through tool semantics, hides prompt traffic from the prompt-plane controls, and couples the tool catalog to model routing. Planning artifacts only; the implementation delta is tracked as tasks 9.3 and 9.4.

## Validation

- `npx --no-install openspec validate ai-control-layer` → `Change 'ai-control-layer' is valid`.
- `bun test` → 166 pass, 8 skip, 0 fail (174 tests across 22 files).
- Docs-only change. `bun run verify` currently fails on uncommitted shadcn components in the shared worktree (`src/components/ui/dropdown-menu.tsx`), which this PR does not touch or include.
