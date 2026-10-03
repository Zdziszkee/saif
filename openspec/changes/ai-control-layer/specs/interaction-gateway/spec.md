# Spec Delta

## Purpose

Intercepts AI interactions at every seam (chat, MCP tool calls, generic guard API) and enforces the policy engine's verdicts so unsafe traffic is blocked or redacted before it reaches agents, models, or tools.

## ADDED Requirements

### Requirement: Interaction interception
The system SHALL route every governed AI interaction — app-to-agent chat prompts, agent-to-MCP tool calls, and generic guard API requests — through the same control pipeline before forwarding, and SHALL inspect both inbound prompts and outbound model or tool output.

#### Scenario: Chat prompt intercepted
- **WHEN** a client sends a chat prompt to a governed chat endpoint
- **THEN** the prompt passes through the control pipeline and is forwarded to the model only if the resulting verdict allows it

#### Scenario: MCP tool call intercepted
- **WHEN** an agent issues a tool call through the MCP endpoint
- **THEN** the tool call arguments are inspected and a blocking verdict prevents the tool from executing

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
