/**
 * Upstream model client for the LLM gateway seam.
 *
 * POSTs the governed OpenAI body to `{baseUrl}/v1/chat/completions` with
 * streaming forced on and usage requested, then yields each raw SSE `data:`
 * payload verbatim. The terminal `usage` object (present because
 * `stream_options.include_usage` is injected) is surfaced as the generator's
 * return value so the lifecycle can settle cost accounting at stream end.
 * Non-2xx responses and mid-stream transport errors surface as
 * {@link UpstreamError}.
 */

import { describeError } from "#/lib/errors.ts";

export const UPSTREAM_TIMEOUT_MS = 60_000;

const COMPLETIONS_PATH = "/v1/chat/completions";
const SSE_DATA_PREFIX = "data:";
const SSE_DONE_MARKER = "[DONE]";
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_BAD_GATEWAY = 502;
const UPSTREAM_ERROR_SNIPPET_LENGTH = 500;
const TRAILING_SLASHES_PATTERN = /\/+$/u;
const SSE_FRAME_SPLIT_PATTERN = /\r?\n\r?\n/u;
const SSE_LINE_SPLIT_PATTERN = /\r?\n/u;
const SSE_LEADING_SPACE_PATTERN = /^ /u;

/** Wire keys read from upstream SSE payloads (string access, never identifiers). */
const USAGE_KEY = "usage";
const PROMPT_TOKENS_KEY = "prompt_tokens";
const COMPLETION_TOKENS_KEY = "completion_tokens";
const ERROR_KEY = "error";

export interface UpstreamUsage {
	completionTokens: number;
	promptTokens: number;
}

export interface StreamUpstreamOptions {
	apiKey: string | undefined;
	baseUrl: string;
	body: Record<string, unknown>;
	fetchImpl?: FetchImpl | undefined;
	/**
	 * Provider session attribution header (`x-opencode-session`). Some
	 * upstreams (OpenCode Zen Go) reject requests without it; generated per
	 * request when omitted so callers never have to track provider sessions.
	 */
	sessionId?: string | undefined;
	signal?: AbortSignal | undefined;
	timeoutMs?: number | undefined;
}

/** Injectable fetch surface (narrower than `typeof fetch`, which Bun extends). */
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "UpstreamError";
		this.status = status;
	}
}

/**
 * Stream raw SSE payloads from the upstream provider. Yields every `data:`
 * payload (including the terminal `[DONE]`) verbatim and returns the last
 * usage object observed, or null when the provider sent none.
 */
export async function* streamUpstreamCompletion(
	options: StreamUpstreamOptions,
): AsyncGenerator<string, UpstreamUsage | null, void> {
	const response = await postUpstream(options);
	return yield* readUpstreamEvents(response);
}

async function postUpstream(options: StreamUpstreamOptions): Promise<Response> {
	const url = `${options.baseUrl.replace(TRAILING_SLASHES_PATTERN, "")}${COMPLETIONS_PATH}`;
	const headers = new Headers({ "content-type": "application/json" });
	if (options.apiKey !== undefined) {
		headers.set("authorization", `Bearer ${options.apiKey}`);
	}
	headers.set("x-opencode-session", options.sessionId ?? crypto.randomUUID());
	const timeout = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(url, {
		body: JSON.stringify(options.body),
		headers,
		method: "POST",
		signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
	});
	if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
		throw new UpstreamError(response.status, await upstreamFailureDetail(response));
	}
	if (response.body === null) {
		throw new UpstreamError(response.status, "upstream response had no body");
	}
	return response;
}

async function upstreamFailureDetail(response: Response): Promise<string> {
	let snippet = "unreadable";
	try {
		snippet = (await response.text()).slice(0, UPSTREAM_ERROR_SNIPPET_LENGTH);
	} catch {
		snippet = "unreadable";
	}
	return `upstream rejected the request with status ${response.status}: ${snippet}`;
}

async function* readUpstreamEvents(
	response: Response,
): AsyncGenerator<string, UpstreamUsage | null, void> {
	const reader = response.body?.getReader();
	if (reader === undefined) {
		throw new UpstreamError(response.status, "upstream response had no body");
	}
	const decoder = new TextDecoder();
	let buffer = "";
	let usage: UpstreamUsage | null = null;
	let streaming = true;
	try {
		while (streaming) {
			// biome-ignore lint/performance/noAwaitInLoops: SSE chunks arrive sequentially by protocol
			const read = await reader.read();
			if (read.done) {
				streaming = false;
			} else {
				const split = splitFrames(buffer + decoder.decode(read.value, { stream: true }));
				buffer = split.remainder;
				for (const payload of split.payloads) {
					const observed = observePayload(payload);
					if (observed !== null) {
						usage = observed;
					}
					yield payload;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	return usage;
}

/**
 * Split complete SSE frames off the buffer, keeping the tail for more chunks.
 */
function splitFrames(buffer: string): { payloads: string[]; remainder: string } {
	const frames = buffer.split(SSE_FRAME_SPLIT_PATTERN);
	const remainder = frames.pop() ?? "";
	const payloads: string[] = [];
	for (const frame of frames) {
		const payload = readFramePayload(frame);
		if (payload !== null) {
			payloads.push(payload);
		}
	}
	return { payloads, remainder };
}

/**
 * One SSE frame to its `data:` payload: comment lines skipped, multiple
 * `data:` lines joined per the SSE spec, one optional leading space stripped.
 */
function readFramePayload(frame: string): string | null {
	const lines = frame.split(SSE_LINE_SPLIT_PATTERN);
	const data: string[] = [];
	for (const line of lines) {
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith(SSE_DATA_PREFIX)) {
			data.push(line.slice(SSE_DATA_PREFIX.length).replace(SSE_LEADING_SPACE_PATTERN, ""));
		}
	}
	if (data.length === 0) {
		return null;
	}
	return data.join("\n");
}

/**
 * Inspect a payload for accounting or failure signals. Returns the usage when
 * the payload carries a complete one; throws when the provider reports an
 * error inside a 200 stream.
 */
function observePayload(payload: string): UpstreamUsage | null {
	if (payload === SSE_DONE_MARKER) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload) as unknown;
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	if (record[ERROR_KEY] !== undefined) {
		throw new UpstreamError(HTTP_BAD_GATEWAY, describeError(record[ERROR_KEY], "upstream error"));
	}
	return readUsage(record[USAGE_KEY]);
}

function readUsage(value: unknown): UpstreamUsage | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const promptTokens = readTokenCount(record[PROMPT_TOKENS_KEY]);
	const completionTokens = readTokenCount(record[COMPLETION_TOKENS_KEY]);
	if (promptTokens === null || completionTokens === null) {
		return null;
	}
	return { completionTokens, promptTokens };
}

function readTokenCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		return null;
	}
	return value;
}
