import { describe, expect, it } from "bun:test";

import { createAllowlistControl } from "#/control/allowlist.ts";
import type { Interaction } from "#/control/types.ts";

function interaction(model: string | undefined): Interaction {
	return {
		content: "hello",
		direction: "inbound",
		id: "allow-test",
		model,
		seam: "guard-api",
		subject: "test",
	};
}

describe("model allowlist", () => {
	const control = createAllowlistControl([{ name: "primary" }, { name: "local-small" }]);

	it("allows listed models", async () => {
		expect((await Promise.resolve(control.inspect(interaction("primary")))).verdict).toBe("allow");
	});

	it("allows interactions without a model", async () => {
		expect((await Promise.resolve(control.inspect(interaction(undefined)))).verdict).toBe("allow");
	});

	it("blocks unlisted models with attribution", async () => {
		const result = await Promise.resolve(control.inspect(interaction("evil-model")));
		expect(result.verdict).toBe("block");
		expect(result.hit?.controlId).toBe("allowlist");
	});
});
