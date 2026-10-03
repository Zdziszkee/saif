/**
 * Tool grant registry (MCP safety hub: connected tools register ungranted and
 * are denied until granted). The full tool-authorization capability (capability
 * verbs, deny-by-default grant sets, approvals queue) is its own spec module;
 * this registry is the hub-local seam it will replace.
 */

export interface GrantRegistry {
	grant(subject: string, toolName: string): void;
	isGranted(subject: string, toolName: string): boolean;
	registerTool(toolName: string, grantedByDefault: boolean): void;
	revoke(subject: string, toolName: string): void;
}

export function createGrantRegistry(): GrantRegistry {
	const defaults = new Map<string, boolean>();
	const overrides = new Map<string, boolean>();

	const key = (subject: string, toolName: string) => `${subject}:${toolName}`;

	return {
		grant(subject, toolName) {
			overrides.set(key(subject, toolName), true);
		},
		isGranted(subject, toolName) {
			const override = overrides.get(key(subject, toolName));
			if (override !== undefined) {
				return override;
			}
			return defaults.get(toolName) ?? false;
		},
		registerTool(toolName, grantedByDefault) {
			defaults.set(toolName, grantedByDefault);
		},
		revoke(subject, toolName) {
			overrides.set(key(subject, toolName), false);
		},
	};
}
