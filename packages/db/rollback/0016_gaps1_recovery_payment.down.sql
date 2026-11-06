-- Rolls back 0016. Drops recovery + payment-detail guard tables.
-- Take a backup first (pg_dump -t routine_recoveries -t payment_destinations -t payment_detail_changes).
BEGIN;
DROP TABLE IF EXISTS payment_detail_changes;
DROP TABLE IF EXISTS payment_destinations;
DROP TABLE IF EXISTS routine_recoveries;
DELETE FROM schema_migrations WHERE name = '0016_gaps1_recovery_payment.sql';
COMMIT;
