-- Rollback 0017 gaps-2
DROP TABLE IF EXISTS incoming_documents;
DROP TABLE IF EXISTS job_photos;
DROP TABLE IF EXISTS ai_answer_checks;
DROP TABLE IF EXISTS front_desk_rate_buckets;
DROP TABLE IF EXISTS front_desk_bookings;
DROP TABLE IF EXISTS front_desk_slots;
DROP TABLE IF EXISTS front_desk_channels;

-- Forget this migration so a later `migrate` re-applies it (otherwise it's silently skipped).
DELETE FROM schema_migrations WHERE name = '0017_gaps2_front_desk_photos_docs.sql';
