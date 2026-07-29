### GET /api/alerts

Query parameters (all optional):

| Param        | Type    | Notes                                |
|--------------|---------|----------------------------------------|
| `unreadOnly` | boolean | `"true"` or `"false"`                  |
| `severity`   | string  | `info` \| `warning` \| `critical`      |
| `limit`      | integer | 1–100, default 20                      |
| `cursor`     | string  | pagination cursor                      |

Unknown query parameters are rejected with a 400 error.

Invalid input returns `400`:
```json
{
  "error": {
    "code": "validation_error",
    "message": "Validation failed",
    "details": [ /* Zod issue objects */ ],
    "correlationId": "..."
  }
}
```

### PATCH /api/alerts/read

Body (optional):

| Field       | Type       | Notes                                     |
|-------------|------------|---------------------------------------------|
| `alertIds`  | string[]   | UUIDs, max 500; omit to mark all as read    |

Unknown body fields are rejected. Same `validation_error` envelope on invalid input.
