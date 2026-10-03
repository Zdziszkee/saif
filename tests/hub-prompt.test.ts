import { describe, expect, it } from "bun:test";
import { file, Glob } from "bun";
import type { Control, Interaction } from "#/control/types.ts";
import { createHub } from "#/hub/mcp-server.ts";
import { createOpenAICompatibleConnection, ModelConfigurationError } from "#/hub/model.ts";
import type { AskModelResult } from "#/hub/tools.ts";
import {
	auditSink,
	blockOn,
	modelDouble,
	pipelineWith,
	redactOn,
	staticReply,
} from "./helpers/fixtures.ts";

const MODEL_BYPASS_PATTERN = /createOpenAICompatibleConnection|#\/hub\/model\.ts/;

describe("hub prompt governance", () => {
	it("inspects the prompt inbound and the answer outbound before forwarding", async () => {
		const seen: Interaction[] = [];
		const recorder: Control = {
			id: "recorder",
			inspect: (interaction) => {
				seen.push(interaction);
				return { verdict: "allow" };
			},
		};
		const model = modelDouble(() => staticReply("plain answer"));
		const hub = await createHub({
			audit: auditSink(),
			model,
			pipeline: pipelineWith([recorder]),
		});
		seen.length = 0;

		const outcome = await hub.invokeTool("askModel", { prompt: "hello there" }, "alice");
		expect(outcome.kind).toBe("executed");
		const result = (outcome as { result: AskModelResult }).result;
		expect(result.status).toBe("ok");
		expect(result.answer).toBe("plain answer");
		expect(model.requests).toHaveLength(1);

		expect(seen.map((interaction) => interaction.direction)).toEqual(["inbound", "outbound"]);
		expect(seen.every((interaction) => interaction.tool?.name === "askModel")).toBe(true);
	});

	it("keeps an unsafe prompt from reaching the model and returns the defined rejection", async () => {
		const model = modelDouble(() => staticReply("should not be called"));
		const hub = await createHub({
			audit: auditSink(),
			model,
			pipeline: pipelineWith([blockOn("EVIL_PROMPT")]),
		});

		const outcome = await hub.invokeTool("askModel", { prompt: "EVIL_PROMPT now" }, "alice");
		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.control).toBe("fixture-block");
			expect(outcome.rejection.kind).toBe("blocked");
		}
		expect(model.requests).toHaveLength(0);
	});

	it("returns only the redacted answer to the caller", async () => {
		const model = modelDouble(() => staticReply("the key is SECRET-7"));
		const hub = await createHub({
			audit: auditSink(),
			model,
			pipeline: pipelineWith([redactOn("SECRET-7", "[TOKEN]")]),
		});

		const outcome = await hub.invokeTool("askModel", { prompt: "what is the key?" }, "alice");
		expect(outcome.kind).toBe("executed");
		const result = (outcome as { result: AskModelResult }).result;
		expect(result.answer).toBe("the key is [TOKEN]");
		expect(result.answer).not.toContain("SECRET-7");
	});

	it("audits the governed prompt flow", async () => {
		const audit = auditSink();
		const hub = await createHub({
			audit,
			model: modelDouble(() => staticReply("fine")),
			pipeline: pipelineWith([]),
		});
		await hub.invokeTool("askModel", { prompt: "hello" }, "alice");
		const events = audit.events.filter((event) => event.seam === "mcp-tool");
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events.every((event) => event.subject === "alice")).toBe(true);
	});

	it("exposes no model-reaching route outside the hub", async () => {
		const glob = new Glob("**/*.ts");
		const offenders: string[] = [];
		for await (const routeFile of glob.scan({ cwd: "src/routes" })) {
			const text = await file(`src/routes/${routeFile}`).text();
			if (MODEL_BYPASS_PATTERN.test(text)) {
				offenders.push(routeFile);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("reports a clear configuration error when the model connection is unconfigured", () => {
		let message = "";
		try {
			createOpenAICompatibleConnection({});
		} catch (error) {
			expect(error instanceof ModelConfigurationError).toBe(true);
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("MODEL_BASE_URL");
		expect(message).toContain("MODEL_NAME");
	});
});
