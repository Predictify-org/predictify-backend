# Scheduled Reports API

## Overview

The Scheduled Reports API provides endpoints for managing recurring report export configurations. Users can create, list, update, and delete scheduled report jobs that will automatically generate and deliver reports based on cron schedules.

**Base URL:** `/api/reports/scheduled`

**Authentication:** All endpoints require JWT Bearer token authentication.

**Ownership:** Users can only access their own scheduled reports. Attempting to access another user's report returns a 403 Forbidden error.

---

## Endpoints

### POST /api/reports/scheduled

Creates a new scheduled report configuration.

**Authentication:** Required

**Request Body:**

```json
{
  "reportType": "predictions",
  "schedule": "0 2 * * *",
  "format": "csv",
  "filters": {
    "startDate": "2026-01-01T00:00:00Z",
    "endDate": "2026-12-31T23:59:59Z"
  },
  "active": true
}
```

**Fields:**

- `reportType` (required): Type of report. Currently supports:
  - `"predictions"` - Export user's prediction data
- `schedule` (required): Cron expression in 5-field format (minute hour day month weekday)
  - Example: `"0 2 * * *"` - Daily at 2:00 AM
  - Example: `"30 14 * * 1"` - Every Monday at 2:30 PM
  - Example: `"0 0 1 * *"` - First day of every month at midnight
- `format` (required): Export format
  - `"csv"` - Comma-separated values
  - `"json"` - JSON array
- `filters` (optional): Report-specific filter parameters
  - `startDate` (optional): ISO 8601 date string - Include records from this date onwards
  - `endDate` (optional): ISO 8601 date string - Include records up to this date
- `active` (optional): Whether the schedule is active. Default: `true`

**Response:** `201 Created`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "reportType": "predictions",
    "schedule": "0 2 * * *",
    "format": "csv",
    "filters": {
      "startDate": "2026-01-01T00:00:00Z",
      "endDate": "2026-12-31T23:59:59Z"
    },
    "active": true,
    "createdAt": "2026-07-24T12:00:00.000Z",
    "updatedAt": "2026-07-24T12:00:00.000Z"
  }
}
```

**Error Responses:**

- `400 Bad Request` - Invalid request body structure
- `401 Unauthorized` - Missing or invalid authentication token
- `422 Validation Error` - Invalid field values with detailed error messages
- `500 Internal Server Error` - Server error

---

### GET /api/reports/scheduled

Lists all scheduled reports for the authenticated user with pagination.

**Authentication:** Required

**Query Parameters:**

- `page` (optional): Page number (default: 1, must be positive integer)
- `pageSize` (optional): Items per page (default: 10, min: 1, max: 100)

**Example Request:**

```
GET /api/reports/scheduled?page=2&pageSize=20
```

**Response:** `200 OK`

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "reportType": "predictions",
      "schedule": "0 2 * * *",
      "format": "csv",
      "filters": {},
      "active": true,
      "createdAt": "2026-07-24T12:00:00.000Z",
      "updatedAt": "2026-07-24T12:00:00.000Z"
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "userId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "reportType": "predictions",
      "schedule": "30 14 * * 1",
      "format": "json",
      "filters": {
        "startDate": "2026-01-01T00:00:00Z"
      },
      "active": false,
      "createdAt": "2026-07-23T12:00:00.000Z",
      "updatedAt": "2026-07-23T13:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 2,
    "totalPages": 1
  }
}
```

**Error Responses:**

- `400 Bad Request` - Invalid pagination parameters
- `401 Unauthorized` - Missing or invalid authentication token
- `500 Internal Server Error` - Server error

---

### GET /api/reports/scheduled/:id

Retrieves a single scheduled report by ID.

**Authentication:** Required

**Path Parameters:**

- `id`: Scheduled report UUID

**Example Request:**

```
GET /api/reports/scheduled/550e8400-e29b-41d4-a716-446655440000
```

**Response:** `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "reportType": "predictions",
    "schedule": "0 2 * * *",
    "format": "csv",
    "filters": {},
    "active": true,
    "createdAt": "2026-07-24T12:00:00.000Z",
    "updatedAt": "2026-07-24T12:00:00.000Z"
  }
}
```

**Error Responses:**

- `401 Unauthorized` - Missing or invalid authentication token
- `403 Forbidden` - User does not own this scheduled report
- `404 Not Found` - Scheduled report not found
- `500 Internal Server Error` - Server error

---

### PATCH /api/reports/scheduled/:id

Updates a scheduled report. Partial updates are supported - only provide the fields you want to change.

**Authentication:** Required

**Path Parameters:**

- `id`: Scheduled report UUID

**Request Body (all fields optional):**

```json
{
  "schedule": "30 14 * * 1",
  "format": "json",
  "active": false
}
```

**Response:** `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "reportType": "predictions",
    "schedule": "30 14 * * 1",
    "format": "json",
    "filters": {},
    "active": false,
    "createdAt": "2026-07-24T12:00:00.000Z",
    "updatedAt": "2026-07-24T13:00:00.000Z"
  }
}
```

**Error Responses:**

- `400 Bad Request` - No fields provided for update
- `401 Unauthorized` - Missing or invalid authentication token
- `403 Forbidden` - User does not own this scheduled report
- `404 Not Found` - Scheduled report not found
- `422 Validation Error` - Invalid field values
- `500 Internal Server Error` - Server error

---

### DELETE /api/reports/scheduled/:id

Deletes a scheduled report.

**Authentication:** Required

**Path Parameters:**

- `id`: Scheduled report UUID

**Example Request:**

```
DELETE /api/reports/scheduled/550e8400-e29b-41d4-a716-446655440000
```

**Response:** `204 No Content`

No response body.

**Error Responses:**

- `401 Unauthorized` - Missing or invalid authentication token
- `403 Forbidden` - User does not own this scheduled report
- `404 Not Found` - Scheduled report not found
- `500 Internal Server Error` - Server error

---

## Error Envelope

All error responses follow a standardized envelope format:

```json
{
  "error": {
    "type": "ValidationError",
    "message": "Invalid request body",
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "fields": {
      "schedule": [
        "schedule must be a valid 5-field cron expression (minute hour day month weekday)"
      ]
    }
  }
}
```

**Error Fields:**

- `type`: Error type code (e.g., `ValidationError`, `NotFound`, `Forbidden`, `InternalError`)
- `message`: Human-readable error message
- `correlationId`: Unique request identifier for debugging and log correlation
- `fields` (optional): Validation-specific field errors

---

## Cron Expression Format

Scheduled reports use standard 5-field cron expressions:

```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday = 0)
│ │ │ │ │
* * * * *
```

**Examples:**

- `"0 2 * * *"` - Every day at 2:00 AM
- `"30 14 * * 1"` - Every Monday at 2:30 PM
- `"0 0 1 * *"` - First day of every month at midnight
- `"0 */4 * * *"` - Every 4 hours (not yet supported - use explicit values)
- `"15 10 * * 0"` - Every Sunday at 10:15 AM

**Validation Rules:**

- Must contain exactly 5 space-separated fields
- Each field must be either `*` (any value) or a valid number for that position
- Minute: 0-59
- Hour: 0-23
- Day of month: 1-31
- Month: 1-12
- Day of week: 0-6 (0 = Sunday)

---

## Correlation IDs

Every request is assigned a unique correlation ID that appears in:

1. Response error envelopes (`error.correlationId`)
2. Server logs (as `reqId` or `correlationId`)
3. Can be provided by client via `X-Request-Id` header (sanitized to 64 chars max)

Correlation IDs enable:

- Tracing a request through logs
- Debugging production issues
- Support ticket resolution

When reporting issues, always include the correlation ID from the error response.

---

## Security & Ownership

### Authentication

All endpoints require a valid JWT Bearer token in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Missing or invalid tokens return `401 Unauthorized`.

### Ownership Enforcement

Every scheduled report is owned by the user who created it. All read, update, and delete operations verify that:

```
schedule.userId === authenticatedUser.id
```

Attempting to access another user's scheduled report returns `403 Forbidden`.

### Input Validation

All inputs are validated at the route boundary before any database interaction:

- Cron expressions are validated for safety before reaching the job scheduler
- Date filters are validated for correct ISO 8601 format
- Enum fields (reportType, format) are restricted to known safe values
- No user input is interpolated into SQL queries (parameterized queries only)

### PII Considerations

- Report filters may contain user data and are stored as JSONB
- Filters are not logged at levels that persist sensitive values
- Internal database errors are logged with full detail but returned to clients with generic messages only

---

## Database Schema

The `scheduled_reports` table structure:

```sql
CREATE TABLE "scheduled_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "report_type" text NOT NULL,
  "schedule" text NOT NULL,
  "format" text NOT NULL,
  "filters" jsonb DEFAULT '{}'::jsonb,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "scheduled_reports" 
  ADD CONSTRAINT "scheduled_reports_user_id_users_id_fk" 
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") 
  ON DELETE cascade;

CREATE INDEX "scheduled_reports_user_id_idx" 
  ON "scheduled_reports" USING btree ("user_id");

CREATE INDEX "scheduled_reports_active_idx" 
  ON "scheduled_reports" USING btree ("active");
```

**Indexes:**

- Primary key on `id` for fast lookups
- Index on `user_id` for fast user-scoped queries
- Index on `active` for scheduler queries filtering only active reports
- Foreign key cascade delete ensures orphaned reports are cleaned up when users are deleted

---

## Future Enhancements

Potential future features (not yet implemented):

1. **Advanced Cron Syntax** - Support for ranges (`1-5`), lists (`1,3,5`), and step values (`*/5`)
2. **Delivery Channels** - Email, webhook, or S3 bucket delivery instead of manual download
3. **Report History** - Track execution history and store generated reports
4. **Execution Logs** - View success/failure status of past report runs
5. **Report Templates** - Predefined filter presets for common reporting needs
6. **Multiple Report Types** - Support for market summaries, user portfolios, leaderboards, etc.
7. **Rate Limiting** - Per-user limits on number of active scheduled reports
8. **Retry Logic** - Automatic retry on transient failures during report generation
9. **Notification on Completion** - Alert users when reports are ready for download

---

## Testing

The implementation includes comprehensive test coverage (90%+) covering:

- ✅ Success cases for all CRUD operations
- ✅ Authentication failures (401)
- ✅ Authorization failures - accessing other users' reports (403)
- ✅ Not found errors (404)
- ✅ Validation errors with detailed field errors (400/422)
- ✅ Invalid cron expressions
- ✅ Invalid date formats
- ✅ Invalid enum values
- ✅ Database errors (500)
- ✅ Pagination edge cases
- ✅ Correlation ID presence in logs and error responses
- ✅ Ownership enforcement (vacuousness checks)

---

## Examples

### Create a Daily CSV Report

```bash
curl -X POST https://api.predictify.io/api/reports/scheduled \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reportType": "predictions",
    "schedule": "0 2 * * *",
    "format": "csv",
    "filters": {
      "startDate": "2026-01-01T00:00:00Z"
    }
  }'
```

### List All Scheduled Reports

```bash
curl https://api.predictify.io/api/reports/scheduled \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Update Schedule to Weekly

```bash
curl -X PATCH https://api.predictify.io/api/reports/scheduled/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 2 * * 1"
  }'
```

### Deactivate a Report

```bash
curl -X PATCH https://api.predictify.io/api/reports/scheduled/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "active": false
  }'
```

### Delete a Report

```bash
curl -X DELETE https://api.predictify.io/api/reports/scheduled/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```
