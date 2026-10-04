/**
 * SHA-256 hex helper for version stamps.
 *
 * The policy loader and the signature feed each built a stamp with an
 * inline `createHash("sha256").update(...).digest("hex")`. The inputs
 * stay per-module (canonical JSON vs raw feed text — version values must
 * not change); only the hash construction is shared.
 */

import { createHash } from "node:crypto";

/** SHA-256 hex digest of `data`. */
export function sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}
