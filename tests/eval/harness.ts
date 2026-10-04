/**
 * Shared harness for the judge-facing evaluation suite (`tests/eval/`).
 *
 * Every scenario runs against the SHIPPED artifacts — `policy.json` and
 * `signatures.json` — through the same stages the product hub wires
 * (deterministic builtins first, signature feed second), so the suite
 * proves the behavior judges will see on a stock checkout. Tests that
 * rehearse configuration edits start from a deep clone of the shipped
 * controls and rebuild the pipeline, never touching the repo files.
 */

import type { AuditSink } from "#/control/audit.ts";
import { createInMemoryAuditSink } from "#/control/audit.ts";
import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { detectionConfigSchema } from "#/control/policy/schema.ts";
import type { SignatureAction } from "#/control/signatures/control.ts";
import { createSignatureControl } from "#/control/signatures/control.ts";
import type { SignatureFeed, SignatureSeverity } from "#/control/signatures/feed.ts";
import { loadSignatureFeed } from "#/control/signatures/feed.ts";
import { USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline } from "#/control/types.ts";
import policyDocument from "../../policy.json" with { type: "json" };
import feedDocument from "../../signatures.json" with { type: "json" };
import { identityResolver } from "../helpers/fixtures.ts";

export interface EvalHit {
	control: string;
	engine: string;
	kind: string;
}

export interface EvalBody {
	content?: string;
	control?: string;
	error?: string;
	flagged?: boolean;
	hits?: EvalHit[];
	reasons?: string[];
	verdict?: string;
}

const SEVERITIES: readonly SignatureSeverity[] = ["critical", "high", "low", "medium"];

interface ShippedControls {
	detection: Parameters<typeof createDeterministicControl>[0];
	signatures: {
		enabled: boolean;
		perSignatureActions: Partial<Record<string, SignatureAction>>;
		severityActions: Record<SignatureSeverity, SignatureAction>;
	};
}

function shippedControls(): ShippedControls {
	const policy = structuredClone(policyDocument) as unknown as {
		controls: {
			detection: unknown;
			signatures: ShippedControls["signatures"];
		};
	};
	const detection = detectionConfigSchema.safeParse(policy.controls.detection);
	if (!detection.success) {
		throw new Error("shipped policy.json detection section failed validation");
	}
	const severityActions = {} as Record<SignatureSeverity, SignatureAction>;
	for (const severity of SEVERITIES) {
		const action = policy.controls.signatures.severityActions[severity];
		if (action === undefined) {
			throw new Error(`shipped policy.json lacks severity action for ${severity}`);
		}
		severityActions[severity] = action;
	}
	return {
		detection: detection.data,
		signatures: {
			enabled: policy.controls.signatures.enabled,
			perSignatureActions: { ...policy.controls.signatures.perSignatureActions },
			severityActions,
		},
	};
}

export interface EvalPipelineOptions {
	feedDocument?: unknown;
	perSignatureActions?: Partial<Record<string, SignatureAction>> | undefined;
	severityActions?: Partial<Record<SignatureSeverity, SignatureAction>> | undefined;
	signaturesEnabled?: boolean | undefined;
}

export function buildEvalPipeline(options: EvalPipelineOptions = {}): ControlPipeline {
	const controls = shippedControls();
	const loaded = loadSignatureFeed(options.feedDocument ?? feedDocument);
	if (loaded.entries.length === 0) {
		throw new Error("evaluation feed has no usable entries");
	}
	const feed: SignatureFeed = { entries: loaded.entries, version: loaded.version };
	return createControlPipeline({
		controls: [
			createDeterministicControl(controls.detection),
			createSignatureControl({
				config: {
					enabled: options.signaturesEnabled ?? controls.signatures.enabled,
					perSignatureActions: {
						...controls.signatures.perSignatureActions,
						...options.perSignatureActions,
					},
					severityActions: { ...controls.signatures.severityActions, ...options.severityActions },
				},
				getFeed: () => feed,
			}),
		],
	});
}

export interface EvalRequestOptions {
	audit?: AuditSink | undefined;
	direction?: string | undefined;
	groupId?: string | undefined;
	model?: string | undefined;
	pipeline?: ControlPipeline | undefined;
	seam?: string | undefined;
	userId?: string | undefined;
}

export async function evaluate(
	content: string,
	options: EvalRequestOptions = {},
): Promise<{ audit: AuditSink & { events: { kind?: string }[] }; body: EvalBody; status: number }> {
	const audit = (options.audit ?? createInMemoryAuditSink()) as AuditSink & {
		events: { kind?: string }[];
	};
	const headers = new Headers({ "content-type": "application/json" });
	headers.set(USER_ID_HEADER, options.userId ?? "eval-user");
	headers.set(USER_GROUP_ID_HEADER, options.groupId ?? "hr");
	const response = await handleGuardRequest(
		new Request("http://test.local/api/guard", {
			body: JSON.stringify({
				content,
				direction: options.direction ?? "inbound",
				model: options.model,
				seam: options.seam ?? "guard-api",
			}),
			headers,
			method: "POST",
		}),
		{
			audit,
			identity: identityResolver(),
			pipeline: options.pipeline ?? buildEvalPipeline(),
		},
	);
	return { audit, body: (await response.json()) as EvalBody, status: response.status };
}
