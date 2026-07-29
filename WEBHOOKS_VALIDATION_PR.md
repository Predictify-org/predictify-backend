# feat: input validation /api/webhooks

## Summary

Adds Zod-validated input schemas for all `/api/webhooks` endpoints, replacing inline ad-hoc validation with centralized, reusable validators. Follows the established pattern from `src/validators/markets.ts` and `src/validators/predictions.ts`.

## Changes

### New file: `src/validators/webhooks.ts`

- **`listWebhooksQuerySchema`** -- validates `GET /api/webhooks` query params (`cursor`, `limit`). Uses `.strict()` to reject unknown params. Coerces string limits to integers with range 1-100.
- **`dlqQuerySchema`** -- validates `GET /api/admin/webhooks/dlq` query params (same shape as above).
- **`dlqReplayParamsSchema`** -- validates `POST /api/admin/webhooks/dlq/:id/replay` route params using Zod's `.uuid()` validator.

### Modified: `src/routes/webhooks.ts`

- Removed inline `webhooksQuerySchema` (regex-based string limit validation).
- Imported `listWebhooksQuerySchema` from centralized validators.
- Schema now uses `z.coerce.number()` for type-safe limit parsing with proper integer and range validation.

### Modified: `src/routes/adminWebhooks.ts`

- Added Zod validation for `GET /dlq` query params via `dlqQuerySchema` (previously raw `req.query` with no validation).
- Added Zod validation for `POST /dlq/:id/replay` params via `dlqReplayParamsSchema` (replaced manual UUID regex).
- Added structured pino logging with correlation IDs to both handlers.
- Removed `/* eslint-disable @typescript-eslint/no-explicit-any */` and replaced `any` cast with typed `ReplayResult` interface.

### Bugfixes (pre-existing)

- **`src/index.ts`** -- Fixed broken `webhooksRouter` import (exported `createWebhooksRouter`, not `webhooksRouter`). Router is now conditionally created via factory when `options.webhooks` is provided.
- **`src/routes/predictions.ts`** -- Added missing `accessLog` middleware import that blocked all tests using `createApp`.

## Tests

### New file: `tests/webhooksValidation.test.ts`

**38 tests**, all passing:

**Schema unit tests (19):**

- `listWebhooksQuerySchema` -- valid inputs, empty cursor, zero/negative/non-integer/max limit, unknown params
- `dlqQuerySchema` -- empty query, valid params, unknown params, zero/max limit
- `dlqReplayParamsSchema` -- valid UUID, invalid format, empty string, wrong length, non-hex chars

**Integration tests (19):**

- `GET /api/webhooks` -- auth (403 without/with non-admin), validation (400 for bad limit/cursor/unknown params), success (200 with valid params, pagination, requestId in errors)
- `GET /api/admin/webhooks/dlq` -- auth, validation for limit and unknown params
- `POST /api/admin/webhooks/dlq/:id/replay` -- auth, 400 for invalid UUID, 404 for non-existent row

## Validation Behavior

All endpoints now return a standardized error envelope on invalid input:

```json
{
  "error": {
    "code": "validation_error",
    "message": "<specific Zod error message>",
    "requestId": "<correlation ID>"
  }
}
```

Unknown query parameters are rejected (`.strict()` mode) to keep route boundaries explicit and avoid silently ignoring malformed input.

## Files Changed

| File | Action | Lines changed |
|------|--------|--------------|
| `src/validators/webhooks.ts` | Added | +75 |
| `src/routes/webhooks.ts` | Modified | -15, +5 |
| `src/routes/adminWebhooks.ts` | Modified | -15, +68 |
| `src/routes/predictions.ts` | Modified | +1 |
| `src/index.ts` | Modified | -4, +7 |
| `tests/webhooksValidation.test.ts` | Added | +379 |

## Checklist

- [x] Implementation matches the description
- [x] Tests added and passing (38/38)
- [x] ESLint clean
- [x] Follows repo conventions (factory pattern, error response shape, log events)
- [x] Input validation at the boundary with standardized error envelope
- [x] Structured logging with correlation IDs
- [x] Clear documentation and inline comments

Closes #433
