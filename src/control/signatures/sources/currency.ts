/**
 * Feed currency polling (task 5.9).
 *
 * Conditional-GET refresh for remote snapshot documents: ETag and
 * Last-Modified validators go out, 304 means unchanged, 200 replaces the
 * document, and any failure keeps the last-known-good state untouched so a
 * source outage can never empty the feed. The vendored `data/feeds/`
 * snapshots are the offline fallback at the end of that chain.
 *
 * Pure logic over an injected `fetch` — no timers live here, so unit tests
 * run hermetic and a future scheduler owns interval lifecycle.
 */

export interface RemoteSource {
	name: string;
	url: string;
}

/** Minimal fetch surface the poller needs — the global fetch satisfies it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Per-source refresh state, held by the caller across polls. */
export interface SourceState {
	etag: string | null;
	failures: number;
	lastModified: string | null;
	lastOkAt: string | null;
}

export interface PollOutcome {
	doc: unknown;
	error?: string | undefined;
	state: SourceState;
	status: "changed" | "failed" | "unchanged";
}

export const DEFAULT_POLL_TIMEOUT_MS = 10_000;

const HTTP_NOT_MODIFIED = 304;

export function initialSourceState(): SourceState {
	return { etag: null, failures: 0, lastModified: null, lastOkAt: null };
}

function touched(state: SourceState, ok: boolean, now: string): SourceState {
	return {
		etag: state.etag,
		failures: ok ? 0 : state.failures + 1,
		lastModified: state.lastModified,
		lastOkAt: ok ? now : state.lastOkAt,
	};
}

function failed(state: SourceState, reason: string): PollOutcome {
	return { doc: undefined, error: reason, state: touched(state, false, ""), status: "failed" };
}

function timed<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`poll timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	});
}

/**
 * Poll one source with conditional validators. Never throws: every outcome
 * (changed / unchanged / failed) carries the state to persist for next time.
 */
export async function pollSource(
	source: RemoteSource,
	state: SourceState,
	fetchImpl: FetchLike = fetch,
	timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<PollOutcome> {
	const headers: Record<string, string> = {};
	if (state.etag !== null) {
		headers["If-None-Match"] = state.etag;
	}
	if (state.lastModified !== null) {
		headers["If-Modified-Since"] = state.lastModified;
	}
	let response: Response;
	try {
		response = await timed(fetchImpl(source.url, { headers }), timeoutMs);
	} catch (error) {
		return failed(state, error instanceof Error ? error.message : String(error));
	}
	if (response.status === HTTP_NOT_MODIFIED) {
		return {
			doc: undefined,
			state: touched(state, true, new Date().toISOString()),
			status: "unchanged",
		};
	}
	if (!response.ok) {
		return failed(state, `unexpected status ${response.status}`);
	}
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		return failed(state, error instanceof Error ? error.message : String(error));
	}
	let doc: unknown;
	try {
		doc = JSON.parse(text) as unknown;
	} catch {
		return failed(state, "response is not JSON");
	}
	const etag = response.headers.get("etag");
	const lastModified = response.headers.get("last-modified");
	return {
		doc,
		state: {
			etag: etag ?? state.etag,
			failures: 0,
			lastModified: lastModified ?? state.lastModified,
			lastOkAt: new Date().toISOString(),
		},
		status: "changed",
	};
}

/**
 * Poll every source, persisting per-source state into the caller's map.
 * Failures never disturb other sources or previously stored validators.
 */
export async function pollAll(
	sources: readonly RemoteSource[],
	states: Map<string, SourceState>,
	fetchImpl: FetchLike,
	timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<Map<string, PollOutcome>> {
	const outcomes = new Map<string, PollOutcome>();
	for (const source of sources) {
		// biome-ignore lint/performance/noAwaitInLoops: sources poll sequentially so per-source state stays ordered and upstreams are never hammered in parallel
		const outcome = await pollSource(
			source,
			states.get(source.name) ?? initialSourceState(),
			fetchImpl,
			timeoutMs,
		);
		states.set(source.name, outcome.state);
		outcomes.set(source.name, outcome);
	}
	return outcomes;
}
