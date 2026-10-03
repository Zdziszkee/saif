# Policy reference

The policy file (`policy.json`, path overridable with `POLICY_PATH`) is the single
source of truth for every control in the AI control layer. It is validated with a
zod schema at load time and hot-reloaded on change: edit the file while the server
runs and the next interaction is evaluated with the new rules. An invalid edit is
rejected, the last valid policy stays active, and the validation errors are
reported (on the dashboard and in the metrics API).

Sample variants shipped at the repo root:

| File | Demonstrates |
| --- | --- |
| `policy.json` | Baseline `standard` profile with all controls on |
| `policy.permissive.json` | Lenient thresholds, PII allowed, failures escalate |
| `policy.strict.json` | Near-zero thresholds, PII blocks, everything blocks |

Swap in a variant by copying it over `policy.json` or pointing `POLICY_PATH` at it.

## Top level

| Field | Meaning |
| --- | --- |
| `version` | Your policy document's version number (informational; the audit log stamps the content hash) |
| `enabled` | Master switch. `false` runs the pipeline observe-only: everything is audited, nothing is enforced |
| `defaultProfile` | Strictness profile used for consumers without an explicit entry: `permissive`, `standard`, `strict` |
| `failureVerdict` | Verdict applied when the pipeline itself fails (`allow`, `redact`, `block`, `escalate`). Fail-closed default: `block` |
| `consumers` | Map of consumer key (sent in the `x-consumer-key` header) to `{ profile, budgetGroup }` |
| `allowlist.models` | Permitted model ids. `["*"]` allows any; otherwise the request's model must match exactly |

## `controls`

### `controls.deterministic`

Regex/dictionary checks that run first, without any model.

| Field | Meaning |
| --- | --- |
| `enabled` | Run the deterministic tier |
| `actions.secret` | Verdict when an API key/token-like secret is detected (span reported) |
| `actions.pii` | Verdict when PII (email, phone, card, government-id-like) is detected |

`redact` replaces the matched span with a typed placeholder (e.g. `[EMAIL]`)
before the content continues down the pipeline. `block` is final: the semantic
tier is not invoked.

### `controls.signatures`

Matching against the historical-exploit signature feed (`signatures.json`,
path overridable with `SIGNATURES_PATH`, hot-reloaded like the policy).

| Field | Meaning |
| --- | --- |
| `enabled` | Run signature matching |
| `actions.default` | Verdict for a matched signature with no severity mapping |
| `actions.bySeverity.<low\|medium\|high\|critical>` | Verdict per signature severity |

### `controls.semantic`

The AI-based tier. Questions are evaluated in a single Jev `decide()` call
(parallel, 70-500 ms); answers are probabilities with calibrated confidence.

| Field | Meaning |
| --- | --- |
| `enabled` | Run the semantic tier |
| `classifier` | `jev` (hosted TypeSafe, needs `TYPESAFE_API_KEY`), `ollama` (local fallback), `mock` (tests) |
| `timeoutMs` | Hard bound on the classifier call; on timeout `failureVerdict` applies |
| `failureVerdict` | Verdict when the classifier errors or times out (default `block`) |
| `uncertaintyVerdict` | Verdict when an answer is below its confidence/probability floors (default `escalate`) |

#### `controls.semantic.questions`

One entry per boolean threat question (`promptInjection`, `jailbreak`,
`dataExfiltration`, `maliciousCode`):

| Field | Meaning |
| --- | --- |
| `enabled` | Evaluate this question at all |
| `blockThreshold` | P(true) at or above this contributes `block` |
| `escalateThreshold` | P(true) at or above this (below `blockThreshold`) contributes `escalate` |

#### `controls.semantic.threatCategory`

`choice` question classifying what the interaction is: `prompt_injection`,
`jailbreak`, `data_exfiltration`, `malicious_code`, `policy_violation`, `benign`.

| Field | Meaning |
| --- | --- |
| `enabled` | Evaluate the category question |
| `blockCategories` | Selected categories that contribute `block` |
| `confidenceFloor` | Below this confidence the answer counts as uncertain |
| `probabilityFloor` | Below this selected-option probability the answer counts as uncertain |

#### `controls.semantic.severity`

`score` question grading 0-4 (`0` no concern ... `4` clear and damaging attack).

| Field | Meaning |
| --- | --- |
| `enabled` | Evaluate the severity question |
| `blockAt` | Score at or above this contributes `block` |
| `escalateAt` | Score at or above this (below `blockAt`) contributes `escalate` |

#### `controls.semantic.questionOverrides`

Optional map of question id to `{ "instructions": "..." }` to reword what the
classifier is asked, without touching code.

### `controls.budgets`

| Field | Meaning |
| --- | --- |
| `enabled` | Enforce budgets |
| `rules[]` | One or more budget rules |

Each rule:

| Field | Meaning |
| --- | --- |
| `id` | Rule identifier (appears in audit and metrics) |
| `budgetGroup` | Metered group (consumers are assigned via `consumers.<key>.budgetGroup`) |
| `window` | `hour`, `day`, or `month` |
| `limitTokens`, `limitUsd`, `limitRequests`, `limitComputeMs` | Caps per window (`0` disables that dimension) |
| `overBudgetVerdict` | Verdict when a request would exceed a cap (default `block`) |

## `profiles`

Each of `permissive`, `standard`, `strict` holds optional partial overrides of
`controls` (and `failureVerdict`), deep-merged over the base. The same semantic
answers can therefore yield different verdicts per profile; `standard` is
usually `{}`.

## Verdicts

| Verdict | Effect |
| --- | --- |
| `allow` | Forward unchanged |
| `redact` | Replace flagged spans with typed placeholders, forward the rest |
| `block` | Reject; nothing reaches the model or tool |
| `escalate` | Record for review (dashboard), do not forward while unresolved |
