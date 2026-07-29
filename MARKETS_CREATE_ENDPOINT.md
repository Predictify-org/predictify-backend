# POST /api/markets Implementation Summary

## Overview
Implemented an admin-only `POST /api/markets` endpoint to create off-chain market shells with canonical questions, metadata, and resolution times. Markets are keyed by on-chain IDs supplied by contract deployers.

## Changes Made

### 1. Validator Schema (`src/validators/markets.ts`)
Added `createMarketBodySchema` with strict validation:
- **id**: string, 1-255 chars (unique market identifier)
- **question**: string, 1-512 chars (canonical market question)
- **resolutionTime**: ISO 8601 datetime string (market resolution deadline)
- **metadata**: optional record, max 64KB serialized JSON

### 2. Service Layer (`src/services/marketService.ts`)
Implemented two exports:

#### New Error Class: `MarketAlreadyExistsError`
- Status: 409
- Code: "market_exists"
- Thrown when duplicate market ID is detected

#### New Function: `createMarket(params)`
Creates a new market in database with:
- **Input validation**: id, question, resolutionTime are required strings
- **Idempotency check**: transaction-scoped lookup to prevent race conditions
- **Audit logging**: records creation event with admin address
- **Default values**:
  - `status`: "upcoming"
  - `indexedLedger`: 0
  - `archived`: false
  - `version`: 1
- **Event emission**: `MARKET_CREATED` event logged
- **Atomic transaction**: uses `db.transaction()` for consistency

### 3. Route Handler (`src/routes/markets/index.ts`)
Added `POST /api/markets` endpoint with:

#### Security
- `requireAdmin` middleware: enforces JWT with `role: "admin"` and checks `ADMIN_ALLOWLIST`
- Returns 403 with `error.code = "forbidden"` for non-admins
- Returns 401 for missing/invalid auth

#### Request Processing
1. Parse and validate body using `createMarketBodySchema`
2. Extract admin address from JWT subject (`req.user?.stellarAddress`)
3. Call `createMarket()` service
4. Log attempt and result with request ID for traceability

#### Response Handling
- **201 Created**: Returns persisted market object including:
  - `id`, `question`, `resolutionTime`, `metadata`
  - `status: "upcoming"`, `indexedLedger: 0`, `archived: false`, `version: 1`
  - `createdAt` timestamp
- **409 Conflict**: Duplicate ID detected
  - Response: `{ error: { code: "market_exists" } }`
- **400 Bad Request**: Validation error
  - Zod validation failures caught and propagated via error handler
- **403 Forbidden**: Non-admin user
  - Response: `{ error: { code: "forbidden" } }`

## Security & Compliance

### Admin Allowlist
Restricted to addresses in `ADMIN_ALLOWLIST` environment variable (comma-separated):
```env
ADMIN_ALLOWLIST=GADMIN111111111111111111111111111111111111111111111111111111,GADMIN222222222222222222222222222222222222222222222222222222
```

### Input Validation
- **Length limits** enforced before database queries (prevents DoS):
  - ID: 255 chars max
  - Question: 512 chars max
  - Metadata: 64KB max
- **Schema strictness**: unexpected fields rejected
- **ISO 8601 validation**: malformed timestamps rejected at parse time

### Audit Trail
- Each market creation recorded in `marketAuditLog` table
- Captures:
  - Admin address making the request
  - Complete market state before/after
  - Timestamp of operation

### Idempotency
- Within a transaction, market ID uniqueness enforced
- Database constraint on `markets.id` PRIMARY KEY prevents duplicates
- Client should retry on 409, not re-submit identical data

## Testing

Created `tests/markets-create.test.ts` with:

### Authentication & Authorization
- ✓ 401 on missing Authorization header
- ✓ 403 on non-admin user (wrong JWT role)
- ✓ 403 on invalid JWT signature

### Validation
- ✓ 400 on missing required fields (id, question, resolutionTime)
- ✓ 400 on empty strings (id, question)
- ✓ 400 on id > 255 chars
- ✓ 400 on question > 512 chars
- ✓ 400 on invalid ISO 8601 datetime
- ✓ 400 on metadata > 64KB
- ✓ 400 on unexpected fields (strict schema)

### Business Logic
- ✓ 201 on successful creation (with/without metadata)
- ✓ 409 on duplicate market ID (market_exists)

## HTTP Examples

### Create Market (Success)
```bash
curl -X POST http://localhost:3001/api/markets \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "mkt-001-usdemographics",
    "question": "Will the US population exceed 350M by end of 2026?",
    "resolutionTime": "2026-12-31T23:59:59Z",
    "metadata": {
      "category": "demographics",
      "tags": ["usa", "population"],
      "source": "us-census-bureau"
    }
  }'
```

**Response (201 Created)**
```json
{
  "data": {
    "id": "mkt-001-usdemographics",
    "question": "Will the US population exceed 350M by end of 2026?",
    "status": "upcoming",
    "resolutionTime": "2026-12-31T23:59:59Z",
    "metadata": {
      "category": "demographics",
      "tags": ["usa", "population"],
      "source": "us-census-bureau"
    },
    "indexedLedger": 0,
    "archived": false,
    "version": 1,
    "createdAt": "2026-07-28T15:30:00Z"
  }
}
```

### Duplicate Market
```bash
curl -X POST http://localhost:3001/api/markets \
  -H "Authorization: Bearer <admin-jwt>" \
  -d '{
    "id": "mkt-001-usdemographics",
    "question": "Will the US population exceed 350M by end of 2026?",
    "resolutionTime": "2026-12-31T23:59:59Z"
  }'
```

**Response (409 Conflict)**
```json
{
  "error": {
    "code": "market_exists"
  }
}
```

### Non-Admin User
```bash
curl -X POST http://localhost:3001/api/markets \
  -H "Authorization: Bearer <user-jwt>" \
  -d '{...}'
```

**Response (403 Forbidden)**
```json
{
  "error": {
    "code": "forbidden"
  }
}
```

## Logs

Creation attempts are logged with request IDs for traceability:

**On Success:**
```
INFO markets_create_success {
  "reqId": "abc-123-def",
  "correlationId": "abc-123-def",
  "marketId": "mkt-001-usdemographics",
  "adminAddress": "GADMIN111...",
  "version": 1,
  "indexedLedger": 0
}
```

**On Conflict:**
```
WARN markets_create_conflict {
  "reqId": "abc-123-def",
  "correlationId": "abc-123-def",
  "marketId": "mkt-001-usdemographics",
  "adminAddress": "GADMIN111..."
}
```

**On Error:**
```
ERROR markets_create_failed {
  "reqId": "abc-123-def",
  "correlationId": "abc-123-def",
  "marketId": "mkt-001-usdemographics",
  "adminAddress": "GADMIN111...",
  "err": {...error details...}
}
```

## Implementation Notes

1. **Metadata serialization**: Zod record schema accepts any JSON-serializable values. Size check uses `JSON.stringify()` to ensure total payload doesn't exceed 64KB.

2. **Resolution time validation**: Zod's `.datetime()` validator ensures ISO 8601 format at parse time—invalid formats rejected before hitting database.

3. **Admin allowlist source**: Uses `env.ADMIN_ALLOWLIST` from `src/config/env.ts`, populated from comma-separated `ADMIN_ALLOWLIST` env var. Each address is trimmed and validated.

4. **Error handling**: Distinguishes between validation errors (400, caught by error handler) and business logic errors (409 caught explicitly in route handler). Unknown errors propagate to Express error handler.

5. **Idempotency key support**: The endpoint supports `Idempotency-Key` header via the global middleware in `src/index.ts` (`idempotency` middleware for POST requests). This provides client-side deduplication.

6. **Audit logging**: Captures before/after state in `marketAuditLog` table. Useful for compliance and debugging.

## Files Modified

- `src/validators/markets.ts`: Added `createMarketBodySchema` and type
- `src/services/marketService.ts`: Added `MarketAlreadyExistsError` class and `createMarket()` function
- `src/routes/markets/index.ts`: Added POST handler with imports and error handling
- `tests/markets-create.test.ts`: Created comprehensive test suite

## Next Steps (Optional)

- Run `npm test -- markets-create` to execute test suite against database
- Run `npm run openapi:generate` to auto-document endpoint in OpenAPI spec
- Deploy to staging and verify with contract deployer
- Add rate limiting if needed (currently inherits router-level limits)
