import { describe, expect, it } from "vitest";

import { detectSensitive } from "#/control/detectors.ts";

describe("smoke", () => {
	it("resolves control modules", () => {
		expect(detectSensitive("hello")).toEqual([]);
	});
});
