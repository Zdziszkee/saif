CREATE TABLE `audit_events` (
	`cause` text,
	`control_id` text,
	`user_group_id` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_version` text NOT NULL,
	`prompt_text` text,
	`score` real,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`user_id` text NOT NULL,
	`verdict` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_ts_idx` ON `audit_events` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_events_user_ts_idx` ON `audit_events` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_events_group_ts_idx` ON `audit_events` (`user_group_id`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_events_verdict_ts_idx` ON `audit_events` (`verdict`,`ts`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`audit_event_id` integer,
	`completion_tokens` integer NOT NULL,
	`cost_usd` real,
	`user_group_id` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`audit_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_records_ts_idx` ON `usage_records` (`ts`);--> statement-breakpoint
CREATE INDEX `usage_records_user_ts_idx` ON `usage_records` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_records_group_ts_idx` ON `usage_records` (`user_group_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_records_audit_event_idx` ON `usage_records` (`audit_event_id`);