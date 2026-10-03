import type { FSWatcher } from "node:fs";
import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import type { FeedError, SignatureFeed } from "#/control/signatures.ts";
import { parseSignatureFeed } from "#/control/signatures.ts";

export interface SignatureStoreSnapshot {
	errors: FeedError[];
	feed: SignatureFeed;
}

export interface SignatureStore {
	close(): void;
	reload(): SignatureStoreSnapshot;
	snapshot(): SignatureStoreSnapshot;
}

export interface SignatureStoreOptions {
	watch?: boolean;
}

export function createSignatureStore(
	filePath: string,
	options: SignatureStoreOptions = {},
): SignatureStore {
	let state = read();
	let watcher: FSWatcher | null = null;

	function read(): SignatureStoreSnapshot {
		try {
			const text = readFileSync(filePath, "utf8");
			const parsed = parseSignatureFeed(text);
			return { errors: parsed.errors, feed: parsed.feed };
		} catch (error) {
			const message = error instanceof Error ? error.message : "unreadable feed";
			return {
				errors: [{ entryId: null, message }],
				feed: { signatures: [], version: "unavailable" },
			};
		}
	}

	function reload(): SignatureStoreSnapshot {
		state = read();
		return state;
	}

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
