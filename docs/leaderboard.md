# Leaderboard API

`GET /api/leaderboard` supports period-scoped rankings:

- `period=daily` reads `leaderboard_daily_mv`
- `period=weekly` reads `leaderboard_weekly_mv`
- `period=monthly` reads `leaderboard_monthly_mv`

If `period` is omitted, the API defaults to `daily`.

Examples:

```bash
curl "http://localhost:3001/api/leaderboard?period=daily&limit=25"
curl "http://localhost:3001/api/leaderboard?period=weekly&offset=25"
curl "http://localhost:3001/api/leaderboard/user/GB...ADDRESS?period=monthly"
```

The `period` value is strictly validated. Unknown periods return a validation
error instead of being interpolated into SQL.

Responses include the active period in `meta.period`. Leaderboard list results
are cached per `period`, `limit`, and `offset` for a short window. Requests with
`refresh=true` refresh the selected materialized view and invalidate only that
period's cached results.
