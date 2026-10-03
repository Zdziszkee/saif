import { createHmac } from "node:crypto";

import type { Detection, DetectionType } from "#/control/detectors.ts";
import { applyRedactions, type RedactionOp } from "#/control/redact.ts";

const TokenLength = 12;
const DefaultMaxEntries = 10_000;

export interface PiiVaultOptions {
	maxEntries?: number;
}

export interface PiiVault {
	entries(): ReadonlyMap<string, string>;
	tokenFor(type: DetectionType, value: string): string;
	untokenize(text: string): string;
}

const tokenPattern = /\[([A-Z][A-Z0-9_]*):([0-9a-f]{12})\]/gu;
const hyphenRun = /-/gu;

export function createPiiVault(secret: string, options: PiiVaultOptions = {}): PiiVault {
	const maxEntries = options.maxEntries ?? DefaultMaxEntries;
	const store = new Map<string, string>();

	function tokenFor(type: DetectionType, value: string): string {
		const digest = createHmac("sha256", secret).update(`${type}\u0000${value}`).digest("hex");
		const token = digest.slice(0, TokenLength);
		if (!store.has(token) && store.size >= maxEntries) {
			const oldest = store.keys().next();
			if (!oldest.done) {
				store.delete(oldest.value);
			}
		}
		store.set(token, value);
		return `[${type.toUpperCase().replace(hyphenRun, "_")}:${token}]`;
	}

	return {
		entries() {
			return store;
		},
		tokenFor,
		untokenize(text: string): string {
			return text.replace(tokenPattern, (whole, _kind: string, token: string) => {
				const original = store.get(token);
				return original === undefined ? whole : original;
			});
		},
	};
}

export function detectionTokenOps(
	detections: readonly Detection[],
	vault: PiiVault,
): RedactionOp[] {
	return [...detections]
		.sort((a, b) => a.span.start - b.span.start)
		.map((detection) => ({
			end: detection.span.end,
			start: detection.span.start,
			text: vault.tokenFor(detection.type, detection.value),
		}));
}

export function tokenizeSpans(
	text: string,
	detections: readonly Detection[],
	vault: PiiVault,
): string {
	return applyRedactions(text, detectionTokenOps(detections, vault));
}
