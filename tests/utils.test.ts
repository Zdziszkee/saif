import { describe, expect, it } from "bun:test";
import { cn } from "#/lib/utils.ts";

describe("cn", () => {
	it("joins plain class names", () => {
		expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
	});

	it("drops falsy values", () => {
		expect(cn("text-sm", undefined, false, null, "font-bold")).toBe("text-sm font-bold");
	});

	it("resolves conflicting tailwind classes in favor of the last one", () => {
		expect(cn("p-2", "p-4")).toBe("p-4");
		expect(cn("px-2", "px-4")).toBe("px-4");
	});

	it("keeps classes from different tailwind groups", () => {
		expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
	});
});
