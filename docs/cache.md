# Cache Strategy

## Overview

Predictify uses Redis for caching market data to improve read performance. This document describes the cache keys, TTLs, and invalidation strategy.

## Cache Keys

| Key Pattern | Description | Used By |
|-------------|-------------|---------|
| `markets:all` | List of all markets | `GET /api/markets` |
| `markets:{id}` | Single market detail | `GET /api/markets/:id` |

## TTLs

- **`markets:all`**: 60 seconds - Refreshed on any market update to ensure list consistency
- **`markets:{id}`**: 120 seconds - Longer TTL for individual market reads

## Invalidation Strategy

Cache entries are invalidated on the following events:

### Market Update (`PATCH /api/markets/:id`)

When a market is updated via the admin API, both cache keys are invalidated:

1. `markets:{id}` - The specific market's cache is removed
2. `markets:all` - The aggregated list cache is removed

This ensures that subsequent reads return fresh data from the database.

### Implementation

```typescript
// src/cache/marketsCache.ts
export async function invalidateMarketCache(marketId: string) {
  const keysToDelete = [marketCacheKeys.byId(marketId), marketCacheKeys.all];
  await Promise.all(keysToDelete.map((k) => redisConnection.del(k)));
}
```

## Error Handling

Cache operations are designed to never fail the business operation:

- If Redis is unavailable, the request continues without caching
- Cache errors are logged with correlation IDs for debugging
- The API remains functional even if cache invalidation fails

## Security Considerations

- Cache keys do not contain sensitive data
- Only market IDs and aggregated lists are cached
- No user-specific data is cached
- Cache invalidation requires admin authentication

## Performance Notes

- Individual `DEL` operations are O(N) where N is the number of keys
- Invalidations are performed in parallel using `Promise.all`
- Cache misses fall back to database queries seamlessly

## Monitoring

Cache operations are logged with correlation IDs:

```json
{
  "requestId": "uuid",
  "marketId": "market-123",
  "keys": ["markets:market-123", "markets:all"]
}
```

Monitor for:
- `Market cache invalidated` - Successful invalidation
- `Failed to invalidate market cache` - Redis connectivity issues
