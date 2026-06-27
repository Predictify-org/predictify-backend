# Admin seed endpoint

`POST /api/admin/seed` inserts a small set of demo markets for local E2E flows,
staging smoke tests, and product demos.

The endpoint is intentionally limited:

- It only runs outside `NODE_ENV=production`.
- It requires the same admin bearer token as other admin endpoints.
- It is idempotent. Seed markets use fixed IDs and `ON CONFLICT DO NOTHING`.
- Seeded rows are tracked with `metadata.seeded=true` and
  `metadata.seedKey="sample-markets-v1"`.

Example:

```bash
curl -X POST http://localhost:3001/api/admin/seed \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Response:

```json
{
  "data": {
    "seedKey": "sample-markets-v1",
    "requested": 3,
    "inserted": 3,
    "marketIds": [
      "seed-market-btc-100k-2026",
      "seed-market-stellar-tvl-2026",
      "seed-market-ai-agent-checkout"
    ]
  }
}
```

Running the endpoint again returns the same `marketIds` with `inserted: 0`.
