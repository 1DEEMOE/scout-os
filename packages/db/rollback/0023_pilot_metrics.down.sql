-- Rollback for 0023. Not applied.

DROP TABLE IF EXISTS pilot_metrics;
DELETE FROM schema_migrations WHERE name = '0023_pilot_metrics.sql';
