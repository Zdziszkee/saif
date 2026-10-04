# Spec Delta

## Purpose

Provides the AI-based semantic tier: Jev (TypeSafe AI's decision model) evaluates a prompt or output against a stack of policy-authored binary checks and returns calibrated probabilities, which the policy engine maps to verdicts.

## ADDED Requirements

### Requirement: Semantic evaluation of interactions
For each interaction reaching the semantic tier, the system SHALL evaluate the enabled checks defined in `policy.jev.json` at the project root — binary yes/no questions — in a single evaluation round trip and receive one probability per check. That document is the only home of the question catalog: the questions asked SHALL be exactly those it defines, checks not defined or disabled there are never evaluated, and adding a check MUST make it evaluate without a code change.

#### Scenario: Injection attempt classified
- **WHEN** a prompt containing a prompt-injection attempt is evaluated against a policy-defined `prompt_injection` check
- **THEN** that check's probability is materially elevated above its probability on a benign prompt

#### Scenario: Benign prompt classified
- **WHEN** a benign prompt is evaluated
- **THEN** every check's probability remains below the policy's block thresholds and the interaction proceeds to the policy decision

#### Scenario: Judge-authored check takes effect
- **WHEN** the policy gains a new binary check such as "Does this text contain insider trading information?"
- **THEN** the decision model is asked that question on the next interaction and its answer is consumed under the new check's identifier

### Requirement: Check catalog is configuration, not code
The question catalog — which binary checks exist, their wording, and their per-check thresholds — SHALL be read from `policy.jev.json` at the project root and validated at load time. The semantic tier MUST NOT hard-code questions, and a malformed catalog MUST fail loudly rather than silently running a reduced guardrail set.

#### Scenario: Judge-authored check takes effect
- **WHEN** a new binary check is appended to `policy.jev.json`
- **THEN** the decision model is asked that question on the next evaluation with no code change

#### Scenario: Malformed catalog rejected
- **WHEN** `policy.jev.json` contains a check with an empty identifier, a duplicate identifier, a reserved identifier, non-binary type, or an out-of-range threshold
- **THEN** the load fails with a configuration error naming the offending check and the previous valid catalog stays in effect

### Requirement: Group-selected checks
`policy.jev.json` SHALL map each user group to the set of check identifiers that apply to it, so different groups are asked different questions. Checks not listed for a group MUST NOT be evaluated for that group's traffic, and a group the mapping does not name MUST be rejected rather than silently evaluated with another group's set.

#### Scenario: Group selects its checks
- **WHEN** a request arrives from a user whose group lists `insider_trading` and `privacy_violation`
- **THEN** exactly those checks, plus any others the group lists, are evaluated and no unlisted check is asked

#### Scenario: Different groups asked different questions
- **WHEN** a request from group `hr` and a request from group `software-developer` are evaluated against the same content
- **THEN** each is evaluated against its own group's check set

#### Scenario: Unknown group never evaluated
- **WHEN** a request names a group absent from the mapping
- **THEN** no semantic evaluation happens and the interaction is rejected with cause `unknown-group`

### Requirement: Schema-constrained answers
Semantic answers MUST be schema-constrained to the declared check definitions (no free-form output). Every binary check answer SHALL carry its probability P(true) in the closed interval [0, 1] and the derived boolean value. Binary answers carry no confidence value, so uncertainty SHALL NOT be inferred from one.

#### Scenario: Answer shape guaranteed
- **WHEN** the semantic tier returns answers
- **THEN** every answer matches its declared check type, every enabled check has exactly one answer, and each answer carries a probability in [0, 1]

#### Scenario: Unusable answer fails closed
- **WHEN** the decision model returns an answer that does not match its declared check definition, or omits an answer for an enabled check
- **THEN** the system SHALL NOT guess at the answer and SHALL apply the policy's failure verdict

### Requirement: Decisiveness floors and uncertain outcomes
The system SHALL measure an answer's decisiveness as `max(p, 1 - p)`, treat answers whose decisiveness falls below the policy's configured floor as uncertain, and apply the profile's uncertainty verdict (default `escalate`) rather than guessing.

#### Scenario: Low decisiveness escalates
- **WHEN** a check's decisiveness is below the policy floor
- **THEN** the verdict is the profile's uncertainty verdict and the answer's values are recorded in the audit log

#### Scenario: Near-certain negative is decisive
- **WHEN** a check returns probability 0.02 with a decisiveness floor of 0.95
- **THEN** the answer is decisive (`max(0.02, 0.98) = 0.98`) and is not treated as uncertain

### Requirement: Availability and degradation
The system MUST bound semantic evaluation with a timeout and apply the policy's failure verdict when the decision model is unavailable, errors, or fails configuration. The policy MAY route the semantic tier to an alternate classifier with the same check definitions.

#### Scenario: Timeout fails closed
- **WHEN** the decision model does not answer within the configured timeout
- **THEN** the interaction is not forwarded and the failure verdict is applied

#### Scenario: Alternate classifier used
- **WHEN** the policy selects an alternate semantic classifier
- **THEN** the same check definitions are evaluated by that classifier and the resulting answers are consumed identically

### Requirement: Classification is advisory to policy
Semantic answers MUST NOT directly authorize or reject an action: only the policy engine maps answers to verdicts, and the same answers MUST be able to yield different verdicts under different profiles.

#### Scenario: Same answers, different verdicts
- **WHEN** identical semantic answers are evaluated under the `permissive` and `strict` profiles with different thresholds
- **THEN** each profile produces its own verdict from the same answers

### Requirement: Combined scored evidence detail
Each semantic evaluation that fires SHALL report the fired (worst) check identifier, its numeric probability P(true) when available, and a combined scored evidence detail listing every scored check with its probability. The audit row and the UI-facing audit response SHALL carry all three, so reviewers see not only what fired but what else was measured.

#### Scenario: Fired check reported with probability and detail
- **WHEN** a semantic check rejects an interaction
- **THEN** the audit record names the fired check identifier, its probability, and the combined per-check detail

#### Scenario: UI response carries the same evidence
- **WHEN** a reviewer polls recent audit rows for a blocked interaction
- **THEN** the returned event carries the same check identifier, probability, and combined detail as the stored row

### Requirement: Real decision model in the product path
The semantic tier SHALL run on a real decision model (Jev) in the product path. Test doubles MUST NOT be selectable as a semantic classifier through policy or runtime configuration; they are injected only by the test harness.

#### Scenario: Product path uses the real model
- **WHEN** the semantic tier evaluates an interaction in a running system
- **THEN** the answers come from the configured real decision model

#### Scenario: No mock classifier selectable
- **WHEN** policy or runtime configuration names a classifier
- **THEN** only real classifier implementations are accepted

#### Scenario: Missing credentials fail closed
- **WHEN** the product path cannot read a TypeSafe API key
- **THEN** the system reports a clear configuration error and applies the policy's failure verdict rather than substituting a test double
