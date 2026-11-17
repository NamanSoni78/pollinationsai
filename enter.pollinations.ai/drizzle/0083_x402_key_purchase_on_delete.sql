-- Prepaid x402 keys must be revocable: the dashboard's Revoke button and
-- account deletion both hard-delete apikey rows, but the purchase audit row
-- referenced key_id with no ON DELETE action, so both failed with 500 and
-- every prepaid key since launch was unrevocable. Keep the audit row (and its
-- encrypted key, which support uses to recover a paid key: see PAYMENT_USED)
-- with the link cleared. SQLite can't drop NOT NULL in place, so rebuild.
CREATE TABLE `x402_key_purchase_new` (
    `payment_id` TEXT PRIMARY KEY NOT NULL,
    `user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
    `key_id` TEXT REFERENCES `apikey`(`id`) ON DELETE set null,
    `pack_key` TEXT NOT NULL,
    `encrypted_key` TEXT NOT NULL,
    `created_at` INTEGER NOT NULL,
    `credited_at` INTEGER
);
INSERT INTO `x402_key_purchase_new`
  SELECT `payment_id`, `user_id`, `key_id`, `pack_key`, `encrypted_key`, `created_at`, `credited_at`
  FROM `x402_key_purchase`;
DROP TABLE `x402_key_purchase`;
ALTER TABLE `x402_key_purchase_new` RENAME TO `x402_key_purchase`;
