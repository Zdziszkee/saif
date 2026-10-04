# Signature feed sources

`signatures.json` (repo root) is generated — not hand-edited — from the two
vendored snapshots in this directory plus the hand-reviewed pick list in
`curated.json`. Regenerate with:

```sh
bun run data:signatures
bun run data:signatures -- --check
```

## Upstream sources

- MITRE ATLAS (`mitre-atlas/atlas-data`, STIX 2.1 bundles):
  https://github.com/mitre-atlas/atlas-data — technique/tactic knowledge base,
  mirrored in miniature as `atlas-snapshot.json`. Refresh by downloading the
  upstream STIX bundle and re-picking `x_signature_ids`.
- OWASP LLM Top 10 (2025):
  https://owasp.org/www-project-top-10-for-large-language-model-applications/
  — designations and mitigations, mirrored as `owasp-snapshot.json` categories.
  Payload inspiration (rewritten, never copied verbatim) also draws on
  JailbreakBench (https://github.com/JailbreakBench/jailbreakbench) and
  tldrsec/prompt-injection-defenses
  (https://github.com/tldrsec/prompt-injection-defenses).

## Picking, not vendoring verbatim

The full upstream corpora are thousands of payloads — too noisy, too
FP-prone, and wrongly licensed for verbatim embedding. The builder
(`scripts/build-signature-feed.ts`) validates both snapshots parse (a corrupt
or unreachable source warns but never empties the feed — outage containment),
cross-checks every `curated.json` id is claimed by at least one snapshot
object (`x_signature_ids` / `signature_ids`), compiles every pattern, and
writes the sorted feed. Unclaimed curated ids and unknown snapshot claims are
reported as warnings; invalid curated rows are skipped without killing the
feed; zero valid rows is a hard error.
