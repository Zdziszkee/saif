## Summary

- Policy schema (`src/control/policy/schema.ts`): one zod-validated document
  defines every control. Custom regex detection rules (id, kind, pattern,
  direction scope, mapped action), typed semantic checks (`boolean`, `choice`,
  `score` with wording, criteria, activation, per-direction threshold chains),
  strictness profiles with per-control per-direction thresholds, model
  allowlist, budget rules, signature enforcement, and failure verdicts.
- Policy loader (`src/control/policy/loader.ts`): immutable deep-frozen
  snapshots with atomic swap and sha256 content-hash version stamps; file-watch
  hot reload; invalid or unreadable loads keep the last valid policy, and no
  valid policy means no governed traffic.
- Samples and reference: `policy.json`, `policy.permissive.json`,
  `policy.strict.json` (three strictness levels), and `docs/policy.md`
  documenting every field and the validation rules.

## Design

The zod schema is the single definition shared by the runtime loader and the
tests. Validation is strict (unknown keys rejected) and whole-document:
patterns must compile and be bounded in complexity, rule and check ids are
unique, and each semantic check carries an explicit threshold-to-action chain
(`block`, `redact`, `flag`, else `allow`). Snapshots pin one validated load and
carry its content hash for audit stamping. Implements tasks 2.1-2.3 of the
`ai-control-layer` OpenSpec change.

## Validation

- `bun test tests/policy-*.test.ts`: 30/30 pass. Schema rejections (including
  uncompilable and unbounded regexes), loader hot reload, rejection rollback,
  a real `fs.watch` round trip, and sample loading.
- `tsc --noEmit` and `biome check` clean for all touched files.
