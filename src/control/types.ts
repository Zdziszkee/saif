/**
 * Interaction-gateway contract types.
 *
 * These are the seams every enforcement surface (chat, MCP hub, guard API)
 * shares. The control stages that produce evidence (deterministic tier,
 * signature feed, semantic tier, policy mapping) plug in behind
 * {@link ControlPipeline} from their own spec modules; this module only
 * defines what flows across the boundary and how verdicts are enforced.
 */

export type Direction = "inbound" | "outbound";

export type Verdict = "allow" | "redact" | "block" | "escalate";

export type InteractionSeam = "chat" | "mcp-tool" | "guard-api";

export interface ToolCallRef {
	arguments: unknown;
	name: string;
}

export interface Interaction {
	content: string;
	direction: Direction;
	/** Policy subject: the user group the caller presented. Selects profile and checks. */
	groupId: string;
	id: string;
	model?: string | undefined;
	seam: InteractionSeam;
	tool?: ToolCallRef | undefined;
	/**
	 * The individual caller: usage limits and per-user reporting. Absent at
	 * group-scoped surfaces that identify no individual (MCP hub tool calls and
	 * tool registration); the gateway seam always sets it.
	 */
	userId?: string | undefined;
}

/** A detected sensitive span, mapped into the raw inspected content. */
export interface RedactionSpan {
	/** Detector or rule identifier that produced the span. */
	detectorId: string;
	/** Exclusive end offset in the raw content. */
	end: number;
	/** Sensitive kind, e.g. `secret`, `pii.email`. */
	kind: string;
	/** Typed placeholder replacing the span, e.g. `[EMAIL]`. */
	placeholder: string;
	/** Inclusive start offset in the raw content. */
	start: number;
}

/** One control's contribution to the evidence of an inspection. */
export interface ControlHit {
	controlId: string;
	detail?: string | undefined;
	kind: string;
	/** The control's mapped action. `flag` forwards the content but marks it for review. */
	verdict: Verdict | "flag";
}

export interface InspectionResult {
	/** Identifies the blocking control when `verdict` is `block` or `escalate`. */
	blockingControl?: string | undefined;
	/** The content as inspected (raw; redaction is applied at enforcement). */
	content: string;
	/** Set when a control failed and the failure verdict was applied. */
	failure?: string | undefined;
	/** True when a `flag`-style hit fired: forwarded but annotated for review. */
	flagged: boolean;
	hits: ControlHit[];
	redactions: RedactionSpan[];
	verdict: Verdict;
}

/** A single control stage behind the pipeline seam. */
export interface Control {
	readonly id: string;
	inspect(interaction: Interaction): ControlResult | Promise<ControlResult>;
}

export interface ControlResult {
	hit?: ControlHit | undefined;
	redactions?: RedactionSpan[] | undefined;
	verdict: Verdict;
}

/** The shared control pipeline every seam routes traffic through. */
export interface ControlPipeline {
	inspect(interaction: Interaction): Promise<InspectionResult>;
}

export const VERDICTS: readonly Verdict[] = ["allow", "redact", "block", "escalate"];

export function isVerdict(value: unknown): value is Verdict {
	return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}
