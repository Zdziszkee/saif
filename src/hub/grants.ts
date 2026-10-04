/**
 * Tool grant registry (MCP safety hub: connected tools register ungranted and
 * are denied until granted). The full tool-authorization capability (capability
 * verbs, deny-by-default grant sets, approvals queue) is its own spec module;
 * this registry is the hub-local seam it will replace.
 */

export interface GrantRegistry {
	grant(groupId: string, toolName: string): void;
	isGranted(groupId: string, toolName: string): boolean;
	registerTool(toolName: string, grantedByDefault: boolean): void;
	revoke(groupId: string, toolName: string): void;
}

export function createGrantRegistry(): GrantRegistry {
	const defaults = new Map<string, boolean>();
	const overrides = new Map<string, boolean>();

	const key = (groupId: string, toolName: string) => `${groupId}:${toolName}`;

	return {
		grant(groupId, toolName) {
			overrides.set(key(groupId, toolName), true);
		},
		isGranted(groupId, toolName) {
			const override = overrides.get(key(groupId, toolName));
			if (override !== undefined) {
				return override;
			}
			return defaults.get(toolName) ?? false;
		},
		registerTool(toolName, grantedByDefault) {
			defaults.set(toolName, grantedByDefault);
		},
		revoke(groupId, toolName) {
			overrides.set(key(groupId, toolName), false);
		},
	};
}
