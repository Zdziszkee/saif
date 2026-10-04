# Spec Delta

## Purpose

Records every control decision in an append-only audit log, maintains real-time security metrics, and exposes reporting surfaces (export and dashboard) for security teams and management.

## ADDED Requirements

### Requirement: Append-only audit log
The system SHALL record one append-only audit row per governed interaction, carrying exactly the fields the reporting surfaces use: event time, user id, user group id, verdict, cause, the decisive check identifier, its numeric probability when available, and the combined scored evidence detail, the policy version in force, and the prompt text for rejected content. Audit rows MUST NOT be modifiable through application interfaces.

The prompt text SHALL be stored only for `block` and `escalate` outcomes, where it is the evidence a security team needs. Allowed traffic is recorded without its content.

Token usage and monetary cost are NOT part of the audit row; they are recorded in the usage table and joined by the reporting surfaces. Latency is NOT recorded.

#### Scenario: Blocked interaction audited
- **WHEN** an interaction is blocked by a control
- **THEN** an audit row records the verdict, the cause, the decisive check and its score, the combined scored evidence detail, the policy version, the responsible user and group, and the exact prompt text

#### Scenario: Allowed interaction audited
- **WHEN** an interaction is allowed
- **THEN** an audit row records the verdict, attribution and policy version, and does not record the prompt text

#### Scenario: Non-check rejection audited
- **WHEN** an interaction is rejected for a reason other than a control — missing identity, an unknown group, or an exhausted budget
- **THEN** the audit row records the cause naming that reason and carries no check identifier

#### Scenario: UI audit response carries scored evidence
- **WHEN** the dashboard polls recent audit rows
- **THEN** each returned event carries the decisive check identifier, its probability when available, and the combined scored evidence detail

### Requirement: Stdout decision line
The gateway SHALL write one stdout decision line per completed terminal outcome. Each line carries redaction-safe fields only — identity, direction, model, outcome, blocking control, hit counts with truncated evidence, token and cost totals, and upstream status — and MUST NOT contain raw prompt text.

#### Scenario: Terminal outcome logged without content
- **WHEN** a turn ends in any terminal outcome
- **THEN** exactly one decision line is written carrying the outcome and the blocking control but not the prompt text

#### Scenario: Settled call logged with usage
- **WHEN** a forwarded call completes against the provider
- **THEN** the decision line carries the observed prompt and completion token counts and the computed cost, or an unpriced marker when the model has no known price

### Requirement: Usage and cost records
For every call forwarded to a model provider the system SHALL record a usage row: event time, user id, user group id, model, prompt and completion token counts, and computed monetary cost. A row whose model has no known price SHALL record cost as unknown rather than zero.

#### Scenario: Usage attributed
- **WHEN** a request completes against a provider
- **THEN** a usage row records the calling user and group, the model, the token counts and the computed cost

#### Scenario: Unpriced model visible
- **WHEN** a completed call used a model with no known price
- **THEN** its usage row records cost as unknown so reporting can surface it as unpriced

### Requirement: Queryable reporting dimensions
Audit and usage rows SHALL be indexed and queryable by event time, user id, user group id, verdict, and decisive check, so the reporting surfaces can aggregate along any of those dimensions without a full table scan.

#### Scenario: Per-user and per-group attribution
- **WHEN** several users across several groups have sent traffic
- **THEN** verdict counts, failing checks and spend are queryable per user, per group, and in aggregate

#### Scenario: Top failing checks
- **WHEN** checks have rejected interactions in a time range
- **THEN** the checks are countable in descending order of how often they fired

### Requirement: Real-time metrics
The system SHALL maintain aggregate metrics across all connected callers: interaction and verdict counts by check and by user group, unpriced-call counts, and spend by user and group against configured limits.

#### Scenario: Metrics reflect recent activity
- **WHEN** interactions have been evaluated since the system started
- **THEN** the metrics surface reports current counts by verdict and check and current spend against limits

#### Scenario: Spend attributable to a caller
- **WHEN** several users have sent traffic
- **THEN** spend is queryable per user and per group as well as in aggregate

### Requirement: Exportable audit trail
The system SHALL export audit and usage rows in a standard machine-readable format (JSON Lines and CSV), filterable by time range, verdict, cause, check identifier, user id and user group id, suitable for offline security analysis.

#### Scenario: Filtered export
- **WHEN** a security analyst exports blocked interactions for a time range
- **THEN** the export contains exactly the matching rows in the chosen format

### Requirement: Dashboard
The system SHALL provide an interactive dashboard for management and security teams showing: the configured controls and strictness profiles in force; overall security posture (recent verdict counts for `allow`, `redact`, `block`, and `escalate`); rejected threats broken down by cause and by check; spend over time against configured user limits; calls whose cost could not be determined; and the recent escalations awaiting review. Every metric section SHALL offer a per-user and per-group breakdown. The dashboard MUST show the policy version currently in force.

#### Scenario: Posture overview
- **WHEN** a manager opens the dashboard
- **THEN** it displays current controls, recent verdict counts, top failing checks, and spend against configured limits

#### Scenario: Per-user and per-group breakdown
- **WHEN** a manager or security analyst selects a user or a group on the dashboard
- **THEN** verdict counts, failing checks and spend are shown for that selection alone

#### Scenario: Unpriced spend surfaced
- **WHEN** calls were made to models with no known price
- **THEN** the dashboard shows them as unpriced rather than folding them into a zero cost total

#### Scenario: Escalation queue
- **WHEN** interactions have been escalated
- **THEN** the dashboard lists the recent escalations for review

#### Scenario: Live refresh
- **WHEN** new interactions are evaluated while the dashboard is open
- **THEN** the dashboard reflects the updated metrics within one refresh interval without a manual reload

#### Scenario: Policy version in force
- **WHEN** the dashboard is viewed
- **THEN** it shows the policy version currently in force

### Requirement: Rejection notifications
Every rejection SHALL be surfaced to the dashboard as a live notification in addition to being durably recorded, so an operator sees blocked traffic as it happens.

#### Scenario: Block surfaces immediately
- **WHEN** a prompt is blocked
- **THEN** the dashboard receives a notification identifying the cause, the check, and the responsible user and group
