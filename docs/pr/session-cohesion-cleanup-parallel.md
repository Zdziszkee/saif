## Summary

- Vendors MITRE ATLAS and OWASP LLM Top 10 as build inputs instead of
  hand-editing the feed: `data/feeds/atlas-snapshot.json` (STIX 2.1 bundle
  with `x_signature_ids` picks per attack-pattern) and
  `data/feeds/owasp-snapshot.json` (LLM01/02/06/07/10 categories with
  `signature_ids` picks), documented in `data/feeds/README.md`.
- Adds `scripts/build-signature-feed.ts` (`bun run data:signatures`,
  `--check` for CI): parses both snapshots, validates the hand-reviewed
  `data/feeds/curated.json` pick list against the feed schema, compiles every
  pattern, cross-checks snapshot coverage both ways, and writes a
  deterministically sorted `signatures.json`. A corrupt source warns but never
  empties the feed; zero valid rows is a hard error.
- Expands the feed from 14 to 39 entries with provenance (`source` +
  `references`): versioned developer-mode jailbreaks, role-play envelopes,
  delimiter escapes, translate/base64 directives, markdown beacons, encoded
  PowerShell, inline Python, certutil, chmod flips, evaluator/OS/process
  markers (`malicious-code`, previously unused kind), pip/npm/setup
  supply-chain hooks, and marshal/PHP/Java deserialization markers.
- Fixes carried-over verify failures so the branch is green: removes dead
  imports in `tests/signatures.test.ts`, refactors `scanEntry` to an options
  object (`useMaxParams`), and formats `semantic/control.ts` and
  `audit-export.test.ts`. Narrows `useNamingConvention` off for the importer
  and its test (STIX snake_case wire keys), recorded in `AGENTS.md`.
- Tests: `tests/signature-feed-import.test.ts` (STIX/OWASP parsing, revoked and
  non-attack skipping, invalid-row skipping, duplicate and bad-regex errors,
  outage containment, coverage warnings, fail-closed empty feed) and six new
  `tests/owasp-guard.test.ts` cases (developer-mode, delimiter escape,
  PowerShell, `os.system`, outbound beacon redaction, innocent-game negative).

## Design

Snapshots carry source metadata while `curated.json` carries the only
patterns: the full upstream corpora are thousands of noisy, FP-prone payloads
with unclear redistribution terms, so the builder picks via explicit
`x_signature_ids`/`signature_ids` allowlists and every pattern stays
hand-reviewed, ReDoS-safe, and paired with positive and benign-negative
fixtures. The obfuscated grandma prompt still passes the regex tiers by
design (JEV territory).

## Validation

- `bun run data:signatures -- --check`: 39 entries validate, no warnings.
- `bun run verify` (tsc + biome): clean.
- `bun test`: 212 pass, 0 fail, 9 skip (221 across 28 files).
