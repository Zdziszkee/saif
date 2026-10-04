/**
 * Upstream provider-session header (`x-opencode-session`).
 *
 * Some upstreams (OpenCode Zen Go) reject chat-completion requests without a
 * session attribution header. The gateway sends one per request — generated
 * when the caller does not pin one — so harness traffic is never refused for
 * a missing header the harness cannot know about.
 */

import { describe, expect, it } from "bun:test";

import { type FetchImpl, streamUpstreamCompletion } from "#/gateway/upstream.ts";

const SESSION_HEADER = "x-opencode-session";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface SeenRequest {
	headers: Headers;
	url: string;
}

function stubFetch(seen: SeenRequest[]): FetchImpl {
	return (input, init) => {
		seen.push({ headers: new Headers(init?.headers), url: String(input) });
		return Promise.resolve(
			new Response("data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
				status: 200,
			}),
		);
	};
}

describe("upstream session header", () => {
	it("sends a generated session id when none is pinned", async () => {
		const seen: SeenRequest[] = [];
		const stream = streamUpstreamCompletion({
			apiKey: "test-key",
			baseUrl: "https://upstream.test",
			body: { messages: [], model: "test-model" },
			fetchImpl: stubFetch(seen),
		});
		for await (const _chunk of stream) {
			// Consume the relay so the terminal usage resolves.
		}
		const sent = seen[0]?.headers.get(SESSION_HEADER);
		expect(sent).toMatch(UUID_PATTERN);
	});

	it("sends the pinned session id verbatim", async () => {
		const seen: SeenRequest[] = [];
		const stream = streamUpstreamCompletion({
			apiKey: "test-key",
			baseUrl: "https://upstream.test",
			body: { messages: [], model: "test-model" },
			fetchImpl: stubFetch(seen),
			sessionId: "turn-123",
		});
		for await (const _chunk of stream) {
			// Consume the relay so the terminal usage resolves.
		}
		expect(seen[0]?.headers.get(SESSION_HEADER)).toBe("turn-123");
	});
});
