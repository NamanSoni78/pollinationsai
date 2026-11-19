CREATE TABLE `stripe_refund_reversals` (
        `reversal_id` text PRIMARY KEY NOT NULL,
        `event_id` text NOT NULL,
        `event_type` text NOT NULL,
        `session_id` text NOT NULL,
        `user_id` text NOT NULL,
        `pollen_reversed` real NOT NULL,
        `reason` text NOT NULL,
        `created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
        FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_stripe_refund_reversals_user_id` ON `stripe_refund_reversals` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_stripe_refund_reversals_session_id` ON `stripe_refund_reversals` (`session_id`);
