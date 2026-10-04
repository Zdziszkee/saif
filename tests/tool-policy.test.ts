import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { PolicySource } from "#/control/policy/loader.ts";
import type { ToolPolicy } from "#/hub/tool-policy.ts";
import {
	createFileToolPolicyStore,
	createToolPolicyRegistry,
	parseToolPolicy,
	ToolPolicyStore,
} from "#/hub/tool-policy.ts";

class FakePolicySource implements PolicySource {
	#document: unknown;
	#failLoad = false;
	#listener: (() => void) | undefined;

	constructor(document: unknown) {
		this.#document = document;
	}

	load(): Promise<unknown> {
		if (this.#failLoad) {
			return Promise.reject(new Error("unreadable"));
		}
		return Promise.resolve(this.#document);
	}

	watch(onChange: () => void): () => void {
		this.#listener = onChange;
		return () => {
			this.#listener = undefined;
		};
	}

	setDocument(document: unknown): void {
		this.#document = document;
		this.#listener?.();
	}

	setFailLoad(fail: boolean): void {
		this.#failLoad = fail;
	}
}

const HEX_64 = /^[0-9a-f]{64}$/;
const POLL_INTERVAL_MS = 20;

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	if (predicate()) {
		return;
	}
	if (timeoutMs <= 0) {
		throw new Error("condition not met in time");
	}
	await new Promise((resolve) => {
		setTimeout(resolve, POLL_INTERVAL_MS);
	});
	await waitFor(predicate, timeoutMs - POLL_INTERVAL_MS);
}

function validDocument(): unknown {
	return {
		tools: {
			addTodo: {
				allowedGroups: ["manager", "software-developer"],
				requireConfirm: false,
			},
			deleteAllTodos: {
				allowedGroups: ["manager"],
				requireConfirm: true,
			},
		},
		version: "1",
	};
}

describe("parseToolPolicy", () => {
	it("parses a valid document", () => {
		const result = parseToolPolicy(validDocument());
		expect(result.success).toBe(true);
		if (result.success) {
			const addTodo = "addTodo";
			const deleteAllTodos = "deleteAllTodos";
			expect(result.policy.version).toBe("1");
			expect(result.policy.tools[addTodo]?.allowedGroups).toEqual([
				"manager",
				"software-developer",
			]);
			expect(result.policy.tools[deleteAllTodos]?.requireConfirm).toBe(true);
		}
	});

	it("rejects an unknown top-level key", () => {
		const document: unknown = {
			extra: true,
			tools: {},
			version: "1",
		};
		const result = parseToolPolicy(document);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues.length > 0).toBe(true);
		}
	});

	it("rejects an empty tool name", () => {
		const document: unknown = {
			tools: {
				"": {
					allowedGroups: ["manager"],
					requireConfirm: false,
				},
			},
			version: "1",
		};
		expect(parseToolPolicy(document).success).toBe(false);
	});

	it("rejects empty allowedGroups", () => {
		const document: unknown = {
			tools: {
				addTodo: {
					allowedGroups: [],
					requireConfirm: false,
				},
			},
			version: "1",
		};
		expect(parseToolPolicy(document).success).toBe(false);
	});

	it("rejects duplicate allowedGroups", () => {
		const document: unknown = {
			tools: {
				addTodo: {
					allowedGroups: ["manager", "manager"],
					requireConfirm: false,
				},
			},
			version: "1",
		};
		const result = parseToolPolicy(document);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues.length > 0).toBe(true);
		}
	});

	it("rejects a non-boolean requireConfirm", () => {
		const document: unknown = {
			tools: {
				addTodo: {
					allowedGroups: ["manager"],
					requireConfirm: "yes",
				},
			},
			version: "1",
		};
		expect(parseToolPolicy(document).success).toBe(false);
	});
});

describe("ToolPolicyRegistry", () => {
	it("abstains before any snapshot is loaded", () => {
		const registry = createToolPolicyRegistry();
		expect(registry.allows("manager", "addTodo")).toBeUndefined();
		expect(registry.requiresConfirm("addTodo")).toBe(false);
		expect(registry.version).toBeUndefined();
	});

	it("allows a listed group, denies another group, and denies unlisted tools", () => {
		const registry = createToolPolicyRegistry();
		const parsed = parseToolPolicy(validDocument());
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected a valid policy");
		}
		const policy: ToolPolicy = parsed.policy;
		registry.update({ policy, version: "test-version" });
		expect(registry.allows("manager", "addTodo")).toBe(true);
		expect(registry.allows("hr", "addTodo")).toBe(false);
		expect(registry.allows("manager", "missingTool")).toBe(false);
		expect(registry.version).toBe("test-version");
	});

	it("reports requiresConfirm for listed tools and false for unknown tools", () => {
		const registry = createToolPolicyRegistry();
		const parsed = parseToolPolicy(validDocument());
		if (!parsed.success) {
			throw new Error("expected a valid policy");
		}
		registry.update({ policy: parsed.policy, version: "test-version" });
		expect(registry.requiresConfirm("deleteAllTodos")).toBe(true);
		expect(registry.requiresConfirm("addTodo")).toBe(false);
		expect(registry.requiresConfirm("missingTool")).toBe(false);
	});

	it("returns to abstain after update(undefined)", () => {
		const registry = createToolPolicyRegistry();
		const parsed = parseToolPolicy(validDocument());
		if (!parsed.success) {
			throw new Error("expected a valid policy");
		}
		registry.update({ policy: parsed.policy, version: "test-version" });
		expect(registry.allows("manager", "addTodo")).toBe(true);
		registry.update(undefined);
		expect(registry.allows("manager", "addTodo")).toBeUndefined();
		expect(registry.requiresConfirm("deleteAllTodos")).toBe(false);
		expect(registry.version).toBeUndefined();
	});
});

describe("ToolPolicyStore", () => {
	it("starts with a valid snapshot and stamps a 64-hex version", async () => {
		const source = new FakePolicySource(validDocument());
		const store = new ToolPolicyStore(source);
		try {
			const result = await store.start();
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.snapshot.version).toMatch(HEX_64);
				expect(result.snapshot.policy.version).toBe("1");
			}
			expect(store.snapshot?.version).toMatch(HEX_64);
		} finally {
			store.stop();
		}
	});

	it("keeps the previous snapshot when a reload is invalid", async () => {
		const source = new FakePolicySource(validDocument());
		const store = new ToolPolicyStore(source);
		try {
			await store.start();
			const pinned = store.snapshot;
			source.setDocument({
				tools: {},
				version: "",
			});
			const result = await store.reload();
			expect(result.ok).toBe(false);
			expect(store.snapshot).toBe(pinned);
			expect(store.snapshot?.policy.version).toBe("1");
		} finally {
			store.stop();
		}
	});

	it("returns ok:false with an undefined snapshot when the source fails before any valid load", async () => {
		const source = new FakePolicySource(validDocument());
		source.setFailLoad(true);
		const store = new ToolPolicyStore(source);
		try {
			const result = await store.start();
			expect(result.ok).toBe(false);
			expect(store.snapshot).toBeUndefined();
		} finally {
			store.stop();
		}
	});

	it("applies watcher edits and ignores edits after stop", async () => {
		const source = new FakePolicySource(validDocument());
		const store = new ToolPolicyStore(source);
		try {
			await store.start();
			source.setDocument({
				tools: {
					addTodo: {
						allowedGroups: ["manager"],
						requireConfirm: false,
					},
				},
				version: "2",
			});
			await waitFor(() => store.snapshot?.policy.version === "2");
			expect(store.snapshot?.policy.version).toBe("2");
			store.stop();
			source.setDocument(validDocument());
			await new Promise((resolve) => {
				setTimeout(resolve, 60);
			});
			expect(store.snapshot?.policy.version).toBe("2");
		} finally {
			store.stop();
		}
	});

	it("exposes a file-backed helper", () => {
		expect(typeof createFileToolPolicyStore).toBe("function");
		const store = createFileToolPolicyStore(join("policy.mcp.json"));
		expect(store).toBeInstanceOf(ToolPolicyStore);
	});
});

describe("shipped policy.mcp.json", () => {
	it("parses and grants addTodo/listTodos broadly with manager-only confirmed deleteAllTodos", async () => {
		const path = join(import.meta.dir, "../policy.mcp.json");
		const text = await Bun.file(path).text();
		const document: unknown = JSON.parse(text);
		const parsed = parseToolPolicy(document);
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected the shipped policy to parse");
		}
		const registry = createToolPolicyRegistry();
		registry.update({ policy: parsed.policy, version: "shipped" });
		expect(registry.allows("hr", "addTodo")).toBe(true);
		expect(registry.allows("manager", "addTodo")).toBe(true);
		expect(registry.allows("hr", "listTodos")).toBe(true);
		expect(registry.allows("manager", "listTodos")).toBe(true);
		expect(registry.allows("manager", "deleteAllTodos")).toBe(true);
		expect(registry.allows("hr", "deleteAllTodos")).toBe(false);
		expect(registry.requiresConfirm("deleteAllTodos")).toBe(true);
		expect(registry.requiresConfirm("addTodo")).toBe(false);
		expect(registry.requiresConfirm("listTodos")).toBe(false);
	});
});
