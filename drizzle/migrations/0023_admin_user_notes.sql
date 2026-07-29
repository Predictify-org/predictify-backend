-- Migration: 0023_admin_user_notes
-- Adds the admin_user_notes table for per-user freeform admin notes.

CREATE TABLE IF NOT EXISTS admin_user_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_address text     NOT NULL,
  admin_address  text     NOT NULL,
  note           text     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient paginated listing by target address ordered by creation time.
CREATE INDEX IF NOT EXISTS admin_user_notes_target_idx
  ON admin_user_notes (target_address, created_at DESC);
