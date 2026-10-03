# Spec Delta

## Purpose

Provides the single centralized policy source that defines all controls, sensitivity thresholds, strictness profiles, model allowlists, and budget rules, and makes changes effective at runtime without a restart.

## ADDED Requirements

### Requirement: Single policy source
All controls MUST be configured from one policy document. The system SHALL validate the document against a schema at load time and MUST refuse to apply a partially invalid policy, keeping the last valid policy active and reporting the validation errors.

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

### Requirement: Model allowlist
The policy SHALL define the set of permitted LLM models and endpoints. The system MUST reject interactions targeting a model outside the allowlist regardless of other control outcomes.

#### Scenario: Unlisted model rejected
- **WHEN** an interaction targets a model absent from the policy allowlist
- **THEN** the interaction is blocked and the rejection is recorded in the audit log

### Requirement: Runtime policy reload
Policy changes MUST take effect for subsequent interactions without restarting the system. Each audit record SHALL reference the policy version in force at decision time.

#### Scenario: Live threshold change
- **WHEN** the policy file is edited while the system is running
- **THEN** the next interaction is evaluated with the new thresholds and its audit record references the updated policy version

### Requirement: Semantic control configuration
The policy SHALL select which semantic checks are active and the thresholds applied to their answers, and MAY override the question wording used by the semantic tier.

#### Scenario: Semantic check disabled
- **WHEN** a semantic check is disabled in the policy
- **THEN** that check is not evaluated and its thresholds cannot affect verdicts until it is re-enabled
