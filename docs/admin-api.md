`GET /api/admin` returns the admin endpoint catalog for authenticated operators.

Authentication:
- Requires a bearer token with `role: "admin"`.

Query parameters:
- `cursor` optional opaque pagination cursor from the previous response.
- `limit` optional positive integer page size.

Success response:

```json
{
  "items": [
    {
      "id": "GET /api/admin/audit",
      "method": "GET",
      "path": "/api/admin/audit",
      "summary": "List audit log entries"
    }
  ],
  "next_cursor": null,
  "total": 1
}
```

Notes:
- The success envelope is always `{ items, next_cursor, total }`.
- `next_cursor` is `null` on the last page.
- `total` is the full count of admin catalog entries matching the request.

Validation and errors:
- Invalid query parameters return the standard error envelope.
- Unknown query parameters are rejected.
