# Spec Delta

## Purpose

Detects and blocks patterns associated with historical AI exploits by matching interactions against an externally managed signature feed that can be updated at runtime.

## ADDED Requirements

### Requirement: Signature feed format and loading
The system SHALL load a signature feed of known AI-exploit patterns — including prompt-injection payloads, malicious tool-call shapes, unsafe deserialization markers, and model-repository supply-chain indicators — each with an identifier, description, pattern, and severity. Invalid entries MUST be reported and skipped without disabling the remaining feed.

#### Scenario: Feed loaded at startup
- **WHEN** the system starts with a valid signature feed
- **THEN** all valid signatures are active and any invalid entries are reported without preventing startup

### Requirement: Runtime feed updates
Signature feed changes MUST take effect for subsequent interactions without restarting the system, and each match SHALL record the signature identifier that fired.

#### Scenario: New signature takes effect
- **WHEN** a new signature is added to the feed while the system is running
- **THEN** the next interaction containing that pattern is matched and its audit record cites the new signature identifier

### Requirement: Signature matching and action
The system SHALL match inbound prompts, tool calls, and outbound content against the feed deterministically and apply the policy-mapped action (default `block`) for the signature's severity.

#### Scenario: Known exploit payload blocked
- **WHEN** a prompt contains text matching a high-severity injection signature
- **THEN** the interaction is blocked under the default policy and the match is recorded in the audit log

#### Scenario: Benign content unaffected
- **WHEN** content matches no signature
- **THEN** the signature tier contributes no verdict and evaluation continues

### Requirement: Feed provenance
Each signature SHALL carry a source and last-updated timestamp, and the audit log SHALL record feed provenance for matched interactions so security teams can trace detections to the feed version in force.

#### Scenario: Provenance recorded
- **WHEN** a signature fires
- **THEN** the audit record includes the signature identifier, its source, and the feed version in force at match time
