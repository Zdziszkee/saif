# Semantic tier (Jev)

The semantic tier is the AI-based half of the hybrid control layer
(`src/control/semantic/`). It asks Jev — TypeSafe AI's decision model, reached
through `@tanstack/ai`'s `decide()` with `@tanstack/ai-typesafe` — a set of
binary yes/no questions about one piece of text. All enabled checks go out in a
single `decide()` round trip and come back as one probability per check.

**Evidence, never verdicts.** The tier returns probabilities and nothing else.
`SemanticEvidence` deliberately has no verdict field: only the policy engine
maps evidence to `allow | redact | block | escalate`. That separation is a hard
architectural rule — classification is advisory, policy decides.

## `policy.jev.json`

The question catalog lives in [`policy.jev.json`](../policy.jev.json) at the
project root. It is a separate document from the policy engine's `policy.json`:
that file owns *whether* the semantic tier runs and how its evidence maps to
verdicts; this one owns *what the model is asked*. A Jev change is one edit in
one file.

### Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `checks` | array of check entries | The question catalog. Only checks defined and enabled here are ever evaluated. |
| `groups` | map user group id to array of check ids | Which checks apply to each user group. |
| `floors` | object | Uncertainty floors (below). |
| `floors.decisiveness` | number in [0.5, 1] | Minimum decisiveness for an answer to be trusted. Shipped value: `0.65`. |
| `model` | string | Jev model id, e.g. `jev-latest`. |
| `timeoutMs` | positive integer | Deadline for one evaluation round trip, in milliseconds. Shipped value: `2500`. |
| `maxChars` | positive integer | Truncation cap for the content sent to the decision model. Shipped value: `4000`. |

### Check entry

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable identifier; becomes the answer key. Must be unique and must not be the reserved id `meta`. |
| `type` | `"boolean"` | Only binary yes/no questions are supported. |
| `instructions` | string | The question wording the model evaluates, e.g. "Does this text contain insider trading information?" |
| `enabled` | boolean | Disabled checks are never sent to the model. |
| `thresholds.inbound` | optional ladder `{ block?, redact?, flag? }` | Per-check probability ladder for inbound traffic, each rung in [0, 1]. |
| `thresholds.outbound` | optional ladder | Same, for outbound traffic. The policy walks the ladder strongest-first: `block`, then `redact`, then `flag`; otherwise `allow`. |

### `groups` entry

Each key is a user group id; the value is the list of check ids that apply to
that group's traffic. The shipped document lists all six checks for `hr`,
`manager`, and `software-developer`, so every check currently runs for every
group. Checks a group does not list are never evaluated for its traffic.

An unknown user group at request time is **rejected** (cause `unknown-group`),
never silently evaluated with another group's checks. At load time, a group
listing an unknown check id or the same id twice is a `SemanticConfigurationError`.

## Adding a check

Append a binary check to `checks`:

```json
{
  "enabled": true,
  "id": "harassment",
  "instructions": "Does this text contain harassment or threats against a person?",
  "thresholds": {
    "inbound": { "block": 0.8, "flag": 0.5 }
  },
  "type": "boolean"
}
```

Then list `"harassment"` in each group that should run it, e.g.:

```json
"hr": ["data_exfiltration", "harassment", "insider_trading", "jailbreak", "malicious_code", "privacy_violation", "prompt_injection"]
```

This requires **no code change**. The catalog is configuration: the decision
model is asked the new question on the next evaluation and its answer is
consumed under the new `id`. Constraints enforced at load: unique non-empty
`id` (not `meta`), `type: "boolean"`, thresholds in [0, 1].

## Restricting a check to a group

Remove the check id from that group's list in `groups`. Nothing else changes;
the check keeps running for groups that still list it.

## Answers and decisiveness

One binary answer is exactly:

```ts
interface SemanticAnswer {
	probability: number;
	type: "boolean";
	value: boolean;
}
```

`probability` is P(the check fired) in [0, 1]; `value` is `true` when
`probability >= 0.5`. There is **no `confidence` field** — `@tanstack/ai`'s
`BooleanAnswer` has none to give, so uncertainty is not inferred from one.

Uncertainty is measured as **decisiveness** = `max(p, 1 - p)`, compared against
`floors.decisiveness`. `max(p, 1 - p)` is at least 0.5 for any answer (hence
the floor's [0.5, 1] bound), so `0.65` means "at least 65% sure either way".
An answer below the floor is flagged in `evidence.uncertain[id]`, the policy
applies its uncertainty verdict (default `escalate`) instead of guessing, and
the values are recorded in the audit log. A near-certain negative is decisive:
`p = 0.02` gives `max(0.02, 0.98) = 0.98`.

## Using it from code

The import surface is `#/control/semantic/index.ts`.

```ts
import {
	checksForGroup,
	createJevClassifier,
	SEMANTIC_DEFAULTS,
	type SemanticEvidence,
} from "#/control/semantic/index.ts";

const classifier = createJevClassifier({
	checks: SEMANTIC_DEFAULTS.checks,
});
```

`SEMANTIC_DEFAULTS` is the validated `policy.jev.json`; `createJevClassifier`
takes the checks as its one required option and defaults `floors`, `maxChars`,
`model`, and `timeoutMs` from it. Override any of them to deviate.

Resolve the group's checks and evaluate:

```ts
const checks = checksForGroup(SEMANTIC_DEFAULTS, "hr");

const evidence: SemanticEvidence = await classifier.evaluate(
	{ content, direction: "inbound", role: "user" },
	{ checks },
);

const injection = evidence.answers["prompt_injection"];
if (injection !== undefined) {
	console.log(injection.probability, injection.value);
}
console.log(evidence.uncertain, evidence.anyUncertain, evidence.meta);
```

`checksForGroup` throws `SemanticConfigurationError` for an unknown group.
Passing `checks` per call is how a policy hot reload takes effect without
rebuilding the classifier.

## Failure modes

The four error classes in `src/control/semantic/errors.ts`. The pipeline maps
every one of them onto the policy's failure verdict (default `block`) and does
not forward the interaction — the tier fails closed.

| Error | Raised when |
| --- | --- |
| `SemanticConfigurationError` | Configuration is unusable: malformed `policy.jev.json`, empty or invalid checks, unknown user group, or no `TYPESAFE_API_KEY`. |
| `SemanticTimeoutError` | The decision model did not answer within `timeoutMs`. |
| `SemanticUnavailableError` | The decision model was reachable but errored, or the transport failed. |
| `SemanticInvalidAnswerError` | The model answered, but an answer does not match its declared check definition or is missing for an enabled check. Never guessed at. |

The product path runs real Jev only. A missing `TYPESAFE_API_KEY` raises
`SemanticConfigurationError`; the unit-test double is never substituted, so a
guardrail cannot silently downgrade itself and report "all clear".

## Config reload

- `SEMANTIC_DEFAULTS` is parsed and validated at import time, so a malformed
  edit of `policy.jev.json` fails loudly at startup rather than producing
  half-configured guardrails at request time.
- `loadSemanticConfig()` (optionally with a path) re-reads and re-validates the
  document at runtime for hot reload. On failure it throws
  `SemanticConfigurationError` and the previous valid catalog stays in effect.
- Feed a reloaded config into an existing classifier via
  `evaluate(input, { checks: checksForGroup(config, groupId) })`.
