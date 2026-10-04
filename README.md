# Saif

AI control layer: every LLM call passes deterministic, signature-feed, and semantic (Jev) tiers before reaching the model. Open `http://localhost:3000` for the dashboard, playground, and policy/JEV-check editors.

## Run it (no keys needed)

```bash
bun install
bun run mock      # terminal 1 — mocked model upstream (:4320)
bun run mock:jev  # terminal 2 — mocked Jev decision model (:4321)
bun run dev       # terminal 3 — the app (:3000)
```
You will need to create an .env file:

sample:
TYPESAFE_API_KEY=apikey_1234567890987654321. -- use this to use the real JEV, without TYPESAFE_BASE_URL
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=sk_1234567890987654321

Point the gateway at the mock (`MODEL_BASE_URL=http://localhost:4320`), then `bun run demo` in a fourth terminal for five scripted verdicts. Retune the mocked Jev without code: copy `data/mock-jev-keywords.json` and run `MOCK_JEV_CONFIG=/tmp/mine.json bun run mock:jev`.

## Validate it

```bash
bun run verify                 # tsc + biome, must be clean
bun run test                   # full suite, hermetic by default
bun run test:integration:mock  # live tier against mock-jev (CI runs this too)
```

## Show it off (60 seconds)

1. Controls → JEV checks → uncheck `malicious_code` → Save.
2. Playground → send the tube-like-baubles prompt from `tests/filtered-prompts.test.ts` → **allow** (no other tier can see it).
3. Re-check → Save → send again → refused. You just toggled an AI guardrail from a web form.

## Real keys (optional)

No keys means deterministic + feed tiers only (semantic skips and says so). For the real thing: `TYPESAFE_API_KEY` (Jev), plus `MODEL_BASE_URL` + `MODEL_API_KEY` for a real model (Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`). True-live integration tests: `TYPESAFE_API_KEY=... bun run test:integration`.

Docs live in `docs/` (`gateway.md`, `policy.md`, `controls.md`, `semantic.md`, `demo.md`).
