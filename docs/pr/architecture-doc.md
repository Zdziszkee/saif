# PR: session/architecture-doc

## Summary

- Add `docs/architecture.md`: the full architecture reference for the AI
  Control Layer (diagram, the two tiers, verdict model, enforcement seams,
  policy engine, observability, storage, testing posture, module map,
  implementation status).
- Add a **Multi-tenancy and concurrency** section answering the deployment
  question directly: one hosted instance serves many users and agents at once.
  It defines the isolation axes (consumer-key subjects own policy, budgets, and
  audit), the shared-state rules (atomic budget reservation, single-writer
  SQLite, per-subject hub state, bounded in-process loops), and the scaling
  path (single instance first, vertical, then horizontal only after store and
  config distribution are externalized).
- Add `tests/concurrency-isolation.test.ts`: locks the multi-tenancy guarantee
  in as executable coverage. Interleaved concurrent guard requests across two
  consumer subjects keep verdicts and audit attribution correct, and an
  unknown consumer key is rejected without inheriting another subject's
  configuration.
- Mark planned-only module paths in the module map (`src/control/signatures/`,
  `src/control/text/`) as planned, since neither exists on disk yet.
- Add the shadcn dashboard component set (`chart` on recharts, `table`, `tabs`,
  `dropdown-menu`, `select`, `progress`, `separator`, `skeleton`, `tooltip`),
  the recharts dependency, and the rewritten theme tokens in `src/styles.css`.

## Design

The multi-tenancy section is written against code reality, not aspiration:
claims were cross-checked against `subjects.ts`, `guard-api.ts`, `guard.ts`,
`chat.ts`, `audit.ts`, `grants.ts`, `connections.ts`, `loop.ts`, `jev.ts`, and
`policy/loader.ts`, and corrected where they overreached (hub grants live in
process memory today; the `askModel` agentic loop runs in-process but is
bounded by request-count and compute-time budgets; connection credentials
travel only as a transport header and are never retained). Forward-looking
statements (human-user authentication, transactional budget reservation,
durable grants, policy version hash in audit entries) are flagged in the
implementation status table instead of being presented as shipped.

## Validation

- `bun test`: 164 pass, 0 fail, 8 skip (the `SEMANTIC_LIVE=1` opt-in tier),
  including the two new concurrency isolation tests.
- `bun run verify` (`tsc --noEmit && biome check .`): passes across all 92
  files, including the generated shadcn components under the scoped
  guardrail relaxations.
- Every claim in the multi-tenancy section traces to a code inspection or an
  implementation-status row; cited `src/` paths were checked against disk and
  the two that are spec-only are now labeled planned.
- The concurrency tests exercise the real `handleGuardRequest` seam with an
  interleaving pipeline double: 40 concurrent requests across two subjects plus
  an unknown-key rejection, asserting verdict, status, and audit attribution.
- **Live observation** (not inspection): the hosted app (`bun --bun run dev`)
  answered 24 concurrent `POST /api/guard` requests across 4 consumer keys in
  under 60 ms each with governed verdicts; PII payloads were redacted to
  `[EMAIL]` with verdict `redact` on every subject; an unknown key followed the
  configured default-subject behavior (governed under the default subject,
  never inheriting a known subject's policy).
- The live check surfaced that the hosted runtime built its consumer resolver
  with empty `knownKeys`, collapsing every key to the default subject. Fixed by
  wiring the policy document's `consumers` keys through the new pure
  `consumerPolicyFromDocument()` (`src/control/subjects.ts`) in
  `src/hub/runtime.ts`, pinned by `tests/consumer-policy.test.ts`.
- GitHub Actions on this PR: `unit-tests` pass, `verify` pass.
