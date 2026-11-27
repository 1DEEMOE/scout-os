-- migrate:no-transaction
-- 0029: index for the audit page's action-prefix filter.
-- Built CONCURRENTLY so writes to audit_events (every approval/action) are not blocked.
-- Not atomic and safe to re-run (IF NOT EXISTS). If a build is interrupted it can leave an
-- INVALID index: run `DROP INDEX CONCURRENTLY IF EXISTS audit_events_tenant_action_idx;`
-- and apply again. Rollback: 0029_audit_events_action_index.down.sql
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_tenant_action_idx ON audit_events (tenant_id, action);
RESET lock_timeout;
