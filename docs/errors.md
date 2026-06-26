# Error contract

All errors are returned as JSON with a single top-level `error` property.

## Shape

```json
{
  "error": {
    "code": "<error_code>",
    "details": []        // only present for validation_error
  }
}
```

## Status → error code mapping

| Condition                            | HTTP status | `code`             | `details`         |
|--------------------------------------|-------------|--------------------|-------------------|
| Zod schema validation failure        | 400         | `validation_error` | `z.Issue[]` array |
| Generic bad request (`err.status=400`) | 400       | `request_failed`   | —                 |
| Resource not found (`err.status=404`)  | 404       | `not_found`        | —                 |
| Conflict (`err.status=409`)            | 409       | `conflict`         | —                 |
| Unprocessable (`err.status=422`)       | 422       | `unprocessable`    | —                 |
| Other 4xx with `.code`               | as-is     | `err.code`         | —                 |
| Other 4xx without `.code`            | as-is     | `request_failed`   | —                 |
| 5xx / unknown / non-Error thrown     | 500       | `internal_error`   | —                 |

## Notes

- Internal error details are **never** leaked to the client — the 500 response is always `{ error: { code: "internal_error" } }`.
- The `details` array on `validation_error` mirrors the Zod `issues` array. Each item contains `path`, `message`, and optionally `code`.
- `err.status` is checked for numeric status codes. `err.code` is used as the error code for 4xx responses when set.
