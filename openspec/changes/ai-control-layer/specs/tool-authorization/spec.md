# Spec Delta

## Purpose

Authorizes every agent tool call before execution: classifies the action, evaluates the calling user's grants against the tool catalog, and routes calls requiring manual confirmation through the approvals queue. This is the enforcement side of the policy engine's tool and action permissions.

## ADDED Requirements

### Requirement: Tool call authorization
Every tool call issued by the agent MUST be authorized before execution. The authorization decision SHALL be one of `allow`, `deny`, or `require-approval`, determined from the calling user's grant set, the tool catalog entry, and the confirmation policy. Deny MUST prevent execution; require-approval MUST prevent execution until the user approves.

#### Scenario: Granted action allowed
- **WHEN** the calling user is granted the tool and action pair and no confirmation is required
- **THEN** the call is authorized and may execute

#### Scenario: Ungranted action denied
- **WHEN** the calling user is not granted the tool and action pair
- **THEN** the call is denied before execution and the denial is recorded in the audit log

#### Scenario: Same tool different users
- **WHEN** two users call the same tool with the same action and only one user holds the grant
- **THEN** the granted user's call is authorized and the other user's call is denied

### Requirement: Action classification
Each tool call SHALL be classified into exactly one capability verb from `read`, `create`, `modify`, `delete`, `execute`, `network`. Classification MUST use the catalog's explicit override when present and name- and description-based inference otherwise.

#### Scenario: Inferred classification
- **WHEN** a tool named `createIssue` is called and the catalog carries no override
- **THEN** the call is classified as `create`

#### Scenario: Override classification
- **WHEN** a catalog entry overrides classification for a tool and the tool is called
- **THEN** the call is classified with the overridden verb

### Requirement: Deny by default
A tool or action pair absent from the calling user's grant set MUST be denied by default; no configuration may grant access implicitly. Newly registered tools, including tools from a newly connected MCP server, start ungranted.

#### Scenario: New tool not implicitly granted
- **WHEN** a tool is registered into the catalog and the user's grants are unchanged
- **THEN** calls to that tool are denied until a grant is added

### Requirement: Approval workflow
A call whose decision is `require-approval` MUST NOT execute. It SHALL be recorded as a pending item in the dashboard approvals queue with its tool, action, and arguments. When the user approves, the agent's subsequent attempt at the same call is authorized; when the user denies, it stays denied. Every approval decision MUST record the deciding user and timestamp.

#### Scenario: Call held pending approval
- **WHEN** an agent calls a tool requiring manual confirmation
- **THEN** the call does not execute and appears in the approvals queue

#### Scenario: Approved call passes on next attempt
- **WHEN** the user approves a pending call and the agent attempts the same call again
- **THEN** the call is authorized and executes

#### Scenario: Denied call stays blocked
- **WHEN** the user denies a pending call
- **THEN** subsequent attempts at that call are denied

### Requirement: Deletion hard gate
Deletion-classified actions MUST require user approval on every call path; policy configuration MUST NOT be able to bypass this requirement.

#### Scenario: Deletion always approved
- **WHEN** an agent calls a deletion-classified action
- **THEN** the decision is `require-approval` regardless of grants or catalog confirmation flags

### Requirement: Authorization subject
Authorization decisions SHALL be evaluated against the calling user's subject. This version supports one agent per user; the subject model MUST NOT assume per-agent grant sets.

#### Scenario: Per-user decision
- **WHEN** an agent acts for a user
- **THEN** the user's grant set alone determines the authorization decision
