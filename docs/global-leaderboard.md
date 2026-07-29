# Global Leaderboard API

## Overview

The global leaderboard aggregates prediction stats for every user across **all markets and all time**, providing a single platform-wide ranking. Unlike the market-scoped `/api/leaderboard` endpoint (which supports period filtering), the global leaderboard has no time-window filter — it is a full lifetime view of each user's performance.

This feature was added as part of the GrantFox FWC26 campaign.

---

## Endpoints

### `GET /api/leaderboard/global`

Returns a paginated list of all users ranked by their global prediction performance.

**Ranking logic:**  
`accuracy_percentage DESC`, then `total_predictions DESC` (to break ties).

#### Query Parameters

| Parameter | Type    | Default | Constraints          | Description |
|-----------|---------|---------|----------------------|-------------|
| `limit`   | integer | `50`    | 1–100                | Max entries to return |
| `offset`  | integer | `0`     | ≥ 0                  | Zero-based row offset for pagination |
| `refresh` | boolean | `false` | `true` / `false`     | Forces a `REFRESH MATERIALIZED VIEW CONCURRENTLY` before the query (expensive; intended for admin/debug use) |

#### Response — 200 OK

```json
{
  "data": [
    {
      "user_id": "550e8400-e29b-41d4-a716-446655440000",
      "stellar_address": "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
      "total_predictions": 120,
      "correct_predictions": 96,
      "accuracy_percentage": 80.00,
      "total_markets": 8,
      "rank": 1
    }
  ],
  "meta": {
    "limit": 50,
    "offset": 0,
    "count": 1,
    "refresh": false
  }
}
```

#### Entry Fields

| Field                  | Type    | Description |
|------------------------|---------|-------------|
| `user_id`              | UUID    | Internal user UUID |
| `stellar_address`      | string  | User's Stellar public key (G…) |
| `total_predictions`    | integer | Total predictions placed across all markets |
| `correct_predictions`  | integer | Predictions matching the resolved outcome |
| `accuracy_percentage`  | float   | Accuracy as a percentage (0–100), rounded to 2 d.p. |
| `total_markets`        | integer | Number of distinct markets the user participated in |
| `rank`                 | integer | 1-based global rank |

#### Example Requests

```bash
# Default page (50 results, rank 1–50)
GET /api/leaderboard/global

# Next page
GET /api/leaderboard/global?limit=50&offset=50

# Smaller page
GET /api/leaderboard/global?limit=10

# Force a live refresh (admin/debug)
GET /api/leaderboard/global?refresh=true
```

#### Error Responses

| Status | Code               | Trigger |
|--------|--------------------|---------|
| `400`  | `validation_error` | Invalid query params (e.g. limit > 100, negative offset) |
| `429`  |                    | Rate limit exceeded (anonymous callers share a bucket) |
| `500`  |                    | Unexpected server error |

---

### `GET /api/leaderboard/global/user/:stellarAddress`

Returns a single user's global leaderboard entry.

#### Path Parameters

| Parameter        | Description |
|------------------|-------------|
| `stellarAddress` | User's Stellar public key (G…) |

#### Response — 200 OK

```json
{
  "data": {
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "stellar_address": "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
    "total_predictions": 120,
    "correct_predictions": 96,
    "accuracy_percentage": 80.00,
    "total_markets": 8,
    "rank": 1
  }
}
```

#### Error Responses

| Status | Code       | Trigger |
|--------|------------|---------|
| `404`  | `not_found` | Address has never placed a prediction |
| `429`  |             | Rate limit exceeded |
| `500`  |             | Unexpected server error |

#### Example Requests

```bash
# Look up a specific user's global rank
GET /api/leaderboard/global/user/GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF
```

---

## Caching

- Results are cached in Redis with a **5-minute TTL**.
- Paginated slices use the key `leaderboard:global:{limit}:{offset}`.
- Per-user lookups use the key `leaderboard:global:user:{stellarAddress}`.
- `null` results (unknown addresses) are cached as well to short-circuit repeated 404 lookups.
- All cache keys in the `leaderboard:global:*` namespace are invalidated when a `refresh=true` request is handled.
- Cache failures degrade gracefully — the API falls back to the database and logs a warning.

---

## Database Backing

The endpoint is backed by the `address_aggregates_mv` materialized view, which already aggregates predictions across all resolved and disputed markets. The `total_markets` column is added on-the-fly via a correlated sub-query against the `predictions` table.

```sql
SELECT
  aa.user_id,
  aa.stellar_address,
  aa.total_predictions,
  aa.correct_predictions,
  aa.accuracy_percentage,
  COALESCE(mp.market_count, 0)::integer AS total_markets,
  aa.rank
FROM address_aggregates_mv aa
LEFT JOIN (
  SELECT user_id, COUNT(DISTINCT market_id)::integer AS market_count
  FROM predictions
  GROUP BY user_id
) mp ON mp.user_id = aa.user_id
ORDER BY aa.rank ASC
LIMIT $1 OFFSET $2
```

The view refresh uses `REFRESH MATERIALIZED VIEW CONCURRENTLY` to avoid blocking concurrent reads.

---

## Difference from `/api/leaderboard`

| Feature              | `/api/leaderboard`                          | `/api/leaderboard/global`             |
|----------------------|---------------------------------------------|---------------------------------------|
| Scope                | All markets (market-scoped view)            | All markets, all time                 |
| Time-period filter   | `all-time`, `monthly`, `weekly`             | None (always all-time)                |
| Extra field          | —                                           | `total_markets`                       |
| Backing view         | `leaderboard_mv` / `leaderboard_monthly_mv` / `leaderboard_weekly_mv` | `address_aggregates_mv` |

---

## Rate Limiting

Both endpoints use the existing anonymous rate-limiter (`rateLimitAnon`). Authenticated callers with a valid `Authorization: Bearer <token>` header bypass the limiter.

---

## Security

- **Input validation**: All query parameters are validated with Zod. Invalid values produce `400` responses before any service call.
- **SQL injection**: All queries use Drizzle ORM parameterised statements.
- **No auth required**: Both endpoints are publicly readable, consistent with the per-market leaderboard.

---

## Implementation Files

| File | Role |
|------|------|
| `src/routes/leaderboard/global.ts` | Express router — validation, logging, HTTP responses |
| `src/services/globalLeaderboardService.ts` | Business logic — cache read/write, DB queries, view refresh |
| `src/openapi/registry.ts` | OpenAPI schema registration (`GlobalLeaderboardEntry`, paths) |
| `tests/globalLeaderboard.test.ts` | Route-level integration tests (supertest) |
| `tests/globalLeaderboardService.test.ts` | Service unit tests (mocked DB + Redis) |

---

## Testing

```bash
# Run all tests
npm test

# Run only the global leaderboard tests
npm test -- --testPathPattern="globalLeaderboard"

# With coverage
npm run test:coverage
```

### Test Coverage

- **Route tests** (`tests/globalLeaderboard.test.ts`): default params, custom pagination, string coercion, `refresh=true`, empty results, boundary values (limit 1, 100), all validation error cases, 500 handling, full response field shapes.
- **Service tests** (`tests/globalLeaderboardService.test.ts`): cache hits, cache misses, null caching, cache read/write failure fallback, DB error propagation, `REFRESH MATERIALIZED VIEW` SQL verification, cache key invalidation patterns, Redis-null graceful degradation.
