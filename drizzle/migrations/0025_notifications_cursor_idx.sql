-- Migration: 0025_notifications_cursor_idx
-- Adds a composite index that supports cursor-based keyset pagination on
-- GET /api/notifications ordered by (created_at DESC, id DESC) per user.
--
-- The existing notifications_user_id_idx covers equality lookups on user_id
-- but does not satisfy the keyset predicate:
--   WHERE user_id = $1
--     AND (created_at < $2 OR (created_at = $2 AND id < $3))
--   ORDER BY created_at DESC, id DESC
--
-- With (user_id, created_at DESC, id DESC) Postgres can satisfy both the
-- filter and the ORDER BY in a single index scan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_user_id_cursor_idx
    ON notifications (user_id, created_at DESC, id DESC);
