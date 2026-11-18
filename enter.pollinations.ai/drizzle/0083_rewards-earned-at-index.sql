-- Monthly quest standings aggregate rewards earned since the start of the
-- current month; without this index that range filter full-scans rewards.
CREATE INDEX `idx_rewards_earned_at` ON `rewards` (`earned_at`);
