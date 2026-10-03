import nlp from "compromise";

export interface EntitySpan {
	end: number;
	start: number;
	type: "address" | "person";
	value: string;
}

interface OffsetJson {
	offset?: { index: number; length: number; start: number };
	text: string;
}

const TrailingPunctuation = /[.,;:!?"'’)\]]+$/u;
const PossessiveSuffix = /['’]s$/u;

function spansFrom(
	clause: { json: (options: { offset: boolean }) => OffsetJson[] },
	type: "address" | "person",
	text: string,
): EntitySpan[] {
	const spans: EntitySpan[] = [];
	for (const entry of clause.json({ offset: true })) {
		const start = entry.offset?.start;
		const length = entry.offset?.length;
		if (start === undefined || length === undefined) {
			continue;
		}
		let value = text.slice(start, start + length);
		value = value.replace(TrailingPunctuation, "").replace(PossessiveSuffix, "").trimEnd();
		const end = start + value.length;
		if (value.length > 0) {
			spans.push({ end, start, type, value });
		}
	}
	return spans;
}

export function detectNamedEntities(text: string): EntitySpan[] {
	const doc = nlp(text);
	return [
		...spansFrom(doc.people(), "person", text),
		...spansFrom(doc.addresses(), "address", text),
	];
}
