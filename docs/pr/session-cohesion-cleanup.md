## Summary

- Completes the guard pipeline to the architecture shape: entry points (chat, MCP
  tools, guard API) flow through validate (shape + model allowlist), signature
  feed, deterministic, and semantic-last stages, with the worst verdict winning
  and failures closing to the policy failure verdict.
- Adds the missing stages: `src/control/signatures/` (feed schema, hot-reload
  loader with last-good fallback, policy-mapped matcher with provenance) seeded
  by `signatures.json`; `src/control/semantic/control.ts` (policy-check ladder
  mapping, uncertain-to-flag, failures propagate); `src/control/allowlist.ts`
  (model allowlist enforcement, wired first).
- Wires all stages in `src/hub/runtime.ts` from the default profile's
  `enabledControls`, passing the policy failure verdict to the pipeline.
- Adds audit export (`GET /api/audit/export?format=jsonl|csv` with verdict,
  control, subject filters), a `/dashboard` route (verdict/control counts,
  recent decisions, auto-refresh), and `docs/architecture.md` with the pipeline
  diagram.
- Cleans up: TanStack starter landing replaced with a hub page; dead
  `policyChecksToSemanticChecks` adapter removed after the `policy.jev.json`
  split; pipeline fail-closed keeps an earlier `block` instead of downgrading
  it to the failure verdict.
- Tests: signature feed (load/skip-invalid/dedup/match/override/hot-reload),
  semantic ladders, allowlist, export filters, pipeline failure precedence.

## Design

Stages stay behind the existing `Control` seam and read only their own policy
section, so judges tune behavior through `policy.json`/`signatures.json`
without code changes. The semantic tier keeps the policy split from PR #10:
questions come from `policy.jev.json` (`SEMANTIC_DEFAULTS`), strictness stays
in `policy.json` profiles. Per-check ladders map answers to verdicts; the
fuller profile-driven `applyPolicy` engine remains open work (tasks 8.x).

## Validation

- `bun test`: 201 pass, 0 fail (8 pre-existing integration skips).
- `npm run verify` (tsc + biome): clean.
- Live `bun run dev` smoke: injection blocked with signature provenance,
  `/dashboard` 200, audit export streams JSONL.
