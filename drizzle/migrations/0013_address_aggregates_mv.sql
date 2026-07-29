-- Predictions-per-address aggregated materialized view
-- Precomputes per-user prediction statistics for fast leaderboard queries.
-- Refreshed hourly via src/workers/refreshAggregates.ts using CONCURRENTLY
-- to avoid locking reads during refresh.

CREATE MATERIALIZED VIEW IF NOT EXISTS address_aggregates_mv AS
SELECT
  u.id AS user_id,
  u.stellar_address,
  COUNT(p.id)::bigint AS total_predictions,
  SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END)::bigint AS correct_predictions,
  ROUND(
    CASE WHEN COUNT(p.id) > 0 THEN
      100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
    ELSE 0
    END,
    2
  ) AS accuracy_percentage,
  ROW_NUMBER() OVER (
    ORDER BY
      CASE WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
      END DESC,
      COUNT(p.id) DESC
  ) AS rank
FROM users u
LEFT JOIN predictions p ON u.id = p.user_id
LEFT JOIN markets m ON p.market_id = m.id AND m.status IN ('resolved', 'disputed')
GROUP BY u.id, u.stellar_address;

-- Unique index on user_id is required for CONCURRENTLY refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_address_aggregates_user_id
  ON address_aggregates_mv (user_id);

-- Index for lookups by stellar address
CREATE INDEX IF NOT EXISTS idx_address_aggregates_stellar_address
  ON address_aggregates_mv (stellar_address);

-- Index for ordered leaderboard queries
CREATE INDEX IF NOT EXISTS idx_address_aggregates_rank
  ON address_aggregates_mv (rank);
