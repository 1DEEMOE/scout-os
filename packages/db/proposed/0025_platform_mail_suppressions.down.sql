-- Rollback for proposed 0025 (platform mail suppression).
DROP TABLE IF EXISTS platform_mail_soft_bounces;
DROP TABLE IF EXISTS platform_mail_suppressions;
