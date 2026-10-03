# PR: session/pr-record-note

## Summary

- Append a final-head observation note to the merged PR record
  (`docs/pr/architecture-doc.md`): with the semantic stage enabled and no
  `TYPESAFE_API_KEY`, the pipeline fails closed to `escalate` on benign traffic
  (documented behavior), and the live policy-reload binding was re-observed on
  the exact merged head (a rule's enforcement appeared and disappeared within
  2s of each policy edit, without a restart).

## Validation

- Docs-only change (one file, prose). The observation it records was taken
  against the merged head (`7151dde`) via live requests to
  `POST /api/guard`.
