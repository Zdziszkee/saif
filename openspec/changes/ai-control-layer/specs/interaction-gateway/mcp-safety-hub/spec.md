# Spec Delta

## Purpose

Makes the MCP server the safety hub: the single governed path through which every prompt and tool call must pass before reaching a model or executing a tool, so no traffic can bypass inspection.

## ADDED Requirements

### Requirement: Single governed path to the model
The hub SHALL be the only path from clients to the model: prompts reach the model exclusively through the hub's model-access tool (MCP tool `askModel`), and the system MUST NOT expose any other model-reaching interface. All tool calls execute through the hub's tool catalog: hub-hosted tools and tools registered from connected MCP servers.

#### Scenario: Prompt reaches model via the hub
- **WHEN** a client invokes `askModel` with a prompt
- **THEN** the prompt passes through the control pipeline and reaches the model only if the resulting verdict allows it

#### Scenario: No bypass path exists
- **WHEN** a client attempts to reach the model other than through the hub's MCP surface
- **THEN** no such interface is exposed by the system

### Requirement: Prompt governance at the hub
Every prompt submitted through the hub MUST be inspected by the control pipeline before it is forwarded to the model, and the model's answer MUST be inspected before it is returned to the caller.

#### Scenario: Unsafe prompt governed
- **WHEN** a prompt submitted via `askModel` matches a blocking control
- **THEN** the prompt never reaches the model and the caller receives the defined rejection for the blocking control

#### Scenario: Answer governed outbound
- **WHEN** a model answer contains sensitive data and the policy maps it to `redact`
- **THEN** only the redacted answer is returned to the caller

### Requirement: Tool-call governance at the hub
Every tool call against a hub-hosted tool MUST be inspected before execution, including its arguments, and every tool result MUST be inspected before being returned. Hub-hosted tools SHALL include ordinary tools (e.g. todo management) and demonstration risky tools (e.g. `fetchUrl`, `deleteAllTodos`).

#### Scenario: Risky tool call blocked
- **WHEN** a tool call matches a blocking control
- **THEN** the tool does not execute and the attempt is recorded in the audit log

#### Scenario: Tool arguments redacted before execution
- **WHEN** tool arguments contain sensitive data and the policy maps it to `redact`
- **THEN** the tool executes with redacted arguments and the audit record notes the redaction

#### Scenario: Poisoned tool schema refused at registration
- **WHEN** a tool schema or description (built-in or from a connected MCP server) matches a signature or contains hidden directive content at registration time
- **THEN** the tool is not admitted to the catalog and the attempt is recorded in the audit log

### Requirement: Configurable tool-call enforcement
The policy SHALL configure how a blocked tool call is enforced: tool-scoped (the tool call is refused with a defined tool error and the surrounding conversation may continue) or turn-scoped (the whole turn is blocked). Enforcement mode MUST be selectable per policy profile.

#### Scenario: Tool-scoped enforcement
- **WHEN** the policy configures tool-scoped enforcement and a tool call is blocked
- **THEN** the tool call receives a defined tool error, the turn continues, and the block is recorded in the audit log

#### Scenario: Turn-scoped enforcement
- **WHEN** the policy configures turn-scoped enforcement and a tool call is blocked
- **THEN** the entire turn is rejected with the defined rejection response and the block is recorded in the audit log

### Requirement: Governed agentic tool loop
When the model returns tool calls, the hub SHALL execute them through hub-hosted tools under tool-call governance and feed the results back to the model until a final answer is produced; the loop MUST be bounded by the applicable request-count and compute-time budgets.

#### Scenario: Tool call in the loop governed
- **WHEN** the model requests a tool call whose arguments match a blocking control
- **THEN** the tool does not execute and the loop receives the configured enforcement result instead of tool output

#### Scenario: Loop bounded by budget
- **WHEN** a tool loop exceeds the applicable request-count or compute-time budget
- **THEN** the loop terminates and the interaction is recorded with the over-budget verdict

### Requirement: OpenAI-compatible model connection
The hub SHALL connect to the model through an OpenAI-compatible API configured by environment variables (endpoint base URL, model name, API key), supporting any local or hosted endpoint that implements the OpenAI-compatible interface.

#### Scenario: Local endpoint configured
- **WHEN** environment variables point at a locally hosted OpenAI-compatible endpoint
- **THEN** hub prompts are served by that endpoint without code changes

#### Scenario: Endpoint changed by configuration
- **WHEN** the environment variables are changed to a different OpenAI-compatible endpoint and the service restarts
- **THEN** subsequent prompts are served by the new endpoint

### Requirement: MCP hub connections
The hub SHALL accept external MCP server connections (for example Confluence or Jira): users provide the server endpoint and a credential for that service. Connected servers' tools SHALL be registered dynamically into the tool catalog, and calls to them MUST pass through the same control pipeline and tool authorization as built-in tools. Connection attempts to endpoints outside the policy's egress allowlist MUST be rejected.

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
