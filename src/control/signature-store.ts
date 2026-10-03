import type { FSWatcher } from "node:fs";
import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import type { FeedError, SignatureFeed } from "#/control/signatures.ts";
import { parseSignatureFeed } from "#/control/signatures.ts";

export interface SignatureStoreSnapshot {
	errors: FeedError[];
	feed: SignatureFeed;
	ok: boolean;
}

export interface SignatureStore {
	close(): void;
	reload(): SignatureStoreSnapshot;
	snapshot(): SignatureStoreSnapshot;
}

export interface SignatureStoreOptions {
	watch?: boolean;
}

function unreadable(message: string, fallback: SignatureFeed | null): SignatureStoreSnapshot {
	return {
		errors: [{ entryId: null, message }],
		feed: fallback ?? { signatures: [], version: "unavailable" },
		ok: false,
	};
}

export function createSignatureStore(
	filePath: string,
	options: SignatureStoreOptions = {},
): SignatureStore {
	let lastGood: SignatureFeed | null = null;
	let state: SignatureStoreSnapshot = {
		errors: [],
		feed: { signatures: [], version: "unavailable" },
		ok: false,
	};
	let watcher: FSWatcher | null = null;

	function read(): SignatureStoreSnapshot {
		let text: string;
		try {
			text = readFileSync(filePath, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : "unreadable feed";
			return unreadable(message, lastGood);
		}
		const parsed = parseSignatureFeed(text);
		if (!parsed.documentOk) {
			const first = parsed.errors[0];
			return unreadable(first?.message ?? "invalid feed document", lastGood);
		}
		lastGood = parsed.feed;
		return { errors: parsed.errors, feed: parsed.feed, ok: true };
	}

	function reload(): SignatureStoreSnapshot {
		const next = read();
		state =
			next.errors.length > 0 && next.feed.signatures.length === 0
				? { errors: next.errors, feed: state.feed, ok: false }
				: next;
		return state;
	}

	state = read();

	if (options.watch === true) {
		const fileName = basename(filePath);
		watcher = watch(
			dirname(filePath),
			{ encoding: "utf8", persistent: false },
			(_event, changed) => {
				if (changed === null || changed === fileName) {
					reload();
				}
			},
		);
	}

	return {
		close() {
			watcher?.close();
			watcher = null;
		},
		reload,
		snapshot() {
			return state;
		},
	};
}
