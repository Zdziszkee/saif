## Summary

- Deterministic tier as a pipeline `Control` (`src/control/deterministic/`): the pattern
  catalog (provider secrets, PII, generic credentials), checksum validators (Luhn, IBAN
  mod-97, PESEL, ABA, UUID version/variant), context-aware confidence, and weak-pattern
  gating, plus the open CC0 name dataset behind a hash index (`data/names.json`) and the
  local Compromise NER for people and addresses.
- `createDeterministicControl(config)` builds the control from the policy's `detection`
  section: builtin family toggles, per-kind default actions (unvalidated hits take the
  `suspect` entry), and custom regex rules compiled once with rule id as detector id,
  per-rule direction scope, and mapped action. Verdict is the worst mapped action;
  `flag` forwards annotated for review; redact-mapped spans carry typed placeholders
  (`[EMAIL]`, `[PERSON_1]`, `[CARD_LAST4:4242]`, `[CUSTOM:<ID>]`, …).
- Hub wiring (`src/hub/runtime.ts`): the shared pipeline now runs the deterministic control
  built from `policy.json` at startup; when no valid policy loads, a `policy-unavailable`
  control blocks everything instead of running unprotected.
- Test fixtures for secret-shaped values live in gitignored `.env`
  (`bun run fixtures:env` regenerates; `tests/secret-fixtures.ts` loads them), so
  repository secret scanners never see provider-shaped tokens in git.
- Docs: `docs/controls.md` (detection kinds, placeholders, name data, Presidio pattern
  provenance under MIT © Presidio Contributors) and this summary. Implements tasks 4.1–4.2
  of the `ai-control-layer` OpenSpec change.

## Design

Controls decide only their own evidence: the deterministic control maps detections to the
policy's per-kind actions and returns one verdict with redaction spans, while the pipeline
owns cheap-first ordering, fail-closed errors, and verdict merging. Policy-defined custom
rules run in the same detection pass as builtins, so judges add coverage with a JSON edit
instead of code. Deliberately out of scope: the semantic tier, signature feed, vault
operator, and policy hot-reload propagation to the control (the loader watches, but the
control holds its construction-time config) — each lands as its own change.

## Validation

- `bun test tests/deterministic*.test.ts tests/build-name-data.test.ts`: detector units
  (secrets, PII, names, addresses, IPs, wallets, PESEL/passport/license/bank/UUID/MAC,
  negatives, suspects, context), control verdict mapping, custom-rule direction scoping,
  placeholder spans, shipped-policy compatibility, and pipeline redaction end to end via
  `guardInteraction`.
- `bun test` (full suite) green with `TYPESAFE_API_KEY` unset; `bun run verify`
  (tsc + biome) clean; `bun install --frozen-lockfile` clean.
