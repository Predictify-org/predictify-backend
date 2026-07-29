# Markets API

## `GET /api/markets`

Returns a cursor-paginated list of non-archived markets, ordered by newest first
(`createdAt DESC, id DESC`).

### Query Parameters

| Parameter | Type   | Required | Default | Constraints | Description                                                   |
|-----------|--------|----------|---------|-------------|---------------------------------------------------------------|
| `limit`   | number | no       | `20`    | 1-100       | Number of rows to return per page.                            |
| `cursor`  | string | no       | --      | opaque token| Cursor from the previous page's `nextCursor`. Absent = page 1.|
| `status`  | string | no       | --      | free text   | Filter by market status.                                      |
| `category`| string | no       | --      | free text   | Filter by market category.                                    |
| `tag`     | string | no       | --      | free text   | Filter by market tag.                                         |
| `sort`    | string | no       | --      | free text   | Sort column.                                                  |
| `order`   | string | no       | --      | `asc`/`desc`| Sort direction.                                               |

### Pagination

This endpoint uses **keyset (cursor) pagination** on `(createdAt DESC, id DESC)`.

- Pass the returned `nextCursor` verbatim as `?cursor=` to fetch the next page.
- `nextCursor` is `null` on the last page.
- Cursors are versioned. A stale or tampered cursor is safely ignored (the
  response restarts from page 1) rather than causing a 500 or a wrong offset.

### Response

`200 OK`

```json
{
  "data": [
    {
      "id": "market-1",
      "question": "Will BTC close above $100k this quarter?",
      "status": "active",
      "resolutionTime": "2026-07-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "djF8MjR8..."
}
```

### Errors

- `400 validation_error` - invalid query parameters

### Conditional requests and caching

`GET /api/markets` supports strong ETags for conditional revalidation. Every
response includes an `ETag` header and a `Cache-Control: no-cache` header.
Clients may send an `If-None-Match` header with the latest ETag to receive a
`304 Not Modified` response without a body when the market list has not
changed.

Example:

```http
GET /api/markets
If-None-Match: "<etag>"
```

## `GET /api/markets/:id`

Returns a single market by ID.

### Path Parameters

| Parameter | Type   | Required | Description        |
|-----------|--------|----------|---------------------|
| `id`      | string | yes      | The market's ID.    |

### Response

`200 OK`

```json
{
  "data": {
    "id": "market-1",
    "question": "Will BTC close above $100k this quarter?",
    "status": "active",
    "resolutionTime": "2026-07-01T00:00:00.000Z",
    "version": 1
  }
}
```

### Errors

- `404 not_found` - no market exists with the given ID

### Conditional requests and caching

`GET /api/markets/:id` supports strong ETags for conditional revalidation on
the same terms as the list endpoint: every `200` response includes an `ETag`
and `Cache-Control: no-cache` header, and a matching `If-None-Match` header
returns `304 Not Modified` with no body. A `404` response does not include an
`ETag` header.

## `GET /api/markets/recommendations` / `GET /api/recommendations`

Returns personalized market recommendations for the authenticated user using keyset cursor pagination over `(created_at DESC, id DESC)`.

### Query Parameters

- `limit` *(optional, integer, default: 20, min: 1, max: 100)* – Number of items per page.
- `cursor` *(optional, string)* – Opaque cursor token from the previous page's `nextCursor`.

### Authentication

Requires a bearer JWT accepted by the standard authentication middleware.

```http
Authorization: Bearer <token>
```

### Response

`200 OK`

```json
{
  "data": [
    {
      "id": "market-1",
      "question": "Will BTC close above $100k this quarter?",
      "status": "active",
      "resolutionTime": "2026-07-01T00:00:00.000Z",
      "createdAt": "2026-06-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "v1|24|2026-06-01T00:00:00.000Zmarket-1"
}
```


The endpoint excludes markets the user has already predicted on, prefers active
non-archived markets related to terms from the user's prediction history, and
falls back to recent active non-archived markets when there is no usable history
or no related market is found.

### Errors

- `401 Unauthorized` when the bearer token is missing, malformed, invalid, or
  belongs to no known user.

- `408 timeout` - The server aborted the request because it exceeded the maximum allowed duration.