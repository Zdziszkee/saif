CREATE TABLE `mcp_tool_calls` (
	`confirmed` integer,
	`control_id` text,
	`estimated_tokens` integer NOT NULL,
	`user_group_id` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`latency_ms` integer,
	`policy_version` text NOT NULL,
	`require_confirm` integer DEFAULT 0 NOT NULL,
	`tool_name` text NOT NULL,
	`tool_source` text NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`user_id` text,
	`verdict` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_ts_idx` ON `mcp_tool_calls` (`ts`);--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_tool_ts_idx` ON `mcp_tool_calls` (`tool_name`,`ts`);--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_user_ts_idx` ON `mcp_tool_calls` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_group_ts_idx` ON `mcp_tool_calls` (`user_group_id`,`ts`);--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_verdict_ts_idx` ON `mcp_tool_calls` (`verdict`,`ts`);