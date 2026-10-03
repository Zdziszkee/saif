# Spec Delta

## Purpose

Provides the single centralized policy source that defines all controls, tool and action permissions, sensitivity thresholds, strictness profiles, model allowlists, network egress allowlists, and budget rules, and makes changes effective at runtime without a restart. The policy is a zod-validated JSON document stored with full version history and editable through the dashboard.

## ADDED Requirements

### Requirement: Single policy source
All controls MUST be configured from one policy document. The document covers content controls, the deterministic detection rules, the tool and action catalog, per-user grants, the model allowlist, the network egress allowlist, budget rules, and semantic check definitions. The system SHALL validate the document against a zod schema at load time and MUST refuse to apply a partially invalid policy, keeping the last valid policy active and reporting the validation errors.

#### Scenario: Invalid policy rejected
- **WHEN** a policy document fails schema validation at startup
- **THEN** the system reports the validation errors and does not apply the invalid document

#### Scenario: Startup without a valid policy
- **WHEN** the policy document is invalid at startup and no previously valid policy exists
- **THEN** the system accepts no governed traffic and reports the validation errors until a valid policy is supplied

### Requirement: Tool and action catalog
The policy SHALL define a catalog of tools available to the agent. Each catalog entry MUST specify the tool's name, its source (built-in or a connected MCP server), the set of capability verbs it may perform (from `read`, `create`, `modify`, `delete`, `execute`, `network`), and whether calls to it require manual user confirmation. The catalog MAY carry an explicit action-classification override per tool that takes precedence over inferred classification.

#### Scenario: Catalog entry scopes actions
- **WHEN** a tool is listed in the catalog with the verbs `read` and `create`
- **THEN** calls classified as `read` or `create` on that tool may be granted and calls classified with any other verb cannot be allowed by any grant

#### Scenario: Classification override wins
- **WHEN** a catalog entry overrides the action classification for a tool
- **THEN** the override determines the tool's capability verb regardless of what name-based inference would produce

### Requirement: Per-user grants with deny-by-default
The policy SHALL define, per user, the set of tool and action pairs that user's agent may perform. A tool call whose tool and action pair is not in the calling user's grant set MUST be denied. Tools arriving from a newly connected MCP server MUST be ungranted until explicitly granted.

#### Scenario: Ungranted action denied
- **WHEN** an agent calls a tool with an action that the owning user has not been granted
- **THEN** the call is denied and the denial is recorded in the audit log

#### Scenario: Grant allows call
- **WHEN** an agent calls a tool with an action the owning user has been granted and no other control blocks it
- **THEN** the call proceeds to execution

#### Scenario: Newly connected tools ungranted
- **WHEN** a user connects a new MCP server whose tools are registered into the catalog
- **THEN** those tools are denied for that user until grants are added

### Requirement: Manual confirmation policy
The policy SHALL mark tool actions that require manual user confirmation. Deletion-classified actions MUST always require manual confirmation regardless of catalog configuration. A call requiring confirmation MUST NOT execute before the user approves it.

#### Scenario: Confirmed tool held
- **WHEN** a tool is marked as requiring manual confirmation and an agent calls it
- **THEN** the call does not execute and is routed to the approvals queue for user decision

#### Scenario: Deletion always gated
- **WHEN** an agent calls a deletion-classified action
- **THEN** the call requires manual user approval even if the catalog entry is not marked for confirmation

### Requirement: Network egress allowlist
The policy SHALL define the set of domains the model may read or reach and the MCP server endpoints users may connect. A network-classified action targeting a domain outside the allowlist MUST be denied, and a connection attempt to an MCP endpoint outside the allowlist MUST be rejected.

#### Scenario: Non-allowlisted domain denied
- **WHEN** a network-classified tool call targets a domain absent from the egress allowlist
- **THEN** the call is denied and the attempt is recorded in the audit log

#### Scenario: Allowlisted domain passes
- **WHEN** a network-classified tool call targets an allowlisted domain
- **THEN** egress control does not block the call

### Requirement: Thresholds and strictness profiles
The policy SHALL define, per control and per direction (inbound prompt, outbound output), the sensitivity thresholds that map evidence to `allow`, `redact`, `block`, or `escalate`, and SHALL define named strictness profiles (at least permissive, standard, strict) that select sets of thresholds and enabled controls.

#### Scenario: Profile changes thresholds
- **WHEN** a consumer is assigned the `strict` profile
- **THEN** controls use that profile's thresholds and enabled-control set for that consumer's interactions

### Requirement: Model allowlist
The policy SHALL define the set of permitted LLM models and endpoints. The system MUST reject interactions targeting a model outside the allowlist regardless of other control outcomes.

#### Scenario: Unlisted model rejected
- **WHEN** an interaction targets a model absent from the policy allowlist
- **THEN** the interaction is blocked and the rejection is recorded in the audit log

### Requirement: Egress allowlist
The policy SHALL define the egress allowlist of permitted external targets (network-classified tool-call targets and MCP connection endpoints), and targets outside it MUST be rejected deterministically.

#### Scenario: Non-allowlisted target rejected
- **WHEN** a network-classified call or MCP connection targets an endpoint outside the egress allowlist
- **THEN** the target is rejected before any forwarding and the rejection is recorded in the audit log

### Requirement: Policy storage, versioning, and dashboard editing
The policy document SHALL be stored with full version history. Editing the policy through the dashboard MUST create a new version validated against the schema before activation; the runtime SHALL apply the new version to subsequent interactions via an immutable snapshot swap. The system SHALL support rollback to any prior version and JSON import and export of the policy document so file-based editing remains possible.

#### Scenario: Dashboard edit takes effect
- **WHEN** a user saves a valid policy change in the dashboard
- **THEN** a new policy version is created and the next interaction is evaluated with the new version

#### Scenario: Invalid edit refused
- **WHEN** a dashboard policy edit fails schema validation
- **THEN** the edit is rejected with the validation errors and the active policy version is unchanged

#### Scenario: Rollback restores version
- **WHEN** a user rolls back to a prior policy version
- **THEN** that version becomes active for subsequent interactions and the rollback is recorded

#### Scenario: JSON export and import round-trips
- **WHEN** a policy is exported to JSON and imported unchanged
- **THEN** the imported policy validates and is equivalent to the exported version

### Requirement: Runtime policy reload
Policy changes MUST take effect for subsequent interactions without restarting the system. Each audit record SHALL reference the policy version in force at decision time.

#### Scenario: Live threshold change
- **WHEN** the policy is edited while the system is running
- **THEN** the next interaction is evaluated with the new thresholds and its audit record references the updated policy version

### Requirement: Deterministic rule configuration
The policy SHALL define the deterministic detection rules as custom regex rules, each with a stable identifier, a detection kind, a regex pattern, the target directions it applies to (inbound prompt, outbound output), and the mapped action (`allow`, `redact`, `block`, or `flag`). The policy SHALL also select which built-in detector families are active (provider-shaped secrets, generic credential assignments, PII kinds, entropy scanning, encoding-aware re-scan) and the default action per detection kind. Every regex MUST compile and pass a bounded-complexity check at policy validation; a policy carrying an uncompilable or unbounded pattern MUST be rejected like any other schema violation.

#### Scenario: Custom regex rule fires
- **WHEN** content matches a custom regex rule defined in the policy
- **THEN** the detection is reported with the rule's kind, the matched span, and the rule identifier, and the rule's mapped action is applied

#### Scenario: Rule scoped to a direction
- **WHEN** a custom rule targets outbound output only and the content is an inbound prompt
- **THEN** the rule does not fire

#### Scenario: Invalid regex rejected with the policy
- **WHEN** a policy document contains a custom rule whose pattern does not compile or is unbounded
- **THEN** the whole policy version is rejected with the validation errors and the last valid policy stays active

### Requirement: Semantic check configuration
The policy SHALL define the semantic checks as typed questions the decision model evaluates: `boolean` checks (for example prompt injection, jailbreak, data exfiltration request, malicious code), `choice` checks (a threat category over a fixed option set), and `score` checks (severity 0–1). Each check definition SHALL carry an identifier, its type, the wording and criteria the model evaluates, an activation flag, and per-direction thresholds. The policy MAY override the wording and criteria of built-in checks. Verdict mapping SHALL be expressed as explicit threshold conditions over the check's answer: if the check's probability is at or above the block threshold the verdict is `block`; otherwise at or above the redact threshold `redact`; otherwise at or above the flag threshold `flag`; otherwise `allow`. Answers whose confidence falls below the configured floor MUST follow the profile's uncertainty verdict.

#### Scenario: Check definition drives the question
- **WHEN** the policy defines or enables a semantic check
- **THEN** the decision model is asked exactly that check's typed question with its configured wording and criteria

#### Scenario: Semantic check disabled
- **WHEN** a semantic check is disabled in the policy
- **THEN** that check is not evaluated and its thresholds cannot affect verdicts until it is re-enabled

#### Scenario: Threshold conditions map answers to verdicts
- **WHEN** a check returns probability 0.9 and the active profile sets its block threshold at 0.8
- **THEN** the verdict is `block`, while the same answer under a profile whose block threshold is 0.95 is not `block`

#### Scenario: Wording override replaces default criteria
- **WHEN** a check definition overrides the wording and criteria of a built-in check
- **THEN** the decision model evaluates the overridden wording and the answer is consumed under the same check identifier

### Requirement: Tool-call enforcement configuration
The policy SHALL configure how a blocked tool call is enforced — tool-scoped (defined tool error, conversation continues) or turn-scoped (whole turn rejected) — selectable per strictness profile.

#### Scenario: Profile selects enforcement mode
- **WHEN** a profile sets tool-scoped enforcement and another sets turn-scoped enforcement
- **THEN** each blocked tool call is enforced according to the profile in force for that interaction

### Requirement: Signature control configuration
The policy SHALL map signature-feed severity levels to default actions and MAY override the action per signature identifier. It SHALL also configure the suspect action and threshold for structural suspicion signals. A severity mapping change MUST apply to subsequent matches without restart. The signature feed itself is externally managed threat-intel data kept outside the policy document; the policy governs its enforcement — severity mapping, per-signature action overrides, enable/disable toggles, and false-positive markings — and a signature marked as a false positive MUST be neutralized through a per-signature action override rather than by editing the feed.

#### Scenario: Severity mapping applied
- **WHEN** the policy maps a signature severity level to `block` and a signature of that severity fires
- **THEN** the interaction is blocked and the audit record cites the severity mapping in force

#### Scenario: Per-signature override wins
- **WHEN** the policy overrides the action for a specific signature identifier
- **THEN** that override applies instead of the severity default when the signature fires

#### Scenario: False positive neutralized
- **WHEN** a firing signature is marked as a false positive
- **THEN** subsequent matches on that signature apply the override action instead of the severity default, and the marking is recorded without modifying the feed entry
