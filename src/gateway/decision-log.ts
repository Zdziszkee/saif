/**
 * Pure decision-line formatter for gateway turn observability.
 *
 * Builds one compact single-line summary per completed turn for live stdout:
 * `ts=.. user=.. group=.. dir=.. model=.. outcome=.. blocking=.. hits=..
 * semantic=.. budget=.. upstream=..`. Segments keep a stable compact order and
 * optional segments are omitted when absent, so `grep` for `outcome=block`,
 * `flagged`, `redact`, `escalate`, or `upstream-failure` always matches the
 * same shape.
 *
 * The function is pure and testable: it returns the line and never logs; the
 * parent writes it to stdout after settlement. Raw prompts are never accepted
 * or emitted — only structured counts plus truncated single-line evidence.
 * Unknown or malformed fields degrade to `unknown`/`invalid` instead of
 * throwing, and `score` is read defensively (only some `ControlHit` shapes
 * carry it) without affecting verdict rendering.
 */

import type { Direction, Verdict } from "#/control/types.ts";
import { isVerdict } from "#/control/types.ts";
import { isOneOf } from "#/lib/guards.ts";

const COST_FRACTION_DIGITS = 6;
const DIRECTIONS: readonly Direction[] = ["inbound", "outbound"];
const EMPTY_HITS_TOKEN = "none";
const FALLBACK_TIMESTAMP = "unknown";
const FLAGGED_MARKER = "flagged";
const FLAG_OUTCOME = "flag";
const INVALID_TOKEN = "invalid";
const KNOWN_UPSTREAM_FAILURE = "upstream-failure";
const KNOWN_UPSTREAM_OK = "ok";
const MAX_DETAIL_LENGTH = 160;
const MAX_HITS_RENDERED = 12;
const MAX_ID_LENGTH = 64;
const MAX_MODEL_LENGTH = 80;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_UPSTREAM_DETAIL_LENGTH = 160;
const QUOTE_PATTERN = /"/gu;
const QUOTE_REPLACEMENT = "'";
const SCORE_FRACTION_DIGITS = 4;
const SINGLE_LINE_PATTERN = /[\r\n\t]+/gu;
const SINGLE_LINE_REPLACEMENT = " ";
const TRAILING_DOT_PATTERN = /\.$/u;
const TRAILING_ZEROS_PATTERN = /0+$/u;
const TRUNCATION_MARKER = "...";
const UNKNOWN_TOKEN = "unknown";
const UNSAFE_TOKEN_PATTERN = /[^A-Za-z0-9._:+-]/gu;
const UNSAFE_TOKEN_REPLACEMENT = "_";

/** Wire keys read from decision input (string access, never identifiers). */
const BLOCKING_CONTROL_KEY = "blockingControl";
const BUDGET_KEY = "budget";
const COMPLETION_TOKENS_KEY = "completionTokens";
const CONTROL_ID_KEY = "controlId";
const COST_USD_KEY = "costUsd";
const DETAIL_KEY = "detail";
const DIRECTION_KEY = "direction";
const FLAGGED_KEY = "flagged";
const GROUP_ID_KEY = "groupId";
const HITS_KEY = "hits";
const KIND_KEY = "kind";
const MODEL_KEY = "model";
const OUTCOME_KEY = "outcome";
const PROMPT_TOKENS_KEY = "promptTokens";
const SCORE_KEY = "score";
const SEMANTIC_DETAIL_KEY = "semanticDetail";
const STATUS_KEY = "status";
const TIMESTAMP_KEY = "timestamp";
const UPSTREAM_KEY = "upstream";
const USER_ID_KEY = "userId";
const VERDICT_KEY = "verdict";

type DecisionOutcome = Verdict | "flag" | "unknown" | "upstream-failure";

export interface DecisionLogBudget {
	readonly completionTokens?: unknown;
	readonly costUsd?: unknown;
	readonly outcome?: unknown;
	readonly promptTokens?: unknown;
}

export interface DecisionLogHit {
	readonly controlId?: unknown;
	readonly detail?: unknown;
	readonly kind?: unknown;
	readonly score?: unknown;
	readonly verdict?: unknown;
}

export interface DecisionLogInput {
	readonly blockingControl?: unknown;
	readonly budget?: DecisionLogBudget | undefined;
	readonly direction?: unknown;
	readonly flagged?: unknown;
	readonly groupId: unknown;
	readonly hits?: readonly DecisionLogHit[] | undefined;
	readonly model?: unknown;
	readonly outcome: unknown;
	readonly semanticDetail?: unknown;
	readonly timestamp?: unknown;
	readonly upstream?: DecisionLogUpstream | undefined;
	readonly userId: unknown;
}

export interface DecisionLogUpstream {
	readonly detail?: unknown;
	readonly outcome?: unknown;
	readonly status?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readText(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}${TRUNCATION_MARKER}`;
}

function readOptionalToken(value: unknown, maxLength: number): string | null {
	const text = readText(value);
	if (text === null) {
		return null;
	}
	const cleaned = text.replace(UNSAFE_TOKEN_PATTERN, UNSAFE_TOKEN_REPLACEMENT);
	return truncateText(cleaned, maxLength);
}

function sanitizeToken(value: unknown, maxLength: number): string {
	return readOptionalToken(value, maxLength) ?? UNKNOWN_TOKEN;
}

function sanitizeLine(value: unknown, maxLength: number): string | null {
	const text = readText(value);
	if (text === null) {
		return null;
	}
	const singleLine = text.replace(SINGLE_LINE_PATTERN, SINGLE_LINE_REPLACEMENT).trim();
	if (singleLine.length === 0) {
		return null;
	}
	return truncateText(singleLine, maxLength);
}

function quoteText(text: string): string {
	return `"${text.replace(QUOTE_PATTERN, QUOTE_REPLACEMENT)}"`;
}

function readFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function readTokenCount(value: unknown): number | null {
	const count = readFiniteNumber(value);
	if (count === null || !Number.isInteger(count) || count < 0) {
		return null;
	}
	return count;
}

function readHitScore(hit: Record<string, unknown> | null): number | null {
	const score = hit?.[SCORE_KEY];
	return readFiniteNumber(score);
}

function trimTrailingZeros(fixed: string): string {
	if (!fixed.includes(".")) {
		return fixed;
	}
	const trimmed = fixed.replace(TRAILING_ZEROS_PATTERN, "").replace(TRAILING_DOT_PATTERN, "");
	return trimmed.length > 0 ? trimmed : "0";
}

function formatScore(score: number): string {
	return trimTrailingZeros(score.toFixed(SCORE_FRACTION_DIGITS));
}

function formatCost(value: unknown): string {
	if (value === null || value === undefined) {
		return "unpriced";
	}
	const cost = readFiniteNumber(value);
	if (cost === null) {
		return "unpriced";
	}
	return trimTrailingZeros(cost.toFixed(COST_FRACTION_DIGITS));
}

function formatOutcome(value: unknown): DecisionOutcome {
	if (typeof value !== "string") {
		return UNKNOWN_TOKEN;
	}
	const text = value.trim();
	if (isVerdict(text)) {
		return text;
	}
	if (text === FLAG_OUTCOME || text === KNOWN_UPSTREAM_FAILURE) {
		return text;
	}
	return UNKNOWN_TOKEN;
}

function formatDirection(value: unknown): Direction | null {
	if (typeof value !== "string") {
		return null;
	}
	const text = value.trim();
	return isOneOf(text, DIRECTIONS) ? text : null;
}

function formatTimestamp(value: unknown): string {
	return readOptionalToken(value, MAX_TIMESTAMP_LENGTH) ?? FALLBACK_TIMESTAMP;
}

function toHitRecord(entry: unknown): Record<string, unknown> | null {
	return isRecord(entry) ? entry : null;
}

function formatHitScore(hit: Record<string, unknown>): string {
	const score = readHitScore(hit);
	if (score === null) {
		return "";
	}
	return ` score=${formatScore(score)}`;
}

function formatHitDetail(detail: unknown): string {
	const text = sanitizeLine(detail, MAX_DETAIL_LENGTH);
	if (text === null) {
		return "";
	}
	return ` ${quoteText(text)}`;
}

function formatHit(hit: Record<string, unknown>): string {
	const control = sanitizeToken(hit[CONTROL_ID_KEY], MAX_ID_LENGTH);
	const kind = sanitizeToken(hit[KIND_KEY], MAX_ID_LENGTH);
	const verdict = formatOutcome(hit[VERDICT_KEY]);
	return `${control}/${kind}:${verdict}${formatHitScore(hit)}${formatHitDetail(hit[DETAIL_KEY])}`;
}

function formatHits(value: unknown): string {
	if (value === undefined) {
		return EMPTY_HITS_TOKEN;
	}
	if (!Array.isArray(value)) {
		return INVALID_TOKEN;
	}
	const items: unknown[] = value;
	if (items.length === 0) {
		return EMPTY_HITS_TOKEN;
	}
	const rendered: string[] = [];
	for (const entry of items) {
		if (rendered.length >= MAX_HITS_RENDERED) {
			break;
		}
		const hit = toHitRecord(entry);
		if (hit !== null) {
			rendered.push(formatHit(hit));
		}
	}
	if (rendered.length === 0) {
		return EMPTY_HITS_TOKEN;
	}
	const overflow = items.length - rendered.length;
	const renderedCount = rendered.length;
	const suffix = overflow > 0 ? `+${String(overflow)}-more` : "";
	return `${String(renderedCount)}:${rendered.join(",")}${suffix}`;
}

function formatUpstreamOutcome(value: unknown): string {
	const text = readText(value);
	if (text === null) {
		return UNKNOWN_TOKEN;
	}
	const lowered = text.toLowerCase();
	if (lowered.includes("failure") || lowered === "error") {
		return KNOWN_UPSTREAM_FAILURE;
	}
	if (lowered === KNOWN_UPSTREAM_OK || lowered === "success" || lowered === "sent") {
		return KNOWN_UPSTREAM_OK;
	}
	return sanitizeToken(text, MAX_ID_LENGTH);
}

function appendDirectionModel(parts: string[], source: Record<string, unknown>): void {
	const direction = formatDirection(source[DIRECTION_KEY]);
	if (direction !== null) {
		parts.push(`dir=${direction}`);
	}
	const model = readOptionalToken(source[MODEL_KEY], MAX_MODEL_LENGTH);
	if (model !== null) {
		parts.push(`model=${model}`);
	}
}

function appendOutcome(parts: string[], source: Record<string, unknown>): void {
	const outcome = formatOutcome(source[OUTCOME_KEY]);
	const flagged = source[FLAGGED_KEY] === true ? `+${FLAGGED_MARKER}` : "";
	parts.push(`outcome=${outcome}${flagged}`);
	const blocking = readOptionalToken(source[BLOCKING_CONTROL_KEY], MAX_ID_LENGTH);
	if (blocking !== null) {
		parts.push(`blocking=${blocking}`);
	}
}

function appendHits(parts: string[], source: Record<string, unknown>): void {
	parts.push(`hits=${formatHits(source[HITS_KEY])}`);
}

function appendSemantic(parts: string[], source: Record<string, unknown>): void {
	const detail = sanitizeLine(source[SEMANTIC_DETAIL_KEY], MAX_DETAIL_LENGTH);
	if (detail !== null) {
		parts.push(`semantic=${quoteText(detail)}`);
	}
}

function appendBudget(parts: string[], source: Record<string, unknown>): void {
	const value = source[BUDGET_KEY];
	if (value === undefined || !isRecord(value)) {
		return;
	}
	const promptTokens = readTokenCount(value[PROMPT_TOKENS_KEY]);
	const completionTokens = readTokenCount(value[COMPLETION_TOKENS_KEY]);
	const hasUsage = promptTokens !== null || completionTokens !== null;
	const outcome = readOptionalToken(value[OUTCOME_KEY], MAX_ID_LENGTH) ?? UNKNOWN_TOKEN;
	const reported = outcome === UNKNOWN_TOKEN && hasUsage ? KNOWN_UPSTREAM_OK : outcome;
	parts.push(`budget=${reported}`);
	if (promptTokens !== null && completionTokens !== null) {
		const total = promptTokens + completionTokens;
		parts.push(`tokens=${String(promptTokens)}+${String(completionTokens)}=${String(total)}`);
	} else if (hasUsage) {
		const single = promptTokens ?? completionTokens ?? 0;
		parts.push(`tokens=${String(single)}`);
	}
	if (COST_USD_KEY in value) {
		parts.push(`cost=${formatCost(value[COST_USD_KEY])}`);
	}
}

function appendUpstream(parts: string[], source: Record<string, unknown>): void {
	const value = source[UPSTREAM_KEY];
	if (value === undefined || !isRecord(value)) {
		return;
	}
	parts.push(`upstream=${formatUpstreamOutcome(value[OUTCOME_KEY])}`);
	const status = readTokenCount(value[STATUS_KEY]);
	if (status !== null) {
		parts.push(`status=${String(status)}`);
	}
	const detail = sanitizeLine(value[DETAIL_KEY], MAX_UPSTREAM_DETAIL_LENGTH);
	if (detail !== null) {
		parts.push(`upstream-detail=${quoteText(detail)}`);
	}
}

/**
 * Format one compact decision line for a completed gateway turn. Pure: no
 * logging, no clock reads — the caller supplies `timestamp` and writes the
 * returned line to stdout.
 */
export function formatDecisionLine(input: DecisionLogInput): string {
	const source: Record<string, unknown> = isRecord(input) ? input : {};
	const parts: string[] = [];
	parts.push(`ts=${formatTimestamp(source[TIMESTAMP_KEY])}`);
	parts.push(`user=${sanitizeToken(source[USER_ID_KEY], MAX_ID_LENGTH)}`);
	parts.push(`group=${sanitizeToken(source[GROUP_ID_KEY], MAX_ID_LENGTH)}`);
	appendDirectionModel(parts, source);
	appendOutcome(parts, source);
	appendHits(parts, source);
	appendSemantic(parts, source);
	appendBudget(parts, source);
	appendUpstream(parts, source);
	return parts.join(" ");
}
