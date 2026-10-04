/**
 * Mock Jev decision service for local semantic-tier testing.
 *
 * Stands in for TypeSafe's `POST /v1/systemone` with a deterministic,
 * documented heuristic: each known check family scores content keywords and
 * returns a calibrated-looking probability. It is deliberately dumber than
 * the real model — it exists so the semantic tier, the pipeline, and the
 * playground can run end to end with no API key:
 *
 *   TYPESAFE_API_KEY=test-key TYPESAFE_BASE_URL=http://localhost:4321 bun run dev
 *   bun run mock:jev   # (separate terminal, :4321)
 *
 * Judges can retune the heuristic without touching code: point
 * `MOCK_JEV_CONFIG` at a JSON file shaped like
 * `data/mock-jev-keywords.json` (a config key scores every check whose id
 * contains it, so exact check ids and fragments both work). The file loads
 * once at startup — restart the mock after editing it. An explicit path
 * that is missing or invalid fails fast instead of silently scoring wrong.
 *
 * Accepts any API key. Never use it for real verdicts.
 */

import { readFileSync } from "node:fs";

export interface MockJevQuestion {
	instructions?: unknown;
	type?: unknown;
}

export interface MockJevRequest {
	model?: unknown;
	questions?: Record<string, unknown> | undefined;
	state?: { content?: unknown } | undefined;
}

export interface MockJevAnswer {
	noul: number;
	type: "noul";
}

const BASE_PROBABILITY = 0.05;
const HIT_PROBABILITY = 0.45;
const MAX_PROBABILITY = 0.98;
const OUTPUT_TOKENS_PER_QUESTION = 3;
const PROBABILITY_DECIMALS = 2;
const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 1;

const CHECK_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
	[
		"inject",
		[
			"ignore",
			"previous instructions",
			"system prompt",
			"unrestricted",
			"bypass",
			"jailbreak",
			"dan",
			"developer mode",
			"reveal",
			"act as",
			"forget",
			"disregard",
		],
	],
	[
		"jailbreak",
		[
			"dan",
			"bypass",
			"unrestricted",
			"jailbreak",
			"developer mode",
			"no restrictions",
			"act as",
			"do anything",
		],
	],
	[
		"malicious",
		[
			"bomb",
			"explod",
			"wire",
			"malware",
			"ransomware",
			"exploit",
			"kill",
			"murder",
			"poison",
			"weapon",
		],
	],
	[
		"exfiltrat",
		["password", "secret", "api key", "ssn", "credit card", "credentials", ".env", "token"],
	],
	["privacy", ["email", "ssn", "@", "phone", "address", "date of birth", "passport"]],
	["insider", ["insider", "merger", "acquisition", "earnings", "non-public", "material"]],
]);

/** Tunable scoring: base P, per-hit addend, ceiling, and check-keyword map. */
export interface MockJevScoringConfig {
	base: number;
	checks: Record<string, readonly string[]>;
	hit: number;
	max: number;
}

export const DEFAULT_MOCK_JEV_SCORING: MockJevScoringConfig = {
	base: BASE_PROBABILITY,
	checks: Object.fromEntries(CHECK_KEYWORDS),
	hit: HIT_PROBABILITY,
	max: MAX_PROBABILITY,
};

function keywordsFor(
	checkId: string,
	checks: Record<string, readonly string[]>,
): readonly string[] {
	const id = checkId.toLowerCase();
	const words: string[] = [];
	for (const [fragment, keywords] of Object.entries(checks)) {
		if (fragment.length > 0 && id.includes(fragment.toLowerCase())) {
			words.push(...keywords);
		}
	}
	return words;
}

/** Deterministic heuristic score for one check over content. Pure and tested. */
export function scoreMockContent(
	content: string,
	checkId: string,
	scoring: MockJevScoringConfig = DEFAULT_MOCK_JEV_SCORING,
): number {
	const keywords = keywordsFor(checkId, scoring.checks);
	if (keywords.length === 0) {
		return scoring.base;
	}
	const lowered = content.toLowerCase();
	let hits = 0;
	for (const keyword of keywords) {
		if (lowered.includes(keyword)) {
			hits += 1;
		}
	}
	const probability = scoring.base + hits * scoring.hit;
	return Number(Math.min(probability, scoring.max).toFixed(PROBABILITY_DECIMALS));
}

export interface MockJevResponse {
	answers: Record<string, MockJevAnswer>;
	model: string;
	usage: { input_tokens: number; output_tokens: number };
}

export function buildMockJevResponse(
	content: string,
	questions: Record<string, unknown>,
	model: unknown,
	scoring: MockJevScoringConfig = DEFAULT_MOCK_JEV_SCORING,
): MockJevResponse {
	const answers: Record<string, MockJevAnswer> = {};
	for (const checkId of Object.keys(questions)) {
		answers[checkId] = { noul: scoreMockContent(content, checkId, scoring), type: "noul" };
	}
	return {
		answers,
		model: typeof model === "string" && model.length > 0 ? model : "mock-jev",
		usage: {
			input_tokens: content.length,
			output_tokens: Object.keys(questions).length * OUTPUT_TOKENS_PER_QUESTION,
		},
	};
}

function readStateContent(state: unknown): string {
	if (typeof state === "object" && state !== null) {
		const content = (state as { content?: unknown }).content;
		if (typeof content === "string") {
			return content;
		}
	}
	return "";
}

function invalid(reason: string): never {
	throw new Error(`mock-jev config invalid: ${reason}`);
}

function probabilityField(root: Record<string, unknown>, name: string, fallback: number): number {
	const value = root[name] ?? fallback;
	if (
		typeof value !== "number" ||
		Number.isNaN(value) ||
		value < PROBABILITY_MIN ||
		value > PROBABILITY_MAX
	) {
		invalid(`${name} must be a number between 0 and 1`);
	}
	return value;
}

/**
 * Validate a judges' keyword-map config (`data/mock-jev-keywords.json`
 * shows the shape). Omitted tuning knobs fall back to the built-ins;
 * anything misshapen fails with the exact path to the problem.
 */
export function parseMockJevScoringConfig(input: unknown): MockJevScoringConfig {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		invalid("expected a JSON object with a checks map");
	}
	const root = input as Record<string, unknown>;
	const base = probabilityField(root, "base", BASE_PROBABILITY);
	const hit = probabilityField(root, "hit", HIT_PROBABILITY);
	const max = probabilityField(root, "max", MAX_PROBABILITY);
	if (base > max) {
		invalid(`base (${base}) must not exceed max (${max})`);
	}
	// biome-ignore lint/complexity/useLiteralKeys: dot access trips noPropertyAccessFromIndexSignature on the index signature
	const checks = parseChecksMap(root["checks"]);
	return { base, checks, hit, max };
}

function parseChecksMap(rawChecks: unknown): Record<string, string[]> {
	if (typeof rawChecks !== "object" || rawChecks === null || Array.isArray(rawChecks)) {
		invalid("checks must be an object mapping check names to keyword arrays");
	}
	const checks: Record<string, string[]> = {};
	for (const [name, keywords] of Object.entries(rawChecks as Record<string, unknown>)) {
		if (name.length === 0) {
			invalid("check names must be non-empty strings");
		}
		if (!Array.isArray(keywords)) {
			invalid(`checks.${name} must be an array of keywords`);
		}
		const words: string[] = [];
		for (const keyword of keywords) {
			if (typeof keyword !== "string" || keyword.length === 0) {
				invalid(`checks.${name} keywords must be non-empty strings`);
			}
			words.push(keyword);
		}
		checks[name] = words;
	}
	return checks;
}

/**
 * Load the scoring config for the mock server. No path means the built-in
 * keywords; an explicit path that cannot be read or parsed fails fast so a
 * typo never silently scores the wrong verdicts.
 */
export function loadMockJevScoringConfig(path: string | undefined): MockJevScoringConfig {
	if (path === undefined || path.length === 0) {
		return DEFAULT_MOCK_JEV_SCORING;
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`mock-jev config file unreadable: ${path}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(`mock-jev config file is not valid JSON: ${path}`, { cause: error });
	}
	try {
		return parseMockJevScoringConfig(parsed);
	} catch (error) {
		throw new Error(`mock-jev config file rejected: ${path}`, { cause: error });
	}
}

const DEFAULT_MOCK_JEV_PORT = 4321;
// Fixed per-request latency: keeps the concurrency integration assertion
// meaningful (non-zero per-call timings that overlap when concurrent) and
// mimics a network round trip for interactive use.
const MOCK_JEV_LATENCY_MS = 50;
const { MOCK_JEV_CONFIG, MOCK_JEV_PORT } = process.env;
const port = Number(MOCK_JEV_PORT ?? DEFAULT_MOCK_JEV_PORT);

if (process.argv[1]?.endsWith("mock-jev.ts") ?? false) {
	const scoring = loadMockJevScoringConfig(MOCK_JEV_CONFIG);
	const { serve } = await import("bun");
	serve({
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method !== "POST" || url.pathname !== "/v1/systemone") {
				return new Response("mock Jev: POST /v1/systemone only", { status: 404 });
			}
			await new Promise((resolve) => setTimeout(resolve, MOCK_JEV_LATENCY_MS));
			let body: MockJevRequest | null = null;
			try {
				body = (await request.json()) as MockJevRequest;
			} catch {
				return Response.json({ error: "expected a JSON object" }, { status: 400 });
			}
			if (body === null || typeof body.questions !== "object" || body.questions === null) {
				return Response.json({ error: "expected state and questions" }, { status: 400 });
			}
			return Response.json(
				buildMockJevResponse(readStateContent(body.state), body.questions, body.model, scoring),
			);
		},
		port,
	});
	console.log(`mock Jev listening on http://localhost:${port}`);
	console.log(
		`mock Jev scoring: ${MOCK_JEV_CONFIG === undefined ? "built-in keywords" : MOCK_JEV_CONFIG}`,
	);
}
