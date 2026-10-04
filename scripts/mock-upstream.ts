/**
 * Mock upstream model provider for local gateway testing.
 *
 * Serves OpenAI-compatible completions on `MOCK_PORT` (default 4320) with no
 * API key and no network: `bun run mock`, then point the gateway at it with
 * `MODEL_BASE_URL=http://localhost:4320`. Replies echo the first user text
 * (truncated), so what the provider *received* is visible downstream — the
 * easiest way to prove redaction happened before forwarding.
 */

import { serve } from "bun";

export interface MockUpstreamBody {
	messages: readonly { content: unknown; role: string }[];
	model: string;
	stream?: boolean | undefined;
}

const ECHO_CHARS = 120;
const MS_PER_SECOND = 1000;
const WHITESPACE_RUN = /\s+/;

function firstUserText(body: MockUpstreamBody): string {
	for (const message of body.messages) {
		if (message.role !== "user") {
			continue;
		}
		if (typeof message.content === "string" && message.content.length > 0) {
			return message.content;
		}
	}
	return "";
}

function words(text: string): number {
	const count = text.split(WHITESPACE_RUN).filter((word) => word.length > 0).length;
	return count === 0 ? 1 : count;
}

/** SSE body: two content deltas, a usage payload, then DONE. */
export function buildMockStreamBody(body: MockUpstreamBody): string {
	const echo = firstUserText(body).slice(0, ECHO_CHARS);
	const reply = `Mock reply. Echo: ${echo}`;
	const lines = [
		`data: ${JSON.stringify({ choices: [{ delta: { content: "Mock reply. " } }] })}`,
		`data: ${JSON.stringify({ choices: [{ delta: { content: `Echo: ${echo}` } }] })}`,
		`data: ${JSON.stringify({
			usage: { completion_tokens: words(reply), prompt_tokens: words(firstUserText(body)) },
		})}`,
		"data: [DONE]",
		"",
	];
	return lines.join("\n");
}

/** Buffered completion body with matching usage. */
export interface MockJsonBody {
	choices: { finish_reason: string; index: number; message: { content: string; role: string } }[];
	created: number;
	id: string;
	model: string;
	object: string;
	usage: { completion_tokens: number; prompt_tokens: number };
}

export function buildMockJsonBody(body: MockUpstreamBody): MockJsonBody {
	const echo = firstUserText(body).slice(0, ECHO_CHARS);
	const content = `Mock reply. Echo: ${echo}`;
	return {
		choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
		created: Math.floor(Date.now() / MS_PER_SECOND),
		id: `mock-${Math.floor(Date.now())}`,
		model: body.model,
		object: "chat.completion",
		usage: { completion_tokens: words(content), prompt_tokens: words(firstUserText(body)) },
	};
}

function readBody(request: Request): Promise<MockUpstreamBody> {
	return request.json() as Promise<MockUpstreamBody>;
}

export function startMockUpstream(listenPort: number): void {
	serve({
		fetch: async (request) => {
			if (request.method !== "POST") {
				return new Response("mock upstream: POST only", { status: 404 });
			}
			const body = await readBody(request).catch(() => null);
			if (body === null || !Array.isArray(body.messages) || typeof body.model !== "string") {
				return Response.json(
					{ error: { code: "mock-malformed", message: "expected model and messages" } },
					{ status: 400 },
				);
			}
			if (body.stream === true) {
				return new Response(buildMockStreamBody(body), {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return Response.json(buildMockJsonBody(body));
		},
		port: listenPort,
	});
	console.log(`mock upstream listening on http://localhost:${listenPort}`);
}

const DEFAULT_MOCK_PORT = 4320;
const { MOCK_PORT } = process.env;
const port = Number(MOCK_PORT ?? DEFAULT_MOCK_PORT);

if (process.argv[1]?.endsWith("mock-upstream.ts") ?? false) {
	startMockUpstream(port);
}
