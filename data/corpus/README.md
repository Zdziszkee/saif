# Payload corpus (review queue input)

Drop third-party jailbreak / prompt-injection collections here for the feed
builder to normalize into DISABLED review candidates:

- `*.txt` — one payload per line; blank lines and `#` comments skipped.
- `*.json` — an array of strings, or of `{text, ref?}` objects.

```sh
bun run data:signatures -- --corpus data/corpus --corpus-kind jailbreak --check
```

Candidates arrive with content-hash ids (`corpus-<hash12>`), file:line
provenance, and `enabled: false`. Nothing in this directory ever enables
itself: promote a candidate by hand-picking a pattern into
`data/feeds/curated.json`. Keep volumes small and rewritten, never copied
verbatim — full upstream corpora are too noisy, too FP-prone, and wrongly
licensed for embedding.
