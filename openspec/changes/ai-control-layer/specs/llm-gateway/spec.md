# Spec Delta

## Purpose

Exposes the control layer as an OpenAI-compatible LLM endpoint that developer agent harnesses (Claude Code and similar) point their `baseURL` at. Every prompt is gated before it reaches a model provider, and every call is metered so spend can be attributed to the user and group that caused it.

## ADDED Requirements

### Requirement: OpenAI-compatible surface
The system SHALL expose `POST /v1/chat/completions` in the OpenAI Chat Completions wire format and respond with Server-Sent Events token streaming, so a harness can use it as a drop-in replacement for a provider base URL with no code changes. Request and response shapes MUST match the OpenAI schema for the fields the harness relies on.

#### Scenario: Harness configured against the gateway
- **WHEN** an agent harness is configured with the gateway as its base URL and sends a chat completion request
- **THEN** it receives a streamed chat completion in the OpenAI format and cannot tell from the response shape that it is not talking to a model provider

#### Scenario: Malformed request rejected
- **WHEN** a request body does not match the OpenAI chat-completions schema
- **THEN** it is rejected with a client error before any control tier runs and the rejection is recorded

### Requirement: Caller identity
Each request SHALL identify its caller through the `x-user-id` and `x-user-group-id` headers. `user-id` identifies the individual and is the unit of usage limiting and per-user reporting; `user-group-id` identifies the group, selects the strictness profile and the semantic checks that apply, and is the unit of group-level reporting. Interactions from different users MUST be governed and metered in isolation.

#### Scenario: Identity captured
- **WHEN** a request presents both identity headers
- **THEN** the interaction is governed under that group's policy and every resulting record is attributed to that user and group

#### Scenario: Missing identity rejected
- **WHEN** a request omits `x-user-id` or `x-user-group-id`
- **THEN** the request is rejected and recorded with cause `missing-identity` and no control tier runs

#### Scenario: Unknown group rejected
- **WHEN** `x-user-group-id` names a group the configuration does not define
- **THEN** the request is rejected and recorded with cause `unknown-group` — the group must never silently fall back to another group's checks or limits

#### Scenario: Users isolated
- **WHEN** two users in the same group send requests concurrently
- **THEN** each is metered against its own budget and each record carries its own `user-id`

### Requirement: Lifecycle order
For every request the system SHALL apply these stages in order: resolve identity, enforce the caller's usage limit, run the deterministic tier, run the semantic tier, and only then forward to the model provider. Usage limits MUST be checked before content validation so an over-limit caller never consumes decision-model calls.

#### Scenario: Over-limit caller rejected before validation
- **WHEN** a caller whose budget is exhausted sends a prompt
- **THEN** it is rejected with cause `budget-exhausted` and neither the deterministic nor the semantic tier is invoked

#### Scenario: In-budget prompt forwarded
- **WHEN** a caller with remaining budget sends a prompt that passes both tiers
- **THEN** it is forwarded to the model provider

#### Scenario: Redacted prompt forwarded without history changes
- **WHEN** the newest user turn receives a `redact` verdict
- **THEN** the provider receives the redacted newest-turn text while every other message is forwarded unchanged

### Requirement: Newest-turn-only evaluation
The gateway SHALL evaluate only the newest user-role message in the request. Earlier user turns and assistant history are explicitly out of scope: they are never inspected, they never affect the verdict, and a hostile history MUST NOT cause a clean newest turn to be rejected.

#### Scenario: Clean newest turn with hostile history
- **WHEN** a request carries an attack in an earlier turn and a benign newest user turn
- **THEN** validation considers only the newest turn and the hostile history does not change the verdict

#### Scenario: Assistant history never inspected
- **WHEN** a request includes assistant messages alongside user turns
- **THEN** no assistant content is inspected and only the newest user turn determines the outcome

### Requirement: Harness markup retained verbatim
Complete harness scaffolding blocks (such as `system-reminder` elements) SHALL be retained verbatim in the evaluated and forwarded text. Their presence is detected as metadata only and MUST NOT create a silent removal bypass: enforcement sees exactly what the provider will see.

#### Scenario: Scaffolding reaches enforcement intact
- **WHEN** the newest user turn contains a complete scaffolding block
- **THEN** the evaluated text keeps the block verbatim and records its presence as metadata

#### Scenario: Malformed markup is not scaffolding
- **WHEN** the newest user turn contains malformed, spoofed, or unterminated markup
- **THEN** it is not flagged as harness scaffolding and the text is still evaluated verbatim

### Requirement: Inbound-only gating
Only inbound prompts SHALL be gated. Model output streams back to the harness unchanged, and the interaction is metered on completion. Answer content MUST NOT be inspected, stored, or delayed by the control layer.

#### Scenario: Answer streams through
- **WHEN** a prompt passes validation and the provider streams a completion
- **THEN** the tokens reach the harness as they are generated and no control tier observes the answer

### Requirement: Rejection taxonomy and evidence
Every interaction that does not proceed normally SHALL produce an audit record naming the cause (`missing-identity`, `unknown-group`, `malformed-request`, `budget-exhausted`, `blocked-by-check`, `classifier-failure`, `upstream-failure`), the user and group responsible, and — when a check rejected the content — the decisive check identifier, its numeric probability when available, and the combined scored evidence detail. For `block` and `escalate` outcomes the record SHALL also carry the exact prompt that was rejected, so it is available as evidence. Allowed traffic MUST NOT be stored with its content.

#### Scenario: Blocked prompt logged as evidence
- **WHEN** a prompt is rejected by a semantic check
- **THEN** the audit record names that check, its probability, the user and group, and the exact prompt text

#### Scenario: Blocked prompt carries scored evidence
- **WHEN** a prompt is rejected by one or more checks
- **THEN** the audit record carries the fired check identifier, its numeric probability when available, and the combined scored evidence detail

#### Scenario: Allowed prompt stored without content
- **WHEN** a prompt passes validation and is forwarded
- **THEN** its audit record carries the verdict and attribution but not the prompt text

#### Scenario: Rejection visible in the UI
- **WHEN** any rejection occurs
- **THEN** a notification is surfaced to the dashboard in addition to the durable audit record

### Requirement: Usage and cost accounting
For every forwarded request the system SHALL record token usage attributed to the requesting user and group, together with the model called and the computed monetary cost. Usage limits SHALL be enforced per user against the recorded spend in a time window; groups have no independent limit and exist only for check selection and aggregation.

#### Scenario: Cost attributed to a user
- **WHEN** a user's request is completed by the provider
- **THEN** the recorded usage carries that user's identifier, their group, the model, the prompt and completion token counts, and the computed cost

#### Scenario: Budget exhausted mid-window
- **WHEN** a user's recorded spend for the current window reaches their configured limit
- **THEN** further requests from that user are rejected with cause `budget-exhausted` until the window rolls over

#### Scenario: Group has no limit
- **WHEN** one user in a group exhausts their budget
- **THEN** other users in the same group are unaffected

### Requirement: Dynamic cost pricing
The system SHALL compute cost from a model price table acquired at runtime from the open-source LiteLLM `model_prices_and_context_window.json`, keeping only the per-model cost fields. Prices MUST NOT be hard-coded. When a model is absent from the table, cost SHALL be recorded as unknown rather than as zero, so reported totals cannot silently under-report spend.

#### Scenario: Known model priced
- **WHEN** a completed request used a model present in the price table
- **THEN** its cost is the prompt and completion token counts multiplied by that model's per-token prices

#### Scenario: Unknown model reported as unpriced
- **WHEN** a completed request used a model absent from the price table
- **THEN** its usage is recorded with cost unknown and the dashboard can surface it as unpriced

#### Scenario: Price table unavailable at startup
- **WHEN** the price table cannot be fetched when the service starts
- **THEN** the service starts and continues to gate traffic, cost is recorded as unknown, and the condition is logged
