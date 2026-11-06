-- 0020 (PROPOSED, NOT APPLIED): workspace branding and briefing topics.
-- Additive only. Rollback: 0020_workspace_brand_and_watch.down.sql
-- Review notes:
--  * brand_accent is limited to a fixed set of candidate accents so a workspace
--    can't pick an unreadable colour. Before adopting, add each one to
--    apps/web/test/contrast.test.ts (>= 4.5:1 with white text, and as text on
--    the light surface) and drop any that fail; dark mode keeps the default accent.
--  * watch_topics filters which briefing sections are shown. NULL = all
--    sections (today's behaviour). Approvals can never be filtered out.
BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_accent text
    CHECK (brand_accent IS NULL OR brand_accent IN ('#17616a', '#1d4ed8', '#7c3aed', '#b45309', '#be123c', '#166534', '#334155'));
COMMENT ON COLUMN organizations.brand_accent IS 'Operator-chosen accent for this workspace. NULL = product default.';

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS watch_topics text[]
    CHECK (
      watch_topics IS NULL
      OR (
        watch_topics <@ ARRAY['storm_signals', 'unanswered_leads', 'stalled_deals', 'follow_ups_due', 'overdue_invoices', 'pending_approvals', 'ai_visibility']::text[]
        AND 'pending_approvals' = ANY (watch_topics)
      )
    );
COMMENT ON COLUMN routines.watch_topics IS 'Briefing sections this routine includes. NULL = all. Must include pending_approvals.';

COMMIT;
