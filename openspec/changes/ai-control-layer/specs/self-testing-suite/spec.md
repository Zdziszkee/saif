# Spec Delta

## Purpose

Defines the executable self-testing suite with a credential-free unit tier and a real-model integration tier, proving both positive (allowed) and negative (blocked/redacted) behavior of every control.

## ADDED Requirements

### Requirement: Unit tier without model keys
The unit tier MUST run and pass with no model API keys or network access. It SHALL cover the deterministic tier, policy engine, verdict mapping, signature matching, and budget accounting using fixed evidence and test doubles for boundaries only (test doubles MUST NOT be selectable as a product classifier).

#### Scenario: Unit tier runs credential-free
- **WHEN** the unit test suite is executed with no model environment variables set
- **THEN** all unit tests pass without network access

#### Scenario: Unit tier covers positive and negative cases
- **WHEN** the unit tier evaluates a control
- **THEN** it contains at least one allowed (positive) case and one blocked or redacted (negative) case for that control

### Requirement: Integration and end-to-end tier with real models
The integration/end-to-end tier MUST exercise the real semantic decision model (Jev) and a real OpenAI-compatible model endpoint through the hub, covering allow, redact, block, and escalate paths end to end. This tier SHALL require model credentials and MUST report a clear configuration error when they are missing.

#### Scenario: Integration tier runs with keys
- **WHEN** the integration tier is executed with the required model credentials configured
- **THEN** real interactions flow through the hub and the assertions verify actual model-backed verdicts

#### Scenario: Integration tier reports missing configuration
- **WHEN** the integration tier is executed without the required model credentials
- **THEN** the run fails fast with a message identifying the missing configuration rather than silently skipping

### Requirement: Budget and exploit test coverage
The suite SHALL include negative tests proving budget exhaustion blocks further interactions and known historical exploit patterns (injection, malicious tool calls, unsafe deserialization, supply-chain markers) are blocked or redacted per policy. Exploit coverage MUST include evasion variants (encoding, zero-width characters, homoglyphs, leetspeak, whitespace splitting) and poisoned tool-schema descriptions, and MUST assert that fired matches record their signature identifier and feed version.

#### Scenario: Exhausted budget blocks
- **WHEN** the suite exhausts a configured budget and submits another interaction
- **THEN** the interaction receives the over-budget verdict

#### Scenario: Exploit patterns mitigated
- **WHEN** the suite submits interactions matching seeded historical exploit signatures
- **THEN** each is blocked or redacted per the policy and the matching signature is recorded

#### Scenario: Evasion variants mitigated
- **WHEN** the suite submits known exploit payloads transformed with encoding, zero-width characters, homoglyphs, leetspeak, or whitespace splitting
- **THEN** each variant is still matched and the audit record cites the signature identifier and feed version
