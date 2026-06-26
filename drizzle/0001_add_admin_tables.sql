-- Migration: add claims, disputes, and admin_audit_log tables
--
-- claims      – winnings claims submitted after a market resolves
-- disputes    – resolution disputes raised by users
-- admin_audit_log – immutable record of every admin read/write on user data

CREATE TABLE IF NOT EXISTS "claims" (
  "id"         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid        NOT NULL REFERENCES "users" ("id"),
  "market_id"  text        NOT NULL REFERENCES "markets" ("id"),
  "amount"     text        NOT NULL,
  -- pending | paid | rejected
  "status"     text        NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "disputes" (
  "id"         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid        NOT NULL REFERENCES "users" ("id"),
  "market_id"  text        NOT NULL REFERENCES "markets" ("id"),
  "reason"     text        NOT NULL,
  -- open | resolved | rejected
  "status"     text        NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail; no UPDATE or DELETE should ever touch this table.
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_address"  text        NOT NULL,
  "action"         text        NOT NULL,
  "target_address" text        NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

-- Fast look-ups for the audit log dashboard (admin → time, target → time)
CREATE INDEX IF NOT EXISTS "admin_audit_log_admin_idx"  ON "admin_audit_log" ("admin_address", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "admin_audit_log_target_idx" ON "admin_audit_log" ("target_address", "created_at" DESC);
