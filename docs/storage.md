# Storage

## Purpose

Two tables back the reporting dashboard: `audit_events` records one row per governed AI
interaction — who called, when, what the verdict was, and why — and `usage_records` records
one row per forwarded model-provider call — which model ran and what it cost. A third table,
`mcp_tool_calls`, records one row per terminal MCP tool-call outcome for the hub's
per-tool/per-group/per-verdict views. They are sized
for reporting rather than completeness: a column exists only to serve a dashboard query, and
everything derivable at query time is left out. Schema source is `src/db/schema.ts` (Drizzle
over `bun:sqlite`), the generated migration is `drizzle/0000_natural_peter_parker.sql`, and the
`db` handle lives in `src/db/index.ts` (requires `DATABASE_URL`). Column names below are the
SQLite names; the Drizzle property is the camelCase equivalent except `user_group_id`, which
is `groupId`.

## audit_events

One row per governed interaction. `ts` is unix epoch seconds as an integer (the schema
default is `unixepoch()`), so "last 24 hours" is `ts >= unixepoch() - 86400`.

| Column | SQLite type | Nullable | Dashboard query it serves |
| ------ | ----------- | -------- | ------------------------- |
| `id` | integer PRIMARY KEY AUTOINCREMENT | no | Row identity; join key for `usage_records.audit_event_id`; deep links from dashboard rows. |
| `ts` | integer (unix seconds, default `unixepoch()`) | no | Every time-range filter and time-series chart. |
| `verdict` | text (`VERDICTS`) | no | Verdict distribution and block-rate charts. |
| `cause` | text (`AUDIT_CAUSES`) | yes | "Why are we blocking things?" grouping; null exactly when the interaction was allowed through. |
| `control_id` | text | yes | Top failing checks table — the decisive check id (e.g. `prompt_injection` or a detection rule id). |
| `score` | real | yes | Confidence column on the evidence table (a Jev probability or detection confidence); null when the cause was not a check or the check reports no score. |
| `user_id` | text | yes | Per-user drill-down and attribution (see Attribution caveat). |
| `user_group_id` | text | no | Per-group reporting; the policy subject dimension that drives check selection. |
| `policy_version` | text | no | Correlate outcome shifts with policy edits (hash of the policy document in force). |
| `prompt_text` | text | yes | Attack-evidence viewer for `block`/`escalate` rows; null for allowed traffic, which is recorded without content. |

## usage_records

One row per upstream model call that produced usage. `cost_usd` is USD computed from the
cached LiteLLM price table; `cost_usd IS NULL` means "model not in the price table"
(unpriced) — a visible state, not a silent zero.

| Column | SQLite type | Nullable | Dashboard query it serves |
| ------ | ----------- | -------- | ------------------------- |
| `id` | integer PRIMARY KEY AUTOINCREMENT | no | Row identity. |
| `ts` | integer (unix seconds, default `unixepoch()`) | no | Spend-over-time charts and the time window for budget aggregation. |
| `user_id` | text | no | Spend per user; per-user budget windows aggregate on this. |
| `user_group_id` | text | no | Spend per group; per-group budget windows aggregate on this. |
| `model` | text | no | Spend and call breakdown per model; discovery of unpriced models. |
| `prompt_tokens` | integer | no | Token volume charts. |
| `completion_tokens` | integer | no | Token volume charts; with `prompt_tokens` forms the total (see Deliberate omissions). |
| `cost_usd` | real | yes | Spend totals; `IS NULL` flags an unpriced model (and is skipped by `SUM`). |
| `audit_event_id` | integer REFERENCES `audit_events`(`id`) ON DELETE SET NULL | yes | Join to the interaction's verdict/cause; null when the call produced no governed interaction (e.g. pre-flight). |

## mcp_tool_calls

One row per terminal MCP tool-call outcome (executed, refused,
confirmation-required), reported by governance via `src/hub/tool-usage.ts`.
Tool arguments and results are never stored. `estimated_tokens` is a chars/4
heuristic over the inspected args + result — an estimate, never billed; model
cost stays in `usage_records`.

| Column | SQLite type | Nullable | Dashboard query it serves |
| ------ | ----------- | -------- | ------------------------- |
| `id` | integer PRIMARY KEY AUTOINCREMENT | no | Row identity. |
| `ts` | integer (unix seconds, default `unixepoch()`) | no | Time filtering; the `since` bound on per-tool counts. |
| `user_id` | text | yes | Per-user attribution (see Attribution caveat). |
| `user_group_id` | text | no | Per-group reporting; the `groupId` filter on per-tool counts. |
| `tool_name` | text | no | Calls per tool per verdict; the `toolName` filter. |
| `tool_source` | text (`TOOL_SOURCES`) | no | Builtin vs connected split (`builtin`, `connected`). |
| `verdict` | text (`VERDICTS`) | no | Per-verdict counts over tool calls. |
| `control_id` | text | yes | Decisive control for non-allow verdicts (`tool-authorization`, `tool-confirmation`). |
| `require_confirm` | integer (0/1, default `0`) | no | Whether the tool needed confirmation; feeds confirmation-request counts. |
| `confirmed` | integer (1/0) | yes | Confirmation outcome; null when the tool needs no confirmation. |
| `estimated_tokens` | integer | no | Volume heuristic over inspected args + result (estimate, never billed). |
| `latency_ms` | integer | yes | Tool-call latency. |
| `policy_version` | text | no | Correlate outcome shifts with tool-policy edits. |

## Enums

Exported from `src/db/schema.ts` as the tuples `VERDICTS` and `AUDIT_CAUSES` with the
matching `Verdict` and `AuditCause` types; these are the values other modules read and write.
`Verdict` mirrors the one in `src/control/types.ts`.

### verdict (`VERDICTS`)

| Value | Used when |
| ----- | --------- |
| `allow` | The interaction passed all checks and was forwarded unchanged. |
| `block` | A check or gate rejected the interaction; nothing was forwarded. |
| `escalate` | The interaction was rejected and held for human review instead of forwarded (surfaces as `escalated`). |
| `redact` | Sensitive spans were replaced with typed placeholders and only the scrubbed content was forwarded. |

### cause (`AUDIT_CAUSES`)

Null exactly when the interaction was allowed through; every rejection maps to one of these.

| Value | Used when |
| ----- | --------- |
| `missing-identity` | Required identity headers (`x-user-id` / `x-user-group-id`) were absent. |
| `unknown-group` | `x-user-group-id` named a group the configuration does not define. |
| `budget-exhausted` | The user's token/cost budget for the current window is spent. |
| `blocked-by-check` | A deterministic, signature or Jev check rejected the content. |
| `classifier-failure` | The semantic tier timed out or errored; the failure verdict was applied. |
| `upstream-failure` | The upstream provider failed after the prompt had passed validation. |

## Indexes and query dimensions

All from `drizzle/0000_natural_peter_parker.sql`. Every composite leads with the filter dimension
and ends with `ts`, so range scans serve the matching dashboard page.

| Index | Columns | Dashboard query it supports |
| ----- | ------- | --------------------------- |
| `audit_events_ts_idx` | (`ts`) | Time filtering over the audit feed. |
| `audit_events_user_ts_idx` | (`user_id`, `ts`) | Per-user activity in a range. |
| `audit_events_group_ts_idx` | (`user_group_id`, `ts`) | Per-group activity in a range. |
| `audit_events_verdict_ts_idx` | (`verdict`, `ts`) | Per-verdict counts and block rate in a range. |
| `usage_records_ts_idx` | (`ts`) | Spend over time; windowed budget aggregation. |
| `usage_records_user_ts_idx` | (`user_id`, `ts`) | Spend per user in a window. |
| `usage_records_group_ts_idx` | (`user_group_id`, `ts`) | Spend per group in a window. |
| `usage_records_audit_event_idx` | (`audit_event_id`) | Join usage rows to their audit event. |
| `mcp_tool_calls_ts_idx` | (`ts`) | Time filtering over tool calls. |
| `mcp_tool_calls_tool_ts_idx` | (`tool_name`, `ts`) | Calls per tool in a range. |
| `mcp_tool_calls_user_ts_idx` | (`user_id`, `ts`) | Tool calls per user in a range. |
| `mcp_tool_calls_group_ts_idx` | (`user_group_id`, `ts`) | Tool calls per group in a range. |
| `mcp_tool_calls_verdict_ts_idx` | (`verdict`, `ts`) | Tool calls per verdict in a range. |

## Deliberate omissions

| Not stored | Why not |
| ---------- | ------- |
| Latency | Not a dashboard need; no reporting query justified a timing column. |
| Prompt content for allowed traffic | Not a dashboard need: `prompt_text` exists as attack evidence for `block`/`escalate` only; allowed traffic is recorded without content. |
| `total_tokens` | Derivable from other columns: `prompt_tokens + completion_tokens` at query time. |
| Priced flag | Derivable from other columns: `cost_usd IS NULL` already means "model not in the price table" (unpriced). |
| Raw upstream status | Not a dashboard need; provider failures surface as `cause = 'upstream-failure'` on the audit row. |
| A budget table | Spend limits are enforced by aggregating `usage_records` over a time window rather than a separate counter table, so there is one source of truth for spend. |

## Attribution caveat

`user_id` is nullable on **all three** tables. It is null only at group-scoped surfaces that
identify no individual — MCP hub tool calls and tool registration. The LLM gateway seam
always sets it, so every gateway row is attributable to a user. Per-user views must treat
null rows as group-scoped events, not as missing data.

## Example queries

#### Recent verdict counts (last 24 hours)

```sql
SELECT verdict, COUNT(*) AS events
FROM audit_events
WHERE ts >= unixepoch() - 86400
GROUP BY verdict
ORDER BY events DESC;
```

#### Top failing checks in a time range

```sql
SELECT control_id, COUNT(*) AS hits
FROM audit_events
WHERE verdict IN ('block', 'escalate')
	AND ts >= unixepoch('2026-10-01')
	AND ts < unixepoch('2026-10-05')
	AND control_id IS NOT NULL
GROUP BY control_id
ORDER BY hits DESC
LIMIT 10;
```

#### Spend per user (last 7 days)

```sql
SELECT user_id,
	SUM(cost_usd) AS spend_usd,
	SUM(prompt_tokens + completion_tokens) AS tokens
FROM usage_records
WHERE ts >= unixepoch() - 7 * 86400
GROUP BY user_id
ORDER BY spend_usd DESC;
```

Unpriced rows are skipped by `SUM(cost_usd)`; the `tokens` total covers them.

#### Spend per group (last 30 days)

```sql
SELECT user_group_id, SUM(cost_usd) AS spend_usd
FROM usage_records
WHERE ts >= unixepoch() - 30 * 86400
GROUP BY user_group_id
ORDER BY spend_usd DESC;
```

#### Unpriced calls

```sql
SELECT model, COUNT(*) AS calls
FROM usage_records
WHERE cost_usd IS NULL
GROUP BY model
ORDER BY calls DESC;
```
