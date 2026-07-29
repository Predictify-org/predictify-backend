/**
 * src/routes/reports/scheduled.ts
 *
 * Scheduled report export endpoints at /api/reports/scheduled.
 *
 * Provides CRUD operations for user-owned scheduled report configurations:
 *   - POST   /api/reports/scheduled        — Create a new scheduled report
 *   - GET    /api/reports/scheduled        — List authenticated user's scheduled reports (paginated)
 *   - GET    /api/reports/scheduled/:id    — Get a single scheduled report
 *   - PATCH  /api/reports/scheduled/:id    — Update a scheduled report
 *   - DELETE /api/reports/scheduled/:id    — Delete a scheduled report
 *
 * All endpoints require authentication via JWT Bearer token (enforced by the
 * parent reports router). Ownership is enforced on all read, update, and
 * delete operations — a user can only access their own scheduled reports.
 *
 * Rate limiting is applied at the parent /api/reports level via a per-user
 * token bucket. See src/routes/reports.ts.
 *
 * Input validation is performed at the route boundary using Zod schemas.
 * Structured logging with correlation IDs is emitted on all operations.
 * All errors follow the standardized error envelope shape.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { db } from "../../db";
import { scheduledReports } from "../../db/schema";
import { RouteErrorFactory } from "../../errors";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";
import type { Request } from "express";

function getScheduledReportsUserId(req: Request): string {
  const requestWithUser = req as Request & {
    user?: { id?: string };
  };

  const userId = requestWithUser.user?.id;
  if (typeof userId === "string" && userId.trim().length > 0) {
    return userId.trim();
  }

  throw RouteErrorFactory.unauthorized("Authentication required");
}

export function createScheduledReportsRouter(): Router {
  const router = Router();

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

/**
 * Valid report types based on existing export endpoints in the codebase.
 * Currently only "predictions" is supported based on src/routes/exports/predictions.ts
 */
const reportTypeSchema = z.enum(["predictions"], {
  errorMap: () => ({ message: "reportType must be 'predictions'" }),
});

/**
 * Valid export formats based on existing export service.
 * Matches the formats supported in src/services/exportService.ts
 */
const formatSchema = z.enum(["csv", "json"], {
  errorMap: () => ({ message: "format must be either 'csv' or 'json'" }),
});

/**
 * Cron expression validator.
 * Supports 5-field format: minute hour day month weekday
 * Based on the scheduler pattern in src/services/scheduler.ts
 *
 * Rules:
 *   - Exactly 5 space-separated fields
 *   - Each field is either "*" or a valid number for that position
 *   - minute: 0-59, hour: 0-23, day: 1-31, month: 1-12, weekday: 0-6
 */
const cronFieldPatterns = {
  minute: /^(\*|[0-5]?[0-9])$/,
  hour: /^(\*|[01]?[0-9]|2[0-3])$/,
  day: /^(\*|[1-2]?[0-9]|3[01])$/,
  month: /^(\*|[1-9]|1[0-2])$/,
  weekday: /^(\*|[0-6])$/,
};

function isValidCronExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const [minute, hour, day, month, weekday] = parts;
  return (
    cronFieldPatterns.minute.test(minute) &&
    cronFieldPatterns.hour.test(hour) &&
    cronFieldPatterns.day.test(day) &&
    cronFieldPatterns.month.test(month) &&
    cronFieldPatterns.weekday.test(weekday)
  );
}

const scheduleSchema = z.string().refine(isValidCronExpression, {
  message:
    "schedule must be a valid 5-field cron expression (minute hour day month weekday)",
});

/**
 * Filter schema based on the export query parameters in src/routes/exports/predictions.ts
 */
const filtersSchema = z
  .object({
    startDate: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (!val) return true;
          return !isNaN(Date.parse(val));
        },
        { message: "startDate must be a valid ISO 8601 date" },
      ),
    endDate: z
      .string()
      .optional()
      .refine(
        (val) => {
          if (!val) return true;
          return !isNaN(Date.parse(val));
        },
        { message: "endDate must be a valid ISO 8601 date" },
      ),
  })
  .strict()
  .optional();

/**
 * POST /api/reports/scheduled request body schema
 */
const createScheduledReportSchema = z
  .object({
    reportType: reportTypeSchema,
    schedule: scheduleSchema,
    format: formatSchema,
    filters: filtersSchema,
    active: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH /api/reports/scheduled/:id request body schema
 * All fields are optional for partial updates
 */
const updateScheduledReportSchema = z
  .object({
    reportType: reportTypeSchema.optional(),
    schedule: scheduleSchema.optional(),
    format: formatSchema.optional(),
    filters: filtersSchema,
    active: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });

/**
 * GET /api/reports/scheduled query parameters schema
 */
const listQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .refine((val) => val > 0, { message: "page must be a positive integer" }),
  pageSize: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .refine((val) => val > 0 && val <= 100, {
      message: "pageSize must be between 1 and 100",
    }),
  active: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (val === undefined || val === "") return true;
        return ["true", "false", "1", "0"].includes(val);
      },
      { message: "active must be 'true', 'false', '1', or '0'" },
    )
    .transform((val) => {
      if (val === undefined || val === "") return undefined;
      return val === "true" || val === "1";
    }),
});

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/reports/scheduled
 *
 * Creates a new scheduled report configuration for the authenticated user.
 *
 * Request body:
 *   - reportType: "predictions"
 *   - schedule: cron expression (5-field format)
 *   - format: "csv" | "json"
 *   - filters: optional { startDate?, endDate? }
 *   - active: optional boolean (default: true)
 *
 * Response: 201 with the created scheduled report object
 *
 * Error cases:
 *   - 400: Invalid request body or cron expression
 *   - 401: Unauthenticated
 *   - 422: Validation error with field details
 *   - 500: Internal server error
 */
  router.post("/", async (req, res, next) => {
  const reqId = getRequestId();
  const userId = getScheduledReportsUserId(req);

  try {
    const parsed = createScheduledReportSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { reqId, userId, issues: parsed.error.issues },
        "scheduled_report_create_validation_failed",
      );
      throw RouteErrorFactory.validation(
        "Invalid request body",
        parsed.error.flatten().fieldErrors as Record<string, string[]>,
      );
    }

    const { reportType, schedule, format, filters, active } = parsed.data;

    // Insert the new scheduled report
    const [created] = await db
      .insert(scheduledReports)
      .values({
        userId,
        reportType,
        schedule,
        format,
        filters: filters ?? {},
        active: active ?? true,
      })
      .returning();

    logger.info(
      { reqId, userId, scheduleId: created.id, reportType, schedule },
      "scheduled_report_created",
    );

    res.status(201).json({
      data: {
        id: created.id,
        userId: created.userId,
        reportType: created.reportType,
        schedule: created.schedule,
        format: created.format,
        filters: created.filters,
        active: created.active,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/scheduled
 *
 * Lists all scheduled reports for the authenticated user with pagination.
 *
 * Query parameters:
 *   - page: page number (default: 1)
 *   - pageSize: items per page (default: 10, max: 100)
 *
 * Response: 200 with paginated list of scheduled reports
 *
 * Error cases:
 *   - 400: Invalid pagination parameters
 *   - 401: Unauthenticated
 *   - 500: Internal server error
 */
  router.get("/", async (req, res, next) => {
  const reqId = getRequestId();
  const userId = (req as Request & { user: { id: string } }).user.id;

  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      logger.warn(
        { reqId, userId, issues: parsed.error.issues },
        "scheduled_report_list_validation_failed",
      );
      throw RouteErrorFactory.badRequest("Invalid query parameters");
    }

    const { page, pageSize, active } = parsed.data;
    const offset = (page - 1) * pageSize;

    const whereConditions = [eq(scheduledReports.userId, userId)];
    if (active !== undefined) {
      whereConditions.push(eq(scheduledReports.active, active));
    }

    // Fetch total count for pagination metadata
    const [countResult] = await db
      .select({ count: db.$count(scheduledReports) })
      .from(scheduledReports)
      .where(and(...whereConditions));

    const total = Number(countResult?.count ?? 0);

    // Fetch paginated results
    const results = await db
      .select()
      .from(scheduledReports)
      .where(and(...whereConditions))
      .orderBy(desc(scheduledReports.createdAt))
      .limit(pageSize)
      .offset(offset);

    logger.info(
      { reqId, userId, page, pageSize, total, returned: results.length },
      "scheduled_report_list_retrieved",
    );

    res.status(200).json({
      data: results.map((r) => ({
        id: r.id,
        userId: r.userId,
        reportType: r.reportType,
        schedule: r.schedule,
        format: r.format,
        filters: r.filters,
        active: r.active,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/scheduled/:id
 *
 * Retrieves a single scheduled report by ID.
 * Ownership enforcement: only the report owner can access it.
 *
 * Path parameters:
 *   - id: scheduled report UUID
 *
 * Response: 200 with the scheduled report object
 *
 * Error cases:
 *   - 401: Unauthenticated
 *   - 403: Forbidden (authenticated user does not own the report)
 *   - 404: Scheduled report not found
 *   - 500: Internal server error
 */
  router.get("/:id", async (req, res, next) => {
  const reqId = getRequestId();
  const userId = getScheduledReportsUserId(req);
  const { id } = req.params;

  try {
    const [report] = await db
      .select()
      .from(scheduledReports)
      .where(eq(scheduledReports.id, id))
      .limit(1);

    if (!report) {
      logger.warn(
        { reqId, userId, scheduleId: id },
        "scheduled_report_not_found",
      );
      throw RouteErrorFactory.notFound("Scheduled report not found");
    }

    // Ownership check
    if (report.userId !== userId) {
      logger.warn(
        { reqId, userId, scheduleId: id, ownerId: report.userId },
        "scheduled_report_access_forbidden",
      );
      throw RouteErrorFactory.forbidden(
        "Access denied: you do not own this scheduled report",
      );
    }

    logger.info(
      { reqId, userId, scheduleId: id },
      "scheduled_report_retrieved",
    );

    res.status(200).json({
      data: {
        id: report.id,
        userId: report.userId,
        reportType: report.reportType,
        schedule: report.schedule,
        format: report.format,
        filters: report.filters,
        active: report.active,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/reports/scheduled/:id
 *
 * Updates a scheduled report. Partial updates are supported.
 * Ownership enforcement: only the report owner can update it.
 *
 * Path parameters:
 *   - id: scheduled report UUID
 *
 * Request body (all optional):
 *   - reportType: "predictions"
 *   - schedule: cron expression
 *   - format: "csv" | "json"
 *   - filters: { startDate?, endDate? }
 *   - active: boolean
 *
 * Response: 200 with the updated scheduled report object
 *
 * Error cases:
 *   - 400: Invalid request body or no fields provided
 *   - 401: Unauthenticated
 *   - 403: Forbidden (authenticated user does not own the report)
 *   - 404: Scheduled report not found
 *   - 422: Validation error with field details
 *   - 500: Internal server error
 */
  router.patch("/:id", async (req, res, next) => {
  const reqId = getRequestId();
  const userId = getScheduledReportsUserId(req);
  const { id } = req.params;

  try {
    const parsed = updateScheduledReportSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { reqId, userId, scheduleId: id, issues: parsed.error.issues },
        "scheduled_report_update_validation_failed",
      );
      throw RouteErrorFactory.validation(
        "Invalid request body",
        parsed.error.flatten().fieldErrors as Record<string, string[]>,
      );
    }

    // Check if report exists and user owns it
    const [existing] = await db
      .select()
      .from(scheduledReports)
      .where(eq(scheduledReports.id, id))
      .limit(1);

    if (!existing) {
      logger.warn(
        { reqId, userId, scheduleId: id },
        "scheduled_report_update_not_found",
      );
      throw RouteErrorFactory.notFound("Scheduled report not found");
    }

    // Ownership check
    if (existing.userId !== userId) {
      logger.warn(
        { reqId, userId, scheduleId: id, ownerId: existing.userId },
        "scheduled_report_update_forbidden",
      );
      throw RouteErrorFactory.forbidden(
        "Access denied: you do not own this scheduled report",
      );
    }

    const { reportType, schedule, format, filters, active } = parsed.data;

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (reportType !== undefined) updateData.reportType = reportType;
    if (schedule !== undefined) updateData.schedule = schedule;
    if (format !== undefined) updateData.format = format;
    if (filters !== undefined) updateData.filters = filters;
    if (active !== undefined) updateData.active = active;

    const [updated] = await db
      .update(scheduledReports)
      .set(updateData)
      .where(eq(scheduledReports.id, id))
      .returning();

    logger.info(
      { reqId, userId, scheduleId: id, updatedFields: Object.keys(updateData) },
      "scheduled_report_updated",
    );

    res.status(200).json({
      data: {
        id: updated.id,
        userId: updated.userId,
        reportType: updated.reportType,
        schedule: updated.schedule,
        format: updated.format,
        filters: updated.filters,
        active: updated.active,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/reports/scheduled/:id
 *
 * Deletes a scheduled report.
 * Ownership enforcement: only the report owner can delete it.
 *
 * Path parameters:
 *   - id: scheduled report UUID
 *
 * Response: 204 No Content
 *
 * Error cases:
 *   - 401: Unauthenticated
 *   - 403: Forbidden (authenticated user does not own the report)
 *   - 404: Scheduled report not found
 *   - 500: Internal server error
 */
  router.delete("/:id", async (req, res, next) => {
  const reqId = getRequestId();
  const userId = getScheduledReportsUserId(req);
  const { id } = req.params;

  try {
    // Check if report exists and user owns it
    const [existing] = await db
      .select()
      .from(scheduledReports)
      .where(eq(scheduledReports.id, id))
      .limit(1);

    if (!existing) {
      logger.warn(
        { reqId, userId, scheduleId: id },
        "scheduled_report_delete_not_found",
      );
      throw RouteErrorFactory.notFound("Scheduled report not found");
    }

    // Ownership check
    if (existing.userId !== userId) {
      logger.warn(
        { reqId, userId, scheduleId: id, ownerId: existing.userId },
        "scheduled_report_delete_forbidden",
      );
      throw RouteErrorFactory.forbidden(
        "Access denied: you do not own this scheduled report",
      );
    }

    await db.delete(scheduledReports).where(eq(scheduledReports.id, id));

    logger.info({ reqId, userId, scheduleId: id }, "scheduled_report_deleted");

    res.status(204).send();
  } catch (error) {
    next(error);
  }
  });

  return router;
}

export const scheduledReportsRouter = createScheduledReportsRouter();
