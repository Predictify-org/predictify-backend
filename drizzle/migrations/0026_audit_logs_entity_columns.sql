-- Migration: add entity_type and entity_id columns to audit_logs
-- These columns store the type and primary key of the entity being
-- mutated, enabling filtered audit queries by entity without
-- parsing the before/after JSONB state snapshots.

ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "entity_type" text,
  ADD COLUMN IF NOT EXISTS "entity_id" text;