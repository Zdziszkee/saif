# Spec Delta

## Purpose

Defines, accounts, and enforces financial and token budgets for model usage flowing through the LLM gateway. Limits are held per user; the user's group has no limit and exists only for check selection and reporting.

## ADDED Requirements

### Requirement: Budget rule definition
The policy SHALL define budget rules per user, covering token spend and monetary cost within a time window. Groups MUST NOT carry independent limits: one user exhausting their budget MUST NOT affect other users in the same group.

#### Scenario: Budget rule configured
- **WHEN** the policy defines a monthly spend cap for a user
- **THEN** interactions attributed to that user are metered against that cap

#### Scenario: Users metered separately
- **WHEN** two users in the same group both send traffic
- **THEN** each user's usage is counted only against their own limit and one user's exhaustion does not block the other

### Requirement: Pre-flight enforcement before content validation
For the LLM gateway seam the system MUST check the caller's budget BEFORE running any content control, and reject the interaction when its recorded spend has reached the configured limit. Checking limits first means an over-limit caller never consumes deterministic or decision-model work. The rejection is recorded with the cause `budget-exhausted`.

#### Scenario: Exhausted budget blocks before validation
- **WHEN** a user has exhausted their budget for the current window
- **THEN** the interaction is rejected with cause `budget-exhausted` and neither the deterministic nor the semantic tier is invoked

#### Scenario: Under-budget request validated
- **WHEN** the caller has remaining capacity
- **THEN** the interaction proceeds to content validation and is metered against the limit when the provider reports usage

### Requirement: Usage accounting
The system SHALL record actual usage after every forwarded call — prompt and completion tokens and the computed cost — and count it against the responsible user. Usage is derived from the rows the gateway writes, so the recorded spend is the single source of truth for limit enforcement; there is no separate reservation state to reconcile. The control layer's own decision-model spend is out of scope for this table.

#### Scenario: Actual usage recorded
- **WHEN** a forwarded interaction completes against a model
- **THEN** its token usage and cost are recorded and counted against the responsible user

### Requirement: Window reset and reporting
Budget windows SHALL roll over by time, usage SHALL be reportable per user and per window, and current budget state SHALL be visible to the reporting surfaces.

#### Scenario: Window rollover
- **WHEN** a budget window expires
- **THEN** counters reset for the new window and prior-window totals remain queryable for reporting
