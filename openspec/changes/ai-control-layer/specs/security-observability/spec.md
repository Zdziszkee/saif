# Spec Delta

## Purpose

Records every control decision in an append-only audit log, maintains real-time security metrics, and exposes reporting surfaces (export and dashboard) for security teams and management.

## ADDED Requirements

### Requirement: Append-only audit log
The system SHALL record an append-only audit entry for every governed interaction: interaction identity and consumer key, direction, policy version, verdict and reasons (fired detections, signatures, semantic probabilities and confidence), redactions applied, target model, token usage, computed cost, and pipeline latency. Audit entries MUST NOT be modifiable through application interfaces.

#### Scenario: Blocked interaction audited
- **WHEN** an interaction is blocked by a control
- **THEN** an audit entry records the verdict, the blocking control and its evidence, the policy version, and the request metadata

#### Scenario: Allowed interaction audited
- **WHEN** an interaction is allowed
- **THEN** an audit entry records the verdict and the evidence summary of every control that evaluated it

### Requirement: Real-time metrics
The system SHALL maintain aggregate metrics updated continuously across all connected agents and clients: interaction and verdict counts by control, category, and consumer key, redaction counts, budget consumption by key, and pipeline latency percentiles (p50/p95/p99).

#### Scenario: Metrics reflect recent activity
- **WHEN** interactions have been evaluated since the system started
- **THEN** the metrics surface reports current counts by verdict and control and current budget consumption

#### Scenario: Metrics attributable to a consumer
- **WHEN** several agents with distinct consumer keys have sent traffic
- **THEN** verdict counts and budget consumption are queryable per consumer key as well as in aggregate

### Requirement: Exportable audit trail
The system SHALL export audit entries in a standard machine-readable format (JSON Lines and CSV), filterable by time range, verdict, control, and consumer key, suitable for offline security analysis.

#### Scenario: Filtered export
- **WHEN** a security analyst exports blocked interactions for a time range
- **THEN** the export contains exactly the matching audit entries in the chosen format

### Requirement: Dashboard
The system SHALL provide an interactive dashboard for management and security teams showing: the configured controls and strictness profiles in force; overall security posture (recent verdict counts for `allow`, `redact`, `block`, and `escalate`); blocked and redacted threats broken down by control and category; resource and cost consumption over time against configured budget limits; pipeline latency percentiles; and the recent escalations awaiting review. Every metric section SHALL offer a per-consumer-key breakdown so the activity of each connected agent or client can be viewed in aggregate and in isolation. The dashboard MUST show the policy and signature feed versions currently in force.

#### Scenario: Posture overview
- **WHEN** a manager opens the dashboard
- **THEN** it displays current controls, recent verdict counts, top threat categories, and budget usage against configured limits

#### Scenario: Per-consumer breakdown
- **WHEN** a manager or security analyst selects a consumer key on the dashboard
- **THEN** verdict counts, threat categories, and budget usage are shown for that consumer alone

#### Scenario: Escalation queue
- **WHEN** interactions have been escalated
- **THEN** the dashboard lists the recent escalations for review

#### Scenario: Live refresh
- **WHEN** new interactions are evaluated while the dashboard is open
- **THEN** the dashboard reflects the updated metrics within one refresh interval without a manual reload

#### Scenario: Versions in force
- **WHEN** the dashboard is viewed
- **THEN** it shows the policy and signature feed versions currently in force
