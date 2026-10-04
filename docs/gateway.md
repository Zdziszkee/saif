# LLM gateway: point agent harnesses at the guard layer

`POST /v1/chat/completions` is an OpenAI-compatible endpoint. Any harness
that lets you override the provider base URL can run its traffic through
the control pipeline with no code changes:

```sh
# opencode (OpenAI-compatible provider): set the base URL to the gateway
export OPENAI_BASE_URL="http://localhost:3000/v1"
```

Every request carries caller identity headers (the harness must send them —
opencode supports custom headers per provider):

```
x-user-id: alice
x-user-group-id: hr
```

Per request, in order: identity → usage limit → deterministic + semantic
gating → forward to `MODEL_BASE_URL`. Completions stream back untouched;
usage is metered per user on completion. Blocked prompts are refused with
an OpenAI-style error body and audited with the exact prompt as evidence.

Env the gateway needs:

```sh
MODEL_BASE_URL=https://api.openai.com/v1   # upstream provider
MODEL_API_KEY=sk-...                        # fallback when the harness sends no Authorization header
TYPESAFE_API_KEY=ts-...                     # enables the semantic tier (optional)
```

Costs come from the LiteLLM price table fetched at startup — no hard-coded
prices. Unknown models record cost as unknown, never zero. Without
`TYPESAFE_API_KEY` the semantic tier is skipped and reported as such.

## Local testing without a provider

`bun run mock` starts a fake OpenAI-compatible upstream on port 4320
(`MOCK_PORT` overrides). Point the gateway at it and try the full loop —
the mock echoes the received prompt back, so redaction is directly
observable:

```sh
bun run mock &                                  # terminal 1
MODEL_BASE_URL=http://localhost:4320 bun run dev  # terminal 2 (port 3000)

curl -X POST localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-user-id: alice' -H 'x-user-group-id: hr' \
  -d '{"model":"local-small","messages":[{"role":"user","content":"mail alice@example.com the report"}],"stream":true}'
# -> Echo: mail [EMAIL] the report   (upstream never saw the address)
```

Watch `tail -f data/audit.jsonl` and `http://localhost:3000/dashboard`
alongside. The mock's builders (`buildMockStreamBody`,
`buildMockJsonBody`) are unit-tested in `tests/mock-upstream.test.ts`.

## Mock Jev decision service

`bun run mock:jev` stands in for TypeSafe's `POST /v1/systemone` on port
4321 (`MOCK_JEV_PORT` overrides) so the semantic tier runs with no API key:

```sh
bun run mock:jev &                                     # terminal 1
TYPESAFE_API_KEY=test-key TYPESAFE_BASE_URL=http://localhost:4321 bun run dev  # terminal 2
```

The mock scores content against a keyword map per check and answers with
wire-shape `noul` probabilities. Judges can retune it without touching
code: copy `data/mock-jev-keywords.json`, edit the keyword lists (a key
scores every check whose id contains it, so exact check ids and fragments
both work), and point the mock at the copy — it loads once at startup, so
restart the mock after editing. A missing or invalid file refuses to start
instead of scoring the wrong verdicts:

```sh
MOCK_JEV_CONFIG=/tmp/our-keywords.json bun run mock:jev
# -> mock Jev scoring: /tmp/our-keywords.json
```

Parsing and file loading (`parseMockJevScoringConfig`,
`loadMockJevScoringConfig`) are unit-tested in `tests/mock-jev.test.ts`,
including a test that the shipped example scores identically to the
built-ins.

## Not yet

- **Claude Code** speaks the Anthropic Messages protocol (`/v1/messages`),
  and **Codex CLI** speaks the OpenAI Responses API (`/v1/responses`).
  Both need protocol adapters over the same orchestration; only Chat
  Completions ships today.
- Usage implants are in-memory: spend resets on restart. Durable
  budget windows arrive with the storage layer.
- The gateway gates user and system text. Assistant history and tool
  payloads pass through uninspected.
