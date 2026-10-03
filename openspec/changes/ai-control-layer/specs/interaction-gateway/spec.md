# Spec Delta

## Purpose

Intercepts AI interactions at every seam (chat, MCP tool calls, generic guard API) and enforces the policy engine's verdicts so unsafe traffic is blocked or redacted before it reaches agents, models, or tools.

## ADDED Requirements

### Requirement: Interaction interception
The system SHALL route every governed AI interaction through the same control pipeline before forwarding, and SHALL inspect both inbound prompts and outbound model or tool output. Chat prompts and MCP tool calls are intercepted at the MCP safety hub (see `mcp-safety-hub`); generic guard API requests are intercepted at the guard endpoint.

#### Scenario: Guard API request intercepted
- **WHEN** a client sends a request to the generic guard API
- **THEN** the request passes through the control pipeline and is forwarded only if the resulting verdict allows it

### Requirement: Verdict enforcement
The system SHALL apply exactly one verdict per inspected direction: `allow`, `redact`, `block`, or `escalate`. Redaction MUST replace flagged content with typed placeholders before forwarding; block MUST NOT forward the content; escalate MUST record the interaction for review and MUST NOT forward the content while unresolved. For tool calls, `escalate` manifests as `require-approval`: the call is held and routed to the approvals queue and executes only on the agent's next attempt after user approval.

#### Scenario: Redaction applied
- **WHEN** the pipeline returns `redact` for a prompt containing detected sensitive data
- **THEN** the sensitive spans are replaced with typed placeholders and only the redacted prompt is forwarded

#### Scenario: Block response shape
- **WHEN** the pipeline returns `block` for a request
- **THEN** the caller receives a defined rejection response identifying the blocking control and no content reaches the downstream model or tool

#### Scenario: Tool call held for approval
- **WHEN** the pipeline returns `escalate` (`require-approval`) for a tool call
- **THEN** the tool does not execute, the call is queued for user approval, and only an approved subsequent attempt reaches the tool

### Requirement: MCP hub connections
The MCP endpoint SHALL act as a hub: users connect external MCP servers (for example Confluence or Jira) by providing the server endpoint and a credential for that service. Connected servers' tools SHALL be registered dynamically into the tool catalog, and calls to them MUST pass through the same control pipeline and tool authorization as built-in tools. Connection attempts to endpoints outside the policy's egress allowlist MUST be rejected.

#### Scenario: Connected server tools governed
- **WHEN** a user connects an external MCP server and the agent calls one of its tools
- **THEN** the call is authorized and inspected by the control pipeline before reaching the external server

#### Scenario: Non-allowlisted endpoint rejected
- **WHEN** a user attempts to connect an MCP server whose endpoint is outside the egress allowlist
- **THEN** the connection is rejected and the attempt is recorded in the audit log

### Requirement: Credential custody
Third-party service credentials provided for connected MCP servers MUST be used only to call their target server. They MUST NOT appear in model-visible content, prompts, tool output forwarded to the model, or logs and audit records. A credential detected in forwarded content MUST be blocked or redacted by the deterministic tier before it leaves the pipeline.

#### Scenario: Token never reaches the model
- **WHEN** a connected MCP server's tool output is forwarded toward the model
- **THEN** the service credential is not present in the forwarded content or in any log entry

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
