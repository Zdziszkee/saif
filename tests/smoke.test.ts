import { describe, expect, it } from "bun:test";

import { detectSensitive } from "#/control/detectors.ts";

describe("smoke", () => {
	it("resolves control modules", () => {
		expect(detectSensitive("hello")).toEqual([]);
	});
});
