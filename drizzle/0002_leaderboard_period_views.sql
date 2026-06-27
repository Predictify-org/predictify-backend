-- Period-specific materialized views for /api/leaderboard?period=...
-- Each view keeps users with zero qualifying predictions so ranks remain stable.

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_daily_mv AS
SELECT
  u.id as user_id,
  u.stellar_address,
  COUNT(p.id) as total_predictions,
  SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) as correct_predictions,
  ROUND(
    CASE
      WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
    END,
    2
  ) as accuracy_percentage,
  ROW_NUMBER() OVER (ORDER BY
    CASE
      WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
    END DESC,
    COUNT(p.id) DESC
  ) as rank
FROM users u
LEFT JOIN predictions p
  ON u.id = p.user_id
  AND p.created_at >= now() - interval '1 day'
LEFT JOIN markets m ON p.market_id = m.id AND m.status IN ('resolved', 'disputed')
GROUP BY u.id, u.stellar_address;

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_weekly_mv AS
SELECT
  u.id as user_id,
  u.stellar_address,
  COUNT(p.id) as total_predictions,
  SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) as correct_predictions,
  ROUND(
    CASE
      WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
    END,
    2
  ) as accuracy_percentage,
  ROW_NUMBER() OVER (ORDER BY
    CASE
      WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
    END DESC,
    COUNT(p.id) DESC
  ) as rank
FROM users u
LEFT JOIN predictions p
  ON u.id = p.user_id
  AND p.created_at >= now() - interval '7 days'
LEFT JOIN markets m ON p.market_id = m.id AND m.status IN ('resolved', 'disputed')
GROUP BY u.id, u.stellar_address;

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_monthly_mv AS
SELECT
  u.id as user_id,
  u.stellar_address,
  COUNT(p.id) as total_predictions,
  SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) as correct_predictions,
  ROUND(
    CASE
      WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
    END,
    2
  ) as accuracy_percentage,
  ROW_NUMBER() OVER (ORDER BY
    CASE
      WHEN COUNT(p.id) > 0 THEN
        100.0 * SUM(CASE WHEN p.outcome = m.resolution_outcome THEN 1 ELSE 0 END) / COUNT(p.id)
      ELSE 0
    END DESC,
    COUNT(p.id) DESC
  ) as rank
FROM users u
LEFT JOIN predictions p
  ON u.id = p.user_id
  AND p.created_at >= now() - interval '30 days'
LEFT JOIN markets m ON p.market_id = m.id AND m.status IN ('resolved', 'disputed')
GROUP BY u.id, u.stellar_address;

CREATE INDEX IF NOT EXISTS idx_leaderboard_daily_stellar_address ON leaderboard_daily_mv(stellar_address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_daily_user_id ON leaderboard_daily_mv(user_id);

CREATE INDEX IF NOT EXISTS idx_leaderboard_weekly_stellar_address ON leaderboard_weekly_mv(stellar_address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_weekly_user_id ON leaderboard_weekly_mv(user_id);

CREATE INDEX IF NOT EXISTS idx_leaderboard_monthly_stellar_address ON leaderboard_monthly_mv(stellar_address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_monthly_user_id ON leaderboard_monthly_mv(user_id);
