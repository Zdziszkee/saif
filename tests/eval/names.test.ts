/**
 * Evaluation suite, part 9 — person-name handling.
 *
 * Names are the highest-stakes PII class: leaking one outbound is a breach,
 * redacting every capitalized word is unusable. These cases pin the
 * line the shipped names index draws — dictionary-known names redact with
 * stable per-person placeholders, unknown words and place names pass.
 */

import { describe, expect, it } from "bun:test";
import { evaluate } from "./harness.ts";

describe("eval: known names redact outbound with stable placeholders", () => {
	it("redacts a full known name", async () => {
		const { body, status } = await evaluate("Jan Kowalski joined the team.", {
			direction: "outbound",
		});
		expect(status).toBe(200);
		expect(body.verdict).toBe("redact");
		expect(body.content).toBe("[PERSON_1] joined the team.");
	});

	it("redacts a known forename in context", async () => {
		const { body } = await evaluate("My colleague Abbas will help.", { direction: "outbound" });
		expect(body.verdict).toBe("redact");
		expect(body.content).toBe("My colleague [PERSON_1] will help.");
	});
});

describe("eval: unknown words and places pass", () => {
	it("allows an invented name it has no evidence for", async () => {
		const { body, status } = await evaluate("Xyzzy McFrob did it.", { direction: "outbound" });
		expect(status).toBe(200);
		expect(body.verdict).toBe("allow");
	});

	it("allows a place name", async () => {
		const { body, status } = await evaluate("The Warsaw office opens Monday.", {
			direction: "outbound",
		});
		expect(status).toBe(200);
		expect(body.verdict).toBe("allow");
	});
});
