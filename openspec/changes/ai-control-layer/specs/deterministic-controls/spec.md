# Spec Delta

## Purpose

Provides fast, non-AI checks (secrets, PII, allowlists, known signatures) that decide or sanitize the common case without invoking any model, keeping the hybrid defense cheap and deterministic.

## ADDED Requirements

### Requirement: Secret and PII detection
The system SHALL detect sensitive content in prompts and outputs using deterministic patterns, covering at least API keys and access tokens, email addresses, phone numbers, payment card numbers, and government-ID-like numbers. Every detection SHALL carry the matched control kind and span.

#### Scenario: Credential detected
- **WHEN** a prompt contains a string matching a known API key format
- **THEN** the detection is reported with kind `secret` and the exact span of the match

#### Scenario: PII detected
- **WHEN** an output contains an email address
- **THEN** the detection is reported with kind `pii` and the exact span of the match

### Requirement: Redaction of sensitive spans
When policy maps a detection to `redact`, the system SHALL replace each detected span with a typed placeholder identifying the sensitive kind, preserving surrounding content.

#### Scenario: Email redacted
- **WHEN** a prompt containing an email address is evaluated under a policy that redacts `pii`
- **THEN** the email is replaced with a typed placeholder and the remaining text is unchanged

### Requirement: Deterministic precedence
Deterministic controls SHALL run before the semantic tier. A `block` verdict from a deterministic control MUST be final; a `redact` verdict SHALL be applied before the semantic tier evaluates the remaining content.

#### Scenario: Redact then classify
- **WHEN** a prompt contains both a secret and a semantic threat pattern
- **THEN** the secret is redacted first and the semantic tier evaluates the redacted prompt, whose verdict is recorded alongside the redaction

#### Scenario: Deterministic block is final
- **WHEN** a deterministic control returns `block`
- **THEN** the semantic tier is not invoked for that interaction

### Requirement: Connected-service credential protection
The system SHALL detect credentials of user-connected MCP services (for example Confluence or Jira API tokens) in outbound content using deterministic patterns. Detected service credentials MUST be redacted before forwarding and MUST NOT reach the semantic tier, logs, or audit records.

#### Scenario: Service token redacted
- **WHEN** tool output from a connected MCP server contains that server's service credential
- **THEN** the credential span is replaced with a typed placeholder before the output is forwarded to the model

### Requirement: Domain egress enforcement
The system SHALL deterministically check the target of network-classified tool calls and MCP connection endpoints against the policy's egress allowlist before any forwarding. A target outside the allowlist MUST be blocked without invoking the semantic tier.

#### Scenario: Egress block is deterministic
- **WHEN** a network-classified call targets a domain outside the allowlist
- **THEN** the call is blocked by the egress check alone and the attempt is recorded in the audit log

### Requirement: Policy-defined detection rules
Custom regex rules defined in the policy SHALL run alongside the built-in detectors and produce the same detection contract (`kind`, `span`, `detectorId`, `confidence`, `validated`), with the rule identifier as the detector id and the policy-mapped action applied per rule.

#### Scenario: Custom rule detected alongside built-ins
- **WHEN** content matches both a custom policy rule and a built-in detector
- **THEN** both detections are reported with their own detector ids and spans, and each applies its mapped action

#### Scenario: Custom rule action from policy
- **WHEN** a custom rule maps its kind to `redact`
- **THEN** the matched span is replaced with a typed placeholder like any built-in redaction
