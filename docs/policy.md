# Policy reference

The policy document is the single source of truth for every control in the AI
control layer. It is a JSON document validated against the zod schema in
`src/control/policy/schema.ts` (`parsePolicy`). Validation is strict: unknown
keys are rejected, and a document that fails any check is refused in full while
the last valid policy stays active (fail closed when none exists).

Sample documents: [`policy.json`](../policy.json) (standard),
[`policy.permissive.json`](../policy.permissive.json), and
[`policy.strict.json`](../policy.strict.json). They demonstrate three
strictness levels and different budget rules; the tests in
`tests/policy-samples.test.ts` validate every sample against the schema.

## Actions and verdicts

- **Verdicts** (`allow`, `block`, `escalate`, `redact`) are what the gateway
  applies to an interaction. `escalate` holds the interaction for review.
- **Actions** (`allow`, `block`, `flag`, `redact`) are what detections and
  semantic checks map their evidence to. `allow`, `block`, and `redact` map
  directly to the same-named verdicts. `flag` forwards the content and records
  the match as flagged for review: it maps to the `allow` verdict with a
  flagged audit annotation.

## Top-level fields

| Field | Type | Description |
| --- | --- | --- |
| `version` | string (min 1) | Document label. The loader additionally stamps every load with a `sha256` content-hash version for audit records. |
| `defaults.failureVerdict` | verdict | Verdict applied when the pipeline cannot decide (classifier timeout, internal error). Use `escalate` or `block` for fail-closed behavior. |
| `defaults.profile` | `permissive` \| `standard` \| `strict` | Profile used for consumers without an explicit assignment. |
| `consumers` | map consumer key to consumer | Per-subject profile assignment and overrides. |
| `controls` | object | All control configuration (below). |
| `profiles` | object with exactly `permissive`, `standard`, `strict` | Named strictness profiles (below). |

### `consumers.<key>`

| Field | Type | Description |
| --- | --- | --- |
| `profile` | profile name | The strictness profile this consumer's interactions run under. |
| `overrides` | partial profile (optional) | Deep-merged over the assigned profile. Both `enabledControls` and `thresholds` are all-or-nothing when present. |

### `controls`

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Kill switch. `false` runs observe-only (record but do not enforce). |
| `allowlist.models` | array (min 1) of `{ name, endpoint? }` | Permitted LLM models and endpoints. `endpoint` must be a URL when present. Interactions targeting a model outside this list are rejected. |
| `budget` | object | Budget rules (below). |
| `detection` | object | Deterministic detection configuration (below). |
| `redaction.enabled` | boolean | Whether detected sensitive spans are replaced with typed placeholders. |
| `semantic` | object | Semantic check definitions (below). |
| `shape.maxContentBytes` | positive integer | Maximum inspected content size; larger content fails the shape check before any scanning. |
| `signatures` | object | Signature enforcement configuration (below). |

### `controls.detection`

| Field | Type | Description |
| --- | --- | --- |
| `builtins` | object | Toggles for the built-in detector families: `providerSecrets`, `genericCredentials`, `pii`, `entropyScan`, `encodingRescan`. |
| `defaultActions` | map detection kind to action (min 1 entry) | Default action per detection kind (for example `secret`, `pii`, `suspect`, or any custom kind). |
| `rules` | array of rule | Custom regex detection rules. |

Each `controls.detection.rules[]` entry:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (min 1, unique) | Stable identifier, recorded as the `detectorId` on detections and in audit rows. |
| `kind` | string (min 1) | Detection kind, used for placeholders and default-action lookup. |
| `pattern` | string (min 1) | Regular expression. Must compile and pass a bounded-complexity check: nested unbounded quantifiers (`(a+)+`) and huge repeat counts (`a{5000,}`) are rejected with the whole policy. |
| `directions` | array (min 1) of `inbound` / `outbound` | Directions the rule inspects: `inbound` prompts, `outbound` model/tool output. |
| `action` | action | Applied when the rule fires. |

### `controls.semantic`

| Field | Type | Description |
| --- | --- | --- |
| `confidenceFloor` | number in [0, 1] | Answers whose confidence falls below the floor are treated as uncertain and get the profile's uncertainty verdict instead of a guess. |
| `checks` | array of check | The typed questions the decision model evaluates. |

Each `controls.semantic.checks[]` entry:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (min 1, unique) | Check identifier, used when consuming answers and in audit rows. |
| `type` | `boolean` \| `choice` \| `score` | Answer shape: boolean probability, choice over a fixed option set, or severity score. |
| `wording` | string (min 1) | The question presented to the decision model. |
| `criteria` | string (min 1) | The criteria the model evaluates. |
| `enabled` | boolean | Disabled checks are never evaluated and their thresholds cannot affect verdicts. |
| `options` | array (min 2) of strings | Required for `choice` checks, forbidden otherwise. |
| `thresholds.inbound` / `thresholds.outbound` | `{ block, redact, flag }` in [0, 1] | Per-direction action chain over the check's probability: at or above `block` the action is `block`, otherwise at or above `redact` it is `redact`, otherwise at or above `flag` it is `flag`, otherwise `allow`. |

### `controls.budget`

| Field | Type | Description |
| --- | --- | --- |
| `overBudgetVerdict` | verdict | Verdict applied when a projected interaction would exceed an exhausted or insufficient budget (default intent: `block`). |
| `rules` | array of rule | Budget rules per consumer key and model scope. |

Each `controls.budget.rules[]` entry:

| Field | Type | Description |
| --- | --- | --- |
| `key` | string (min 1) | Consumer key the budget is attributed to. |
| `modelScope` | string (min 1) | Model name the rule applies to, or `*` for all models. |
| `period` | `hour` \| `day` \| `month` | Time window the limits reset by. |
| `tokens` | positive integer (optional) | Token budget for the window. |
| `costUsd` | positive number (optional) | Monetary budget for the window. |
| `requests` | positive integer (optional) | Request-count budget for the window. |
| `computeTimeMs` | positive integer (optional) | Compute-time budget for the window. |

At least one limit is required per rule.

### `controls.signatures`

The signature feed itself is externally managed threat-intel data kept outside
the policy. The policy governs its enforcement.

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Whether signature matching runs at all. |
| `severityActions` | map of every severity (`critical`, `high`, `low`, `medium`) to action | Default action per feed severity. |
| `perSignatureActions` | map signature id to action | Per-signature overrides; an override wins over the severity default (this is also how false positives are neutralized without editing the feed). |
| `suspect.action` | verdict | Action for structural suspicion signals (invisible-character density, payload splitting, high-entropy blobs). |
| `suspect.threshold` | number in [0, 1] | Signal threshold at which the suspect action applies. |

## `profiles.<name>`

Each of `permissive`, `standard`, and `strict` selects a set of thresholds and
enabled controls. Interactions run under exactly one profile.

| Field | Type | Description |
| --- | --- | --- |
| `enabledControls` | `{ detection, semantic, signatures }` booleans | Which control tiers the profile runs. |
| `thresholds.<control>.<direction>` | `{ block, escalate, redact }` in [0, 1] | Evidence-to-verdict thresholds per control (`detection`, `semantic`, `signatures`) and direction (`inbound`, `outbound`): at or above `block` the verdict is `block`, otherwise at or above `redact` it is `redact`, otherwise at or above `escalate` it is `escalate`, otherwise `allow`. |

Lower threshold values make a profile stricter (less evidence is needed to
reach a stronger verdict).

## Validation rules at a glance

- Strict objects everywhere: unknown keys are rejected.
- All probabilities and thresholds are numbers in [0, 1].
- Detection rule `pattern` values must compile and be bounded in complexity.
- Detection rule ids and semantic check ids must each be unique.
- `choice` checks require `options` with at least two entries; other check
  types must not declare options.
- `severityActions` must cover all four severities.
- Budget rules need at least one limit.
- All three strictness profiles must be present in `profiles`.
