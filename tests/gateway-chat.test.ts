import { describe, expect, it } from "bun:test";
import { createGatewayAsk, GatewayAskTerminatedError, guardedChat } from "#/control/chat.ts";
import type { GovernedLoopTool } from "#/hub/loop.ts";
import {
	auditSink,
	blockOn,
	modelDouble,
	pipelineWith,
	redactOn,
	staticReply,
	toolCallReply,
} from "./helpers/fixtures.ts";

function governedTool(name: string, seenArgs: unknown[]): GovernedLoopTool {
	return {
		execute: (args) => {
			seenArgs.push(args);
			return Promise.resolve({ kind: "executed", result: { slot: "ok" }, resultVerdict: "allow" });
		},
		spec: { description: `${name} tool`, inputSchema: {}, name },
	};
}

describe("chat seam over the gateway ask", () => {
	it("never reaches the model when the prompt is blocked", async () => {
		const connection = modelDouble(() => staticReply("answer"));
		const outcome = await guardedChat("please BLOCKME now", {
			ask: createGatewayAsk({ connection }),
			groupId: "hr",
			pipeline: pipelineWith([blockOn("BLOCKME")]),
			userId: "alice",
		});
		expect(outcome.verdict).toBe("block");
		expect(outcome.answer).toBeUndefined();
		expect(connection.requests).toHaveLength(0);
	});

	it("returns only the redacted answer", async () => {
		const connection = modelDouble(() => staticReply("your token is SECRET-9"));
		const outcome = await guardedChat("what is my token?", {
			ask: createGatewayAsk({ connection }),
			groupId: "hr",
			pipeline: pipelineWith([redactOn("SECRET-9", "[TOKEN]", "outbound")]),
			userId: "alice",
		});
		expect(outcome.verdict).toBe("redact");
		expect(outcome.answer).toBe("your token is [TOKEN]");
		expect(connection.requests).toHaveLength(1);
	});

	it("runs a governed tool roundtrip before answering", async () => {
		const seenArgs: unknown[] = [];
		const connection = modelDouble((_request, index) =>
			index === 0 ? toolCallReply("lookup", { q: "x" }) : staticReply("final says hi"),
		);
		const audit = auditSink();
		const outcome = await guardedChat("look this up", {
			ask: createGatewayAsk({ connection, tools: [governedTool("lookup", seenArgs)] }),
			audit,
			groupId: "hr",
			pipeline: pipelineWith([]),
			userId: "alice",
		});
		expect(outcome.verdict).toBe("allow");
		expect(outcome.answer).toBe("final says hi");
		// The governed tool saw the parsed arguments, and the loop fed the
		// governed result back for a second model round.
		expect(seenArgs).toEqual([{ q: "x" }]);
		expect(connection.requests).toHaveLength(2);
		expect(audit.events.filter((event) => event.seam === "chat")).toHaveLength(2);
	});

	it("terminates the ask when the loop runs over budget", async () => {
		const connection = modelDouble(() => toolCallReply("lookup", { q: "again" }));
		const seenArgs: unknown[] = [];
		const ask = createGatewayAsk({
			connection,
			maxIterations: 1,
			tools: [governedTool("lookup", seenArgs)],
		});
		try {
			await ask("keep looking");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayAskTerminatedError);
			expect((error as GatewayAskTerminatedError).kind).toBe("over-budget");
		}
		// The request-count bound fired: exactly one model round ran.
		expect(connection.requests).toHaveLength(1);
	});

	it("terminates the ask when a turn is rejected under turn enforcement", async () => {
		const connection = modelDouble(() => toolCallReply("denied-tool"));
		const refusing: GovernedLoopTool = {
			execute: () =>
				Promise.resolve({
					kind: "refused",
					rejection: { control: "tool-authorization", kind: "denied", verdict: "block" },
				}),
			spec: { description: "denied tool", inputSchema: {}, name: "denied-tool" },
		};
		const ask = createGatewayAsk({ connection, enforcement: "turn", tools: [refusing] });
		try {
			await ask("use the denied tool");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayAskTerminatedError);
			expect((error as GatewayAskTerminatedError).kind).toBe("turn-rejected");
		}
	});
});
