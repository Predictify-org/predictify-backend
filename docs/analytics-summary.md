# Analytics Summary API

## `GET /api/analytics/summary`

Returns system-wide aggregate analytics for the application.

### Response

Successful responses use the standard `{ data }` envelope:

```json
{
  "data": {
    "totalUsers": 12,
    "totalMarkets": 8,
    "activeMarkets": 5,
    "resolvedMarkets": 3,
    "totalPredictions": 42,
    "totalVolume": "1234.5600000"
  }
}
```

`totalVolume` is returned as a string to preserve PostgreSQL numeric precision.

The endpoint does not accept query parameters. Unsupported parameters return `400` with the standard `validation_error` envelope. Requests and responses include the `x-correlation-id` header for tracing; a correlation ID is generated when one is not supplied.
