# Spec Delta

## Purpose

Intercepts AI interactions at every seam (chat, MCP tool calls, generic guard API) and enforces the policy engine's verdicts so unsafe traffic is blocked or redacted before it reaches agents, models, or tools.

## ADDED Requirements

### Requirement: Interaction interception
The system SHALL route every governed AI interaction through the same control pipeline before forwarding, and SHALL inspect both inbound prompts and outbound model or tool output. Chat prompts, tool calls, and generic guard API requests are intercepted at their respective seams and flow through the shared pipeline.

#### Scenario: Guard API request intercepted
- **WHEN** a client sends a request to the generic guard API
- **THEN** the request passes through the control pipeline and is forwarded only if the resulting verdict allows it

### Requirement: Multi-consumer connections
The system SHALL serve many independent agents and clients concurrently, each presenting a consumer key that identifies the policy subject it acts as (for example one key per agent, application, or team). Consumer keys SHALL be accepted through a defined request header at every seam. Interactions from different consumers MUST be governed in isolation: one consumer's verdicts, policy configuration, or budget state MUST NOT affect another consumer's traffic. A missing or unknown consumer key MUST follow the policy's configured default-subject behavior (a defined default profile or rejection) and MUST NOT silently inherit another consumer's configuration.

#### Scenario: Concurrent agents governed independently
- **WHEN** two agents with different consumer keys send interactions concurrently
- **THEN** each interaction is evaluated under its own consumer's profile and recorded against its own consumer key

#### Scenario: Unknown consumer key
- **WHEN** a request presents a consumer key the policy does not define
- **THEN** the interaction follows the policy's default-subject behavior and the outcome is recorded in the audit log

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

### Requirement: Tools-only MCP hub
The MCP surface SHALL serve the governed tool catalog only: hub-hosted tools and tools from connected external MCP servers. Model access MUST NOT be exposed as an MCP tool; AI prompt and answer traffic is governed at the chat seam on the TanStack AI gateway. Every tool call on the MCP surface, including calls to tools served by connected external MCP servers, MUST pass through tool-call governance before execution.

#### Scenario: No model-reaching tool in the catalog
- **WHEN** a client enumerates the MCP tool catalog
- **THEN** it contains only tool entries and no model-reaching entry such as an `askModel` tool

#### Scenario: Connected MCP tool call governed
- **WHEN** a tool call targets a tool served by a connected external MCP server
- **THEN** the call passes through tool-call governance and is forwarded only under an allow verdict, with the outcome recorded in the audit log

### Requirement: Request shape validation
The system MUST validate the structure of incoming requests against the expected interaction schema and reject malformed requests before any control evaluation.

#### Scenario: Malformed request rejected
- **WHEN** a request does not match the expected interaction schema
- **THEN** it is rejected with a client error and recorded in the audit log without invoking any control tier
