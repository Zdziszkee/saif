# Spec Delta

## Purpose

Provides fast, non-AI checks (secrets, PII, custom policy rules, and known historical AI-exploit signatures fed from an externally managed feed) that decide or sanitize the common case without invoking any model, keeping the hybrid defense cheap and deterministic.

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

### Requirement: Policy-defined detection rules
Custom regex rules defined in the policy SHALL run alongside the built-in detectors and produce the same detection contract (`kind`, `span`, `detectorId`, `confidence`, `validated`), with the rule identifier as the detector id and the policy-mapped action applied per rule.

#### Scenario: Custom rule detected alongside built-ins
- **WHEN** content matches both a custom policy rule and a built-in detector
- **THEN** both detections are reported with their own detector ids and spans, and each applies its mapped action

#### Scenario: Custom rule action from policy
- **WHEN** a custom rule maps its kind to `redact`
- **THEN** the matched span is replaced with a typed placeholder like any built-in redaction

### Requirement: Signature feed format and loading
The system SHALL load an externally managed signature feed of patterns associated with successful historical AI exploits — including prompt-injection payloads, jailbreak patterns, malicious code-execution shapes, unsafe deserialization markers, and model-repository supply-chain indicators — each with an identifier, description, pattern, kind, severity, source, and timestamps. Invalid entries MUST be reported and skipped without disabling the remaining feed.

#### Scenario: Feed loaded at startup
- **WHEN** the system starts with a valid signature feed
- **THEN** all valid signatures are active and any invalid entries are reported without preventing startup

### Requirement: Runtime feed updates
Signature feed changes MUST take effect for subsequent interactions without restarting the system, and each match SHALL record the signature identifier that fired.

#### Scenario: New signature takes effect
- **WHEN** a new signature is added to the feed while the system is running
- **THEN** the next interaction containing that pattern is matched and its audit record cites the new signature identifier

### Requirement: Signature matching and action
The system SHALL match inbound prompts, tool calls and their arguments, and outbound content against the feed deterministically and apply the policy-mapped action (default `block`) for the signature's severity. Matching MUST also cover the decoded form of encoded payloads so that a known exploit delivered inside base64, URL, hex, or HTML-entity encoding is matched.

#### Scenario: Known exploit payload blocked
- **WHEN** a prompt contains text matching a high-severity injection signature
- **THEN** the interaction is blocked under the default policy and the match is recorded in the audit log

#### Scenario: Encoded exploit payload blocked
- **WHEN** a prompt contains a known exploit payload encoded in base64 or URL encoding
- **THEN** the signature fires on the decoded form and the interaction is blocked

#### Scenario: Benign content unaffected
- **WHEN** content matches no signature
- **THEN** the signature tier contributes no verdict and evaluation continues

### Requirement: Evasion-resistant matching
Signature matching SHALL run against a canonicalized form of the content — Unicode NFKC normalization, case folding, zero-width and bidirectional-control character stripping, homoglyph folding, leetspeak folding, and whitespace and punctuation collapsing — in addition to the raw and decoded forms. Match spans MUST be mapped back to the raw content for redaction and audit, and an exploit evaded through any of these transforms MUST NOT escape matching.

#### Scenario: Obfuscated payload still matched
- **WHEN** a known exploit payload is delivered with zero-width characters, homoglyph substitution, leetspeak, or extra whitespace splitting its trigger words
- **THEN** the signature fires on the canonicalized form and the interaction is blocked

#### Scenario: Spans map to raw content
- **WHEN** a signature fires on a canonicalized or decoded form
- **THEN** the recorded span corresponds to the raw content that produced it

### Requirement: Structural suspicion signals
The system SHALL compute bounded structural signals over inspected content — invisible-character density, payload splitting or fragmentation markers, and high-entropy encoded blobs — and raise a `suspect` match when a signal crosses its configured threshold. Suspect matches MUST map to the policy's suspect action (default `redact` or `escalate`, never silently `allow` at high severity).

#### Scenario: Invisible-character smuggling flagged
- **WHEN** content carries an invisible-character payload dense enough to cross the configured threshold
- **THEN** a suspect match is raised, the configured suspect action applies, and the signal is recorded in the audit log

#### Scenario: Ordinary punctuation not flagged
- **WHEN** ordinary benign content with normal spacing and characters is inspected
- **THEN** no structural signal fires

### Requirement: Feed integrity and lifecycle
Each feed SHALL carry a version hash computed over its canonical content. Signatures MAY carry external references (for example MITRE ATLAS or OWASP identifiers) and MAY be disabled by identifier without deleting their history. The loader MUST deduplicate repeated identifiers deterministically and MAY verify a detached signature over externally managed feeds; a feed failing verification MUST NOT be loaded.

#### Scenario: Feed version recorded
- **WHEN** any signature fires
- **THEN** the audit record includes the feed version hash in force at match time

#### Scenario: Disabled signature inert
- **WHEN** a signature is disabled in the feed while the system is running
- **THEN** subsequent interactions no longer match it and its identifier remains resolvable for historical audit entries

#### Scenario: Tampered feed rejected
- **WHEN** a feed with a detached signature that fails verification is presented
- **THEN** the feed is not loaded and the previously loaded feed remains in force

### Requirement: Match safety
Signature patterns MUST be compiled under bounded matching: a fixed per-pattern and per-content match budget, no unbounded backtracking, and a bounded number of patterns per feed. A pattern that exhausts its budget MUST be reported and skipped without stalling the pipeline or disabling other signatures.

#### Scenario: Slow pattern contained
- **WHEN** a pattern exceeds its match budget on a pathological input
- **THEN** that pattern is reported and skipped, remaining signatures still fire, and the interaction is evaluated without pipeline stall

### Requirement: Feed provenance
Each signature SHALL carry a source and last-updated timestamp, and the audit log SHALL record feed provenance for matched interactions so security teams can trace detections to the feed version in force.

#### Scenario: Provenance recorded
- **WHEN** a signature fires
- **THEN** the audit record includes the signature identifier, its source, and the feed version in force at match time

### Requirement: External feed sources and ingestion
The system SHALL ingest signatures from externally managed systems through format adapters that normalize into the internal signature schema: OSV malicious-package reports (OpenSSF Malicious Packages, `MAL-` identifiers) for supply-chain signatures, MITRE ATLAS STIX 2.1 bundles, and vendor-style JSON feeds compiled from public exploit corpora (for example JailbreakBench artifacts, in-the-wild jailbreak prompt collections, and public payload collections). Each ingested signature MUST retain its external identifiers — MITRE ATLAS technique ids, OWASP category ids, and `MAL-` package ids — in its reference list. An unreachable or invalid source MUST NOT prevent signatures from other sources from loading.

#### Scenario: Malicious package pulled from OSV
- **WHEN** the OSV source reports a malicious package matching the configured ecosystems
- **THEN** a supply-chain signature for it is active at runtime and matches against tool calls and outputs

#### Scenario: ATLAS technique ingested
- **WHEN** a MITRE ATLAS STIX 2.1 bundle containing an attack procedure is presented to the STIX adapter
- **THEN** the procedure's patterns become active signatures whose references cite the ATLAS technique identifier

#### Scenario: Source outage contained
- **WHEN** one external source is unreachable while other sources are available
- **THEN** signatures from reachable sources remain active and the outage is reported without failing the system

### Requirement: Feed currency
External sources SHALL be refreshed on a configurable poll interval using conditional requests (ETag or Last-Modified) so that newly published signatures take effect at runtime without operator action. Polling of external sources SHALL be enabled by default, with the vendored snapshot and locally edited feed file acting as fallback and override inputs. The system SHALL retain the last-known-good feed across refresh failures and record the last successful refresh time per source.

#### Scenario: New upstream signature reaches the running system
- **WHEN** an external source publishes a new signature and the next poll succeeds
- **THEN** the signature is active for subsequent interactions and its audit matches cite the source and refresh time

#### Scenario: Refresh failure keeps last-known-good
- **WHEN** a poll fails or returns an invalid payload
- **THEN** the previously loaded feed remains in force and the failure is recorded
