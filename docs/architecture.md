# Architecture

```
                 +-----------------------------------+
                 |           ENTRY POINTS            |
                 |    Chat | MCP tools | Guard API   |
                 +-----------------+-----------------+
                                   |
                                   v
+------------------- GUARD PIPELINE ------------------+
|                                                      |
|  +------------------------------------------------+  |
|  | 1. VALIDATE                                    |  |
|  |    Shape and model allowlist                   |  |
|  +-----------------------+------------------------+  |
|                          v                           |
|  +------------------------------------------------+  |
|  | 2. SIGNATURE FEED                  <-----------+--+--- signatures.json
|  |    Known exploit patterns                      |  |    (hot reload)
|  +-----------------------+------------------------+  |
|                          v                           |
|  +------------------------------------------------+  |
|  | 3. DETERMINISTIC                               |  |
|  |    Secrets and PII detection, redaction        |  |
|  +-----------------------+------------------------+  |
|                          v                           |
|  +------------------------------------------------+  |
|  | 4. SEMANTIC (JEV)                              |  |
|  |    Typed intent questions (AI classifier)      |  |
|  +-----------------------+------------------------+  |
|                          |                           |
+--------------------------+---------------------------+
                           v
          +--------------------------------+
          |         POLICY VERDICT         |  <---- policy.json
          | Allow | Redact | Block | Esc.  |        (editable rules,
          +----------------+---------------+         hot reload)
                           v
          +--------------------------------+       +--------------------+
          |           AUDIT LOG            | ----> | DASHBOARD + EXPORT |
          |      Append-only records       |       | Metrics, JSONL, CSV|
          +--------------------------------+       +--------------------+

  Stages 1-3 = cheap, fast checks      Stage 4 = costly check, runs last
```

## Entry points

Every seam funnels into the same pipeline. Chat prompts and model answers go
through `guardedChat()` (`src/control/chat.ts`); MCP tool calls and results
pass through the hub catalog and governor (`src/hub/`); anything else posts
to `POST /api/guard` (`src/routes/api.guard.ts`). Malformed envelopes are
rejected before any control runs (`src/control/shape.ts`).

## Pipeline stages

`createControlPipeline()` (`src/control/pipeline.ts`) runs stages in declared
order with per-control timeouts. A stage that errors, times out, or returns an
unusable result fails closed to the policy's failure verdict. The worst
verdict across stages wins (`block > escalate > redact > allow`).

1. **Validate** (`src/control/allowlist.ts`) — when an interaction names a
   model, it must be in the policy allowlist; prompts without a model pass
   through.
2. **Signature feed** (`src/control/signatures/`) — `signatures.json` holds
   known exploit patterns (prompt injection, jailbreak, malicious tool calls,
   unsafe deserialization, supply-chain markers). Entries validate
   individually: bad rows are skipped without killing the feed, the file is
   versioned by SHA-256, and edits hot-reload for subsequent inspections.
3. **Deterministic** (`src/control/deterministic/`) — regex detectors for
   secrets and PII (Luhn, IBAN mod-97, PESEL, ABA, UUID checks), the CC0 name
   dataset behind a hash index, local Compromise NER, and policy-authored
   custom regex rules. Unvalidated hits map to the `suspect` action.
4. **Semantic** (`src/control/semantic/control.ts`) — policy-authored boolean
   checks evaluated in one Jev `decide()` round trip, each answer mapped
   through its per-direction threshold ladder. Missing credentials fail
   closed; uncertainty flags for review instead of guessing.

## Policy verdict

`policy.json` is the single source: controls, thresholds, strictness profiles,
model allowlist, and signatures severity mapping — hot-reloaded at runtime.
Consumers map to profiles; the hub wires the stages the default profile
enables. Classification stays advisory: only the policy mapping produces
verdicts.

## Audit, dashboard, export

Every decision lands in the append-only audit sink (`src/control/audit.ts`).
`/dashboard` shows verdict counts and recent decisions with auto-refresh;
`/api/audit/export?format=jsonl|csv` serves the trail with verdict, control,
and subject filters for security review.
