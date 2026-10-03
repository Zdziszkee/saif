import { createHmac } from "node:crypto";

import type { Detection, DetectionType } from "#/control/detectors.ts";

const TokenLength = 12;

export interface PiiVault {
	entries(): ReadonlyMap<string, string>;
	tokenFor(type: DetectionType, value: string): string;
	untokenize(text: string): string;
}

const tokenPattern = /\[([A-Z][A-Z0-9_]*):([0-9a-f]{12})\]/gu;
const hyphenRun = /-/gu;

export function createPiiVault(secret: string): PiiVault {
	const store = new Map<string, string>();

	function tokenFor(type: DetectionType, value: string): string {
		const digest = createHmac("sha256", secret).update(`${type}\u0000${value}`).digest("hex");
		const token = digest.slice(0, TokenLength);
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

export function tokenizeSpans(
	text: string,
	detections: readonly Detection[],
	vault: PiiVault,
): string {
	const ordered = [...detections].sort((a, b) => b.span.start - a.span.start);
	let result = text;
	for (const detection of ordered) {
		const token = vault.tokenFor(detection.type, detection.value);
		result = result.slice(0, detection.span.start) + token + result.slice(detection.span.end);
	}
	return result;
}
