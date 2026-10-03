# Spec Delta

## Purpose

Defines, accounts, and enforces resource and financial budgets — token spend, request counts, and compute time — for both commercial API and locally hosted model usage flowing through the control layer.

## ADDED Requirements

### Requirement: Budget rule definition
The policy SHALL define budget rules per consumer key and model scope, covering token spend (monetary), request count, and compute time, each within a time window, for commercial and local model backends alike.

#### Scenario: Budget rule configured
- **WHEN** the policy defines a monthly token-spend cap for a consumer key
- **THEN** interactions attributed to that key are metered against that cap

### Requirement: Pre-flight enforcement
Before forwarding an interaction, the system MUST check the applicable budgets and reject the interaction when its projected cost would exceed an exhausted or insufficient budget, using the policy's over-budget verdict (default `block`).

#### Scenario: Exhausted budget blocks
- **WHEN** a consumer key has exhausted its token budget for the current window
- **THEN** the interaction is blocked with the over-budget verdict and the rejection is recorded in the audit log

#### Scenario: Under-budget request forwarded
- **WHEN** the applicable budgets have remaining capacity
- **THEN** the interaction is forwarded and the projected usage is reserved against the budget

### Requirement: Usage accounting
The system SHALL record actual usage after every interaction — tokens, computed cost, and compute time — including the control layer's own semantic-tier usage, and reconcile it against the reserved projection.

#### Scenario: Actual usage recorded
- **WHEN** a forwarded interaction completes against a model
- **THEN** its actual token usage, cost, and latency are recorded and counted against the responsible consumer key

### Requirement: Window reset and reporting
Budget windows SHALL roll over by time, usage SHALL be reportable per key and per window, and current budget state SHALL be visible to the reporting surfaces.

#### Scenario: Window rollover
- **WHEN** a budget window expires
- **THEN** counters reset for the new window and prior-window totals remain queryable for reporting
