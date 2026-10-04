# Demo walkthrough

End-to-end judge run on localhost: boot the app, send one request per
verdict, read the dashboard, export the audit trail. Deterministic content
only — no model keys, no network beyond localhost.

## 1. Install

```bash
bun install
```

## 2. Start the app

```bash
bun run dev
```

This serves `http://localhost:3000`. Keyless boot is expected: without
`TYPESAFE_API_KEY` the Jev semantic tier reports itself disabled on
`GET /api/status` and the deterministic (regex) plus signature-feed tiers
decide every case below.

## 3. Send demo traffic

In a second terminal, from the same checkout:

```bash
bun scripts/demo-traffic.ts
```

The script posts to `POST /api/guard` as user `demo-judge` in group
`software-developer` (gateway identity headers `x-user-id` /
`x-user-group-id`) and asserts each verdict, exiting non-zero with a reason
on the first mismatch:

| Step         | Request                                                       | Expected                                |
| ------------ | ------------------------------------------------------------- | --------------------------------------- |
| allow        | benign question                                               | `allow`, HTTP 200                       |
| redact       | message containing `alice@example.com`                        | `redact`, HTTP 200, body shows `[EMAIL]` |
| guarded-chat | chat-seam prompt (the envelope `guardedChat()` sends inbound) | `allow`, HTTP 200                       |
| block        | prompt-injection ("ignore all previous instructions ...")     | `block`, HTTP 403, `blocked`            |
| escalate     | benign content, tool args carrying a markdown image link      | `escalate`, HTTP 403, `escalated`       |

The escalate case is the documented tool-metadata path: the
markdown-beacon signature is medium severity (redact action), but the match
sits in tool-call arguments the enforcement layer cannot rewrite, so the
signature tier escalates for review instead.

The script then prints tier status (`/api/status`), decision counts
(`/api/decisions`), the audit event count, and these URLs:

- dashboard: `http://localhost:3000/dashboard`
- audit JSONL: `http://localhost:3000/api/audit/export?format=jsonl`
- audit CSV: `http://localhost:3000/api/audit/export?format=csv`

To target a different host, set `DEMO_BASE_URL`:

```bash
DEMO_BASE_URL=http://localhost:3000 bun scripts/demo-traffic.ts
```

## 4. Read the dashboard

Open `http://localhost:3000/dashboard` (redirects to the Overview page).
It shows verdict counts, per-control attribution, and recent decisions,
including the five demo interactions and the `escalate` case awaiting
review. The same data is available keyless as JSON:

```bash
curl http://localhost:3000/api/decisions
curl http://localhost:3000/api/status
```

## 5. Export the audit trail

The bulk export is identity-gated: send the same gateway headers the demo
script uses.

```bash
curl -H "x-user-id: demo-judge" -H "x-user-group-id: software-developer" \
  "http://localhost:3000/api/audit/export?format=jsonl" -o audit.jsonl
curl -H "x-user-id: demo-judge" -H "x-user-group-id: software-developer" \
  "http://localhost:3000/api/audit/export?format=csv" -o audit.csv
```

Without a known user/group the export answers HTTP 403.

## Troubleshooting

- `POST /api/guard unreachable ...` with a non-zero exit: `bun run dev`
  is not serving `http://localhost:3000` (or `DEMO_BASE_URL` is wrong).
  Start the server first, then re-run the script.
- `expected verdict=... status=...`: the guardrail decided differently
  than the script asserts. The line names the step and both verdicts;
  inspect the policy (`policy.json`), the feed (`signatures.json`), and
  the dev-server log (`[guard] ...` lines) before re-running.
- Semantic tier stays disabled after setting `TYPESAFE_API_KEY`:
  environment is read at boot, so restart `bun run dev`.
