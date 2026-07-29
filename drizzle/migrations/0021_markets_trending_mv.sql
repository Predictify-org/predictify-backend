-- Materialized view for trending markets
-- Refresh this view periodically to update trending rankings
CREATE MATERIALIZED VIEW IF NOT EXISTS market_trends_mv AS
SELECT
  m.id,
  m.question,
  m.status,
  m.resolution_time,
  m.winning_outcome,
  m.metadata,
  COUNT(p.id) AS total_predictions,
  COALESCE(SUM(p.amount::numeric), 0) AS total_volume
FROM markets m
LEFT JOIN predictions p ON m.id = p.market_id
WHERE m.archived = false
  AND m.status = 'active'
GROUP BY m.id, m.question, m.status, m.resolution_time, m.winning_outcome, m.metadata;

-- Unique index required for CONCURRENTLY refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_trends_mv_id ON market_trends_mv(id);
-- Index for trending sort order
CREATE INDEX IF NOT EXISTS idx_market_trends_mv_activity ON market_trends_mv(total_predictions DESC, total_volume DESC);
