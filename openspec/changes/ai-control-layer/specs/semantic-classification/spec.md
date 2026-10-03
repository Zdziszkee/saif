# Spec Delta

## Purpose

Provides the AI-based semantic tier: Jev (TypeSafe AI's decision model) evaluates prompts and outputs against typed questions and returns calibrated probabilities and confidence, which the policy engine maps to verdicts.

## ADDED Requirements

### Requirement: Semantic evaluation of interactions
For each interaction reaching the semantic tier, the system SHALL evaluate the semantic check definitions enabled in the policy — typed `boolean`, `choice`, and `score` questions — in a single evaluation round trip and receive typed answers: boolean probabilities (e.g. prompt injection, jailbreak, data exfiltration, malicious code), a threat category choice, and a severity score. The questions asked SHALL be exactly those the policy defines; checks not defined or disabled in the policy are never evaluated.

#### Scenario: Injection attempt classified
- **WHEN** a prompt containing a prompt-injection attempt is evaluated
- **THEN** the injection question's probability is materially elevated and the threat category identifies injection with its probability distribution

#### Scenario: Benign prompt classified
- **WHEN** a benign prompt is evaluated
- **THEN** all threat probabilities remain below the policy's block thresholds and the interaction proceeds to the policy decision

### Requirement: Schema-constrained answers with confidence
Semantic answers MUST be schema-constrained to the declared check definitions (no free-form output), and every choice and score answer SHALL include its full probability distribution and a confidence value suitable for thresholding.

#### Scenario: Answer shape guaranteed
- **WHEN** the semantic tier returns answers
- **THEN** every answer matches its declared question type, every option of a choice appears in its distribution, and choice and score answers carry confidence

### Requirement: Confidence floors and uncertain outcomes
The system SHALL treat answers whose confidence or probability falls below the policy's configured floors as uncertain, and apply the profile's uncertainty verdict (default `escalate`) rather than guessing.

#### Scenario: Low confidence escalates
- **WHEN** a semantic answer's confidence is below the policy floor
- **THEN** the verdict is the profile's uncertainty verdict and the answer's values are recorded in the audit log

### Requirement: Availability and degradation
The system MUST bound semantic evaluation with a timeout and apply the policy's failure verdict when the decision model is unavailable or errors. The policy MAY route the semantic tier to an alternate classifier with the same check definitions.

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

### Requirement: Real decision model in the product path
The semantic tier SHALL run on a real decision model (Jev) in the product path. Test doubles MUST NOT be selectable as a semantic classifier through policy or runtime configuration.

#### Scenario: Product path uses the real model
- **WHEN** the semantic tier evaluates an interaction in a running system
- **THEN** the answers come from the configured real decision model

#### Scenario: No mock classifier selectable
- **WHEN** policy or runtime configuration names a classifier
- **THEN** only real classifier implementations are accepted
