-- up
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at ON audit_logs (action, created_at DESC);

-- down
DROP INDEX IF NOT EXISTS idx_audit_logs_action_created_at;
