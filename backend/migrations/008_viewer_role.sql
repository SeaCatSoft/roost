-- =============================================================================
-- Roost — 008 viewer role, part one
--
-- RUN THIS FILE ON ITS OWN, BEFORE 009.
--
-- Postgres will not let a new enum value be *used* in the same transaction that
-- adds it. 009 writes policies that reference 'viewer', so the value has to be
-- committed first. Splitting it across two files is the reliable way to do that
-- in the Supabase SQL editor.
-- =============================================================================

alter type member_role add value if not exists 'viewer';
