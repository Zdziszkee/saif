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
The system SHALL maintain aggregate metrics updated continuously: interaction and verdict counts by control and category, redaction counts, budget consumption by key, and pipeline latency percentiles.

#### Scenario: Metrics reflect recent activity
- **WHEN** interactions have been evaluated since the system started
- **THEN** the metrics surface reports current counts by verdict and control and current budget consumption

### Requirement: Exportable audit trail
The system SHALL export audit entries in a standard machine-readable format (JSON Lines and CSV), filterable by time range, verdict, control, and consumer key, suitable for offline security analysis.

#### Scenario: Filtered export
- **WHEN** a security analyst exports blocked interactions for a time range
- **THEN** the export contains exactly the matching audit entries in the chosen format

### Requirement: Dashboard
The system SHALL provide an interactive dashboard showing configured controls and profiles, overall security posture, blocked and redacted threats with their categories, and resource and cost consumption over time.

#### Scenario: Posture overview
- **WHEN** a manager opens the dashboard
- **THEN** it displays current controls, recent verdict counts, top threat categories, and budget usage against configured limits
