-- Migration: add before_state and after_state columns to audit_logs
-- These nullable JSONB columns capture the relevant system state snapshot
-- before and after every state-changing admin/indexer action so that audit
-- entries carry full forensic context without requiring a JOIN.

ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "before_state" jsonb,
  ADD COLUMN IF NOT EXISTS "after_state"  jsonb;
