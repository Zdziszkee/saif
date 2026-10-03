# Deterministic controls

The deterministic tier (`src/control/deterministic/`) implements the `Control` seam from
`src/control/types.ts`: pattern detectors for secrets and PII, a name index plus local NER
for people and addresses, and policy-authored custom regex rules — all mapped to verdicts
by the policy's detection config. It runs cheap-first in the shared pipeline; a `block`
here is final.

## Detection kinds

Every detection carries a `kind`, a fine-grained `type`, and the exact span
(`start`, `end`, `value`) of the match.

| Kind      | Type          | What it detects                                          |
| --------- | ------------- | -------------------------------------------------------- |
| `secret`  | `api-key`     | OpenAI/Anthropic `sk-…`, Stripe `sk_live_…`, Google `AIza…`, AWS `AKIA…`/`ASIA…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox…` |
| `secret`  | `token`       | JWTs (`eyJ…`), `Bearer <token>` headers                   |
| `secret`  | `private-key` | `-----BEGIN … PRIVATE KEY-----` blocks                    |
| `pii`     | `email`       | Email addresses                                          |
| `pii`     | `phone`       | Grouped phone numbers (`+48 123 456 789`, `(555) 123-4567`) |
| `pii`     | `card`        | 13–19 digit payment card numbers (Luhn-checked)          |
| `pii`     | `gov-id`      | Government-ID-like numbers (SSN format `123-45-6789`)     |
| `pii`     | `person`      | Person names — open CC0 name dataset (first + last), Compromise NER, and title/introduction context rules |
| `pii`     | `address`     | Street addresses via Compromise NER (`42 Green Street`)    |
| `pii`     | `ip-address`  | IPv4/IPv6 addresses (`203.0.113.42`)                      |
| `pii`     | `crypto-wallet` | BTC/ETH wallet addresses (`0x5290…EE7`)                 |
| `pii`     | `pesel`       | Polish PESEL numbers — structure + checksum (`44051401359`) |
| `pii`     | `passport`    | US passport numbers (`123456789`, `X12345678`) — weak, needs context |
| `pii`     | `driver-license` | US driver-license numbers (`D1234567`) — weak, needs context |
| `pii`     | `bank-account` | ABA routing numbers — checksum (`011401533`); bare digit runs — weak, need context |
| `pii`     | `uuid`        | UUIDs with version/variant check (`123e4567-e89b-12d3-…`) |
| `pii`     | `mac-address` | MAC addresses, colon/hyphen and Cisco-dot notation      |

Failed-Luhn card-shaped groups remain low-confidence `suspect` detections and follow the
policy's `suspect` action. ISO dates and unseparated digit runs are not phone numbers, and
`user@localhost` is not an email.

## Presidio-style anonymization techniques

The layer ports the techniques used by Microsoft Presidio and commercial DLP/anonymization
products (Cloud DLP, Skyflow) in pure TypeScript — local, synchronous, no API calls:

- **Context-aware scoring** (Presidio `context_aware` enhancers): every recognizer declares
  supporting keywords (`card`, `cvv`, `iban`, `wallet`, `ip`, `password`, … in English and
  Polish). When one appears within ±80 characters of a match, the detection's confidence is
  boosted and the matched words are recorded on `detection.context` — so
  `4111111111111112 appeared` stays a low-confidence suspect while `Card 4111111111111112
  was declined` scores higher.
- **Extended recognizers**: IP addresses (IPv4/IPv6), crypto wallets (BTC/ETH), and
  credentials embedded in URLs (`https://user:pass@host`) — the last one is classified as a
  `secret`.

## Names and addresses (local, no third-party calls)

Person and address detection is built from downloadable open data and a local NLP library —
nothing is sent to any API at runtime:

- **Open name dataset**: `data/names.json` is generated (never hand-maintained) from the CC0
  [popular-names-by-country-dataset](https://github.com/sigpwned/popular-names-by-country-dataset)
  — 1657 forenames and 2291 surnames across 106 countries (Polish, English, Spanish, German,
  and more). Refresh with `bun run data:names`; provenance in `data/README.md`.
- **Search-optimized index** (`src/control/name-index.ts`): names are normalized (case-folded,
  diacritics stripped) into hash sets for O(1) membership, plus bounded longest-match over
  consecutive capitalized tokens so multi-token names resolve in a single pass. Polish feminine
  surname variants (`-ski` → `-ska`, `-cki` → `-cka`) are derived
  from the dataset at load time, so `Anna Wiśniewska` matches even though census-style lists
  carry the masculine form.
- **Compromise NER** (`src/control/ner.ts`): the local, rule-based NLP library (MIT) provides
  spaCy-style entity extraction — `.people()` and `.addresses()` with exact character offsets,
  typically single-digit milliseconds per prompt. This covers names outside the dataset
  (`Maria Kowalska`, `Mr. John Smith`).
- **Context rules**: titles (`Mr.`, `Dr.`, `Prof.`, …) and introduction phrases in English and
  Polish (`my name is`, `Nazywam się`, `mam na imię`, …) catch unknown names
  (`Engelbert Honecker`).

Benign capitalized words are deliberately not flagged: `Mark the invoice as paid`, `May I help
you`, `The weather in Warsaw tomorrow` all pass through untouched (bare city names are not PII;
only street addresses are).

## Redaction placeholders

When policy maps a detection to `redact`, each matched span is replaced by its plan-format
typed placeholder (for example, `[EMAIL]` or `[PERSON_1]`) and all surrounding content is
preserved unchanged.

Examples (input → output):

- `My email is alice@example.com today.` → detection `pii.email` on `alice@example.com`
- `Contact alice@example.com or call +48 123 456 789.` →
  `Contact [EMAIL] or call [PHONE].`
- `Send the invoice to alice@example.com please` (prompt, `redact`) →
  `Send the invoice to [EMAIL] please`
- `The configured key is sk-proj-…` (output, `redact`) → `The configured key is [API_KEY].`

Detector fixture tokens (fake `sk-…`, `AKIA…`, `ghp_…`, `xoxb-…` values) live in `.env`,
which is generated by `bun run fixtures:env` and never committed — repository secret
scanners would otherwise flag them, and they would pollute the tree. Tests load them
through `tests/secret-fixtures.ts`, which regenerates `.env` automatically when missing.

Placeholders in use (plan-format): `[EMAIL]`, `[PHONE]`, `[CARD_LAST4:4242]` (card digits are
masked down to the last four), `[IBAN]`, `[SSN]`, `[PESEL]`, `[PASSPORT]`, `[DRIVER_LICENSE]`,
`[BANK_ACCOUNT]`, `[UUID]`, `[MAC_ADDRESS]`, `[API_KEY]`, `[TOKEN]`, `[PRIVATE_KEY]`,
`[GENERIC_SECRET]`, `[ADDRESS]`, and `[PERSON_1]`, `[PERSON_2]`, … — person names get
consistent pseudonyms so the same person keeps the same placeholder within one text.

## Pattern provenance: Presidio recognizer catalog

The recognizer patterns, context-word lists, and checksum validators for `pesel`, `passport`,
`driver-license`, `bank-account` (`ABA`), `uuid`, and `mac-address` — plus merged context
words for cards, phones, IPs, and wallets — are ported from Microsoft Presidio
([data-privacy-stack/presidio](https://github.com/data-privacy-stack/presidio)), MIT-licensed
© Presidio Contributors. Cloned for reference only (`/tmp`, not vendored); only the pattern
data was ported into `src/control/detectors.ts`. The Python runtime, spaCy NER, and service
layer were deliberately not ported: this app's engine (pattern catalog + validators + context
scoring + typed anonymizer) already mirrors Presidio's `PatternRecognizer` architecture, and
Compromise covers the NER slot locally.

Presidio semantics we follow: weak patterns (digit-only passport/bank/driver-license shapes)
carry a low base score and are **dropped unless supporting context words appear nearby**
(`requiresContext`); checksum-validated hits are emitted regardless. Unvalidated hits map to
the policy's `suspect` default action instead of the kind default.

Examples with names and addresses:

- `Hi, my name is Jan Kowalski and my email is jan.kowalski@example.com` →
  `Hi, my name is [PERSON_1] and my email is [EMAIL]`
- `Please send the package to Anna Nowak at 42 Green Street, Warsaw` →
  `Please send the package to [PERSON_1] at [ADDRESS], Warsaw`
- `Jan Kowalski met Jan Kowalski again.` → `[PERSON_1] met [PERSON_1] again.`

## Policy mapping

The control is constructed from the policy's `detection` section
(`createDeterministicControl(config)`), so judges tune behavior by editing `policy.json`,
not code:

- `builtins` toggles the `providerSecrets`, `genericCredentials`, and `pii` pattern
  families (`encodingRescan`/`entropyScan` are reserved for a later control).
- `defaultActions` maps evidence kinds to `allow | block | flag | redact`: validated secrets
  and PII use the `secret`/`pii` entries, unvalidated hits use `suspect`, anything unmapped
  becomes `flag` (forwarded but annotated for review).
- `rules` adds policy-authored custom regex detections: the rule id becomes the detector id,
  `directions` scopes `inbound`/`outbound` applicability, and matches redact to
  `[CUSTOM:<RULE_ID>]`.

The shipped `policy.json` blocks secrets, redacts PII, and flags suspects — the control
returns the worst mapped action as its verdict and carries the evidence as typed-placeholder
redaction spans for the pipeline to enforce.
