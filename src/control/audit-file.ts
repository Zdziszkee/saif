/**
 * File audit sink (server-only).
 *
 * Lives in its own module — not in `./audit.ts` — because that module is
 * imported by client components (dashboard summaries), and a `node:fs`
 * import there breaks the browser bundle ("module externalized for browser
 * compatibility"). Only server wiring (`#/hub/runtime.ts`) imports this.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditSink } from "./audit.ts";

/**
 * Durable file sink: appends one JSON object per line, so `tail -f` shows
 * every decision as it happens and the trail survives restarts. Audit must
 * never break enforcement, so a failed write is reported on stderr and the
 * event is otherwise dropped for this sink only.
 */
export function createFileAuditSink(path: string): AuditSink & { path: string } {
	mkdirSync(dirname(path), { recursive: true });
	return {
		path,
		record: (event) => {
			try {
				appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
			} catch (error) {
				process.stderr.write(
					`audit file sink failed for ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		},
	};
}
