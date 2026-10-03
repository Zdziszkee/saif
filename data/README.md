# Name data

`names.json` is generated — not hand-maintained — from the open
[popular-names-by-country-dataset](https://github.com/sigpwned/popular-names-by-country-dataset)
(forenames and surnames across 106 countries, including Polish, English, Spanish, German,
and many more). The dataset is released under **CC0 1.0 (public domain)**.

Regenerate with:

```sh
bun run data:names
```

The script downloads the upstream CSVs and extracts the unique romanized and localized
names into `names.json`. Provenance: sigpwned/popular-names-by-country-dataset, CC0-1.0.
