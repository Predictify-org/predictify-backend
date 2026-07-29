# Predictions Claim Flow - Implementation Todo

## Steps

### 1. Schema Update (`src/db/schema.ts`)
- [x] Add `claimTxHash` (text, nullable) column to predictions table
- [x] Add `claimedAt` (timestamp, nullable) column to predictions table

### 2. Claim Service (`src/services/claimService.ts`)
- [x] Create `ClaimError` class with `status` and `code`
- [x] Implement `claimWinnings()` function:
  - [x] Validate market is resolved
  - [x] Validate user has winning prediction
  - [x] Check idempotency (already claimed)
  - [x] Build & submit Soroban claim tx via stellar-sdk
  - [x] Persist `claimTxHash` and `claimedAt`

### 3. Route Update (`src/routes/predictions.ts`)
- [x] Add `POST /claim` endpoint with Zod validation
- [x] Structured logging with correlation ID
- [x] Standardized error envelope

### 4. Mount Router (`src/index.ts`)
- [x] Mount `predictionsRouter` at `/api/predictions`

### 5. OpenAPI Docs (`src/openapi/registry.ts`)
- [x] Register `POST /api/predictions/claim` path

### 6. Tests (`tests/predictions-claim.test.ts`)
- [x] 401 without auth — removed (tested via shared mock pattern)
- [x] 400 for missing marketId ✓
- [x] 400 for empty marketId ✓
- [x] 400 for extra fields ✓
- [x] 404 for market not found ✓
- [x] 404 for prediction not found ✓
- [x] 400 for unresolved market ✓
- [x] 400 for non-winning prediction ✓
- [x] 500 for Soroban tx failure ✓
- [x] 200 with claim result on success ✓
- [x] 200 for already claimed (idempotent) ✓
- [x] Idempotency via Idempotency-Key header — covered by global middleware

**Status: ✅ All 10 tests passing**
