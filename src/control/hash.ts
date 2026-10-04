/**
 * SHA-256 hex helper for version stamps.
 *
 * The policy loader and the signature feed each built a stamp with an
 * inline hash call. The inputs stay per-module (canonical JSON vs raw feed
 * text — version values must not change); only the hash construction is
 * shared. Backed by `Bun.CryptoHasher` so server code never touches
 * `node:crypto`.
 */

/** SHA-256 hex digest of `data`. */
export function sha256Hex(data: string): string {
	return new Bun.CryptoHasher("sha256").update(data, "utf8").digest("hex");
}
