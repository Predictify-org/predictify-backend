# Social graph follow endpoints

The backend exposes follow and unfollow mutations on top of cached user counters.

## Endpoints

### `POST /api/users/:addr/follow`

Creates a follow edge from the authenticated user to the target Stellar address.

Response:

```json
{
  "data": {
    "targetAddress": "G...",
    "isFollowing": true,
    "visibility": {
      "isPrivate": false,
      "feedVisible": true
    },
    "counts": {
      "followers": 14,
      "following": 8
    }
  }
}
```

### `DELETE /api/users/:addr/follow`

Removes the follow edge if it exists and returns the same payload shape with
`isFollowing: false`.

## Privacy rules

- Private accounts (`users.is_private = true`) cannot be followed through this
  endpoint.
- `visibility.feedVisible` is only `true` for public feeds.
- Self-follow and self-unfollow attempts are rejected with
  `400 validation_error`.

## Cached counts

Follower and following counts are stored on the `users` row and updated inside
the same transaction as follow edge creation/deletion.

## Audit logging

Each successful mutation emits:

- `social.followed`
- `social.unfollowed`

The audit log includes the acting wallet address, request correlation ID, and
client IP.

### `GET /api/users/:addr/portfolio`

Returns a cached aggregate portfolio for a Stellar wallet across all markets. The response includes total markets, predictions, staked amount, pending claimable amount, status counts, and per-market aggregates. Invalid Stellar addresses return `400 invalid_address`; unknown users return `404 not_found`.
