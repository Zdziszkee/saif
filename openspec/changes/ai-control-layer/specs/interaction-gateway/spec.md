# Spec Delta

## Purpose

Intercepts AI interactions at every seam (the LLM gateway, chat, MCP tool calls, generic guard API) and enforces the policy engine's verdicts so unsafe traffic is blocked or redacted before it reaches agents, models, or tools.

## ADDED Requirements

### Requirement: Interaction interception
The system SHALL route every governed AI interaction through the same control pipeline before forwarding, and SHALL inspect both inbound prompts and outbound model or tool output. LLM gateway completions, chat prompts, tool calls, and generic guard API requests are intercepted at their respective seams and flow through the shared pipeline.

#### Scenario: Guard API request intercepted
- **WHEN** a client sends a request to the generic guard API
- **THEN** the request passes through the control pipeline and is forwarded only if the resulting verdict allows it

### Requirement: Caller identity across seams
The system SHALL serve many independent callers concurrently, each identified by a user id and a user group id presented through defined request headers. The user id identifies the individual and is the unit of usage limiting and per-user reporting; the user group id identifies the group, selects the policy profile and the applicable control set, and is the unit of group-level reporting. Interactions from different callers MUST be governed and metered in isolation: one caller's verdicts, policy configuration, or budget state MUST NOT affect another's. A missing identity or a group the policy does not define MUST be rejected and recorded, and MUST NOT silently inherit another caller's configuration.

#### Scenario: Concurrent callers governed independently
- **WHEN** two callers with different user ids send interactions concurrently
- **THEN** each interaction is evaluated under its own group's profile and recorded against its own user id

#### Scenario: Unknown group rejected
- **WHEN** a request presents a user group id the policy does not define
- **THEN** the interaction is rejected and the outcome is recorded with the reason that the group does not exist

### Requirement: Verdict enforcement
The system SHALL apply exactly one verdict per inspected direction: `allow`, `redact`, `block`, or `escalate`. Redaction MUST replace flagged content with typed placeholders before forwarding; block MUST NOT forward the content; escalate MUST record the interaction for review and MUST NOT forward the content while unresolved.

#### Scenario: Redaction applied
- **WHEN** the pipeline returns `redact` for a prompt containing detected sensitive data
- **THEN** the sensitive spans are replaced with typed placeholders and only the redacted prompt is forwarded

#### Scenario: Block response shape
- **WHEN** the pipeline returns `block` for a request
- **THEN** the caller receives a defined rejection response identifying the blocking control and no content reaches the downstream model or tool

### Requirement: Fail-closed behavior
The control pipeline MUST fail closed: when any enabled control errors, times out, or returns an unusable result, the system SHALL apply the policy's configured failure verdict (default `block`) and record the failure.

#### Scenario: Classifier unavailable
- **WHEN** the semantic tier is enabled but its decision model is unreachable or times out
- **THEN** the interaction is not forwarded and the failure is recorded in the audit log

### Requirement: Request shape validation
The system MUST validate the structure of incoming requests against the expected interaction schema and reject malformed requests before any control evaluation.

#### Scenario: Malformed request rejected
- **WHEN** a request does not match the expected interaction schema
- **THEN** it is rejected with a client error and recorded in the audit log without invoking any control tier
