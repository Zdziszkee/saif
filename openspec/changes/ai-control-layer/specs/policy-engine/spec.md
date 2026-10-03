# Spec Delta

## Purpose

Provides the single centralized policy source that defines all controls, the deterministic detection rules, sensitivity thresholds, strictness profiles, model allowlists, signature severity mapping, and budget rules, and makes changes effective at runtime without a restart. The policy is a zod-validated JSON document. The questions the semantic decision model is asked are NOT part of it: those live in the semantic tier's own `policy.jev.json`.

## ADDED Requirements

### Requirement: Single policy source
All controls MUST be configured from one policy document. The document covers content controls, the deterministic detection rules, the model allowlist, budget rules, and signature enforcement configuration. The system SHALL validate the document against a zod schema at load time and MUST refuse to apply a partially invalid policy, keeping the last valid policy active and reporting the validation errors.

#### Scenario: Invalid policy rejected
- **WHEN** a policy document fails schema validation at startup
- **THEN** the system reports the validation errors and does not apply the invalid document

#### Scenario: Startup without a valid policy
- **WHEN** the policy document is invalid at startup and no previously valid policy exists
- **THEN** the system accepts no governed traffic and reports the validation errors until a valid policy is supplied

### Requirement: Thresholds and strictness profiles
The policy SHALL define, per control and per direction (inbound prompt, outbound output), the sensitivity thresholds that map evidence to `allow`, `redact`, `block`, or `escalate`, and SHALL define named strictness profiles (at least permissive, standard, strict) that select sets of thresholds and enabled controls.

#### Scenario: Profile changes thresholds
- **WHEN** a consumer is assigned the `strict` profile
- **THEN** controls use that profile's thresholds and enabled-control set for that consumer's interactions

### Requirement: Group definitions
The policy SHALL define the named user groups that connect to the control layer as policy subjects, mapping each group identifier to a strictness profile and optional per-group control overrides. Policy resolution SHALL be deterministic: base document, then profile overlay, then per-group override, with the group override taking precedence and every merge result remaining schema-valid. A group the policy does not define MUST be rejected, never defaulted to another group's configuration.

#### Scenario: Group assigned to a profile
- **WHEN** the policy defines a consumer with the `strict` profile and that consumer sends traffic
- **THEN** the consumer's interactions are evaluated with the strict profile's thresholds and enabled-control set

#### Scenario: Per-consumer override wins
- **WHEN** a consumer override conflicts with its profile overlay
- **THEN** the consumer override is applied and other consumers continue to resolve without the override

### Requirement: Model allowlist
The policy SHALL define the set of permitted LLM models and endpoints. The system MUST reject interactions targeting a model outside the allowlist regardless of other control outcomes.

#### Scenario: Unlisted model rejected
- **WHEN** an interaction targets a model absent from the policy allowlist
- **THEN** the interaction is blocked and the rejection is recorded in the audit log

### Requirement: Runtime policy reload
Policy changes MUST take effect for subsequent interactions without restarting the system. Each audit record SHALL reference the policy version in force at decision time.

#### Scenario: Live threshold change
- **WHEN** the policy is edited while the system is running
- **THEN** the next interaction is evaluated with the new thresholds and its audit record references the updated policy version

### Requirement: Deterministic rule configuration
The policy SHALL define the deterministic detection rules as custom regex rules, each with a stable identifier, a detection kind, a regex pattern, the target directions it applies to (inbound prompt, outbound output), and the mapped action (`allow`, `redact`, `block`, or `flag`). The `flag` action forwards the content and records the match as flagged for review: it maps to the `allow` verdict with a flagged audit annotation, while `allow`, `redact`, and `block` map directly to the corresponding gateway verdicts. The policy SHALL also select which built-in detector families are active (provider-shaped secrets, generic credential assignments, PII kinds, entropy scanning, encoding-aware re-scan) and the default action per detection kind. Every regex MUST compile and pass a bounded-complexity check at policy validation; a policy carrying an uncompilable or unbounded pattern MUST be rejected like any other schema violation.

#### Scenario: Custom regex rule fires
- **WHEN** content matches a custom regex rule defined in the policy
- **THEN** the detection is reported with the rule's kind, the matched span, and the rule identifier, and the rule's mapped action is applied

#### Scenario: Rule scoped to a direction
- **WHEN** a custom rule targets outbound output only and the content is an inbound prompt
- **THEN** the rule does not fire

#### Scenario: Invalid regex rejected with the policy
- **WHEN** a policy document contains a custom rule whose pattern does not compile or is unbounded
- **THEN** the whole policy version is rejected with the validation errors and the last valid policy stays active

### Requirement: Semantic control governance
The policy SHALL select whether the semantic tier runs, per profile and per direction, and how its evidence maps to verdicts: thresholds that map a check's probability to `block`, `redact`, `flag` or `allow`. The policy MUST NOT define the questions the decision model is asked — those are the semantic tier's own concern and live in `policy.jev.json` at the project root.

#### Scenario: Semantic tier disabled for a profile
- **WHEN** a profile disables the semantic control
- **THEN** no semantic evaluation happens for that profile's interactions and the tier cannot affect verdicts

#### Scenario: Threshold conditions map answers to verdicts
- **WHEN** a check returns probability 0.9 and the active profile sets its block threshold at 0.8
- **THEN** the verdict is `block`, while the same answer under a profile whose block threshold is 0.95 is not `block`

#### Scenario: Profile threshold change applies without restart
- **WHEN** the semantic threshold for a profile is edited and the policy reloads
- **THEN** the next interaction is mapped with the new thresholds and its audit record references the updated policy version

### Requirement: Signature control configuration
The policy SHALL map signature-feed severity levels to default actions and MAY override the action per signature identifier. It SHALL also configure the suspect action and threshold for structural suspicion signals. A severity mapping change MUST apply to subsequent matches without restart. The signature feed itself is externally managed threat-intel data kept outside the policy document; the policy governs its enforcement — severity mapping, per-signature action overrides, and enable/disable toggles.

#### Scenario: Severity mapping applied
- **WHEN** the policy maps a signature severity level to `block` and a signature of that severity fires
- **THEN** the interaction is blocked and the audit record cites the severity mapping in force

#### Scenario: Per-signature override wins
- **WHEN** the policy overrides the action for a specific signature identifier
- **THEN** that override applies instead of the severity default when the signature fires
