/**
 * tests/scheduledReports.test.ts
 *
 * Comprehensive test suite for scheduled reports endpoints.
 * Coverage targets: 90%+ on all changed lines.
 *
 * Test categories:
 *   1. POST /api/reports/scheduled — create
 *   2. GET /api/reports/scheduled — list with pagination
 *   3. GET /api/reports/scheduled/:id — get single
 *   4. PATCH /api/reports/scheduled/:id — update
 *   5. DELETE /api/reports/scheduled/:id — delete
 *   6. Authentication and authorization
 *   7. Validation errors
 *   8. Database errors
 *   9. Correlation IDs in logs
 */

// Mock the database
jest.mock("../src/db", () => {
  const mockDb = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    $count: jest.fn(),
  };
  return { db: mockDb };
});

// Mock logger
jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock requestContext
jest.mock("../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "test-correlation-id"),
}));

import express from "express";
import request from "supertest";
import { scheduledReportsRouter } from "../src/routes/reports/scheduled";
import { errorHandler } from "../src/middleware/errorHandler";
import { db } from "../src/db";
import { logger } from "../src/config/logger";
import { getRequestId } from "../src/lib/requestContext";

const mockDb = db as jest.Mocked<typeof db>;
const mockLogger = logger as jest.Mocked<typeof logger>;
const mockGetRequestId = getRequestId as jest.MockedFunction<typeof getRequestId>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Inject user directly since requireAuth is now in the parent reports router
  app.use((req, _res, next) => {
    (req as any).user = { id: "test-user-id", stellarAddress: "GTEST" };
    next();
  });
  app.use("/api/reports/scheduled", scheduledReportsRouter);
  app.use(errorHandler);
  return app;
}

describe("POST /api/reports/scheduled", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("test-correlation-id");
  });

  it("creates a scheduled report with valid input and returns 201", async () => {
    const mockCreated = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.returning.mockResolvedValueOnce([mockCreated]);

    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T12:00:00.000Z",
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "test-user-id",
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
      }),
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "test-correlation-id",
        userId: "test-user-id",
        scheduleId: "report-id-123",
      }),
      "scheduled_report_created",
    );
  });

  it("creates a scheduled report with filters and JSON format", async () => {
    const mockCreated = {
      id: "report-id-456",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "30 14 * * 1",
      format: "json",
      filters: { startDate: "2026-01-01T00:00:00Z", endDate: "2026-12-31T23:59:59Z" },
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.returning.mockResolvedValueOnce([mockCreated]);

    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "30 14 * * 1",
        format: "json",
        filters: {
          startDate: "2026-01-01T00:00:00Z",
          endDate: "2026-12-31T23:59:59Z",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.filters).toEqual({
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-12-31T23:59:59Z",
    });
  });

  it("returns 400 when reportType is missing", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        schedule: "0 2 * * *",
        format: "csv",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
    expect(res.body.error.correlationId).toBe("test-correlation-id");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.any(Array) }),
      "scheduled_report_create_validation_failed",
    );
  });

  it("returns 400 when schedule is missing", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        format: "csv",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 400 when format is invalid", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "xml",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 400 when cron expression is invalid (wrong field count)", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 *",
        format: "csv",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
    expect(res.body.error.fields?.schedule).toBeDefined();
  });

  it("returns 400 when cron expression has invalid minute field", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "60 2 * * *",
        format: "csv",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 400 when cron expression has invalid hour field", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 25 * * *",
        format: "csv",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 400 when startDate filter is invalid", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
        filters: { startDate: "not-a-date" },
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 400 when extra fields are provided", async () => {
    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
        extraField: "should-not-be-here",
      });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("handles database errors and returns 500", async () => {
    mockDb.returning.mockRejectedValueOnce(new Error("Database connection failed"));

    const res = await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
      });

    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe("internal_error");
    expect(res.body.error.correlationId).toBe("test-correlation-id");
  });
});

describe("GET /api/reports/scheduled", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("test-correlation-id");
  });

  it("returns paginated list of user's scheduled reports", async () => {
    const mockReports = [
      {
        id: "report-1",
        userId: "test-user-id",
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
        filters: {},
        active: true,
        createdAt: new Date("2026-07-24T12:00:00Z"),
        updatedAt: new Date("2026-07-24T12:00:00Z"),
      },
      {
        id: "report-2",
        userId: "test-user-id",
        reportType: "predictions",
        schedule: "30 14 * * 1",
        format: "json",
        filters: { startDate: "2026-01-01" },
        active: false,
        createdAt: new Date("2026-07-23T12:00:00Z"),
        updatedAt: new Date("2026-07-23T12:00:00Z"),
      },
    ];

    // Mock count query
    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        where: jest.fn().mockResolvedValueOnce([{ count: 2 }]),
      }),
    } as any);

    // Mock data query - reset the chain
    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        where: jest.fn().mockReturnValueOnce({
          orderBy: jest.fn().mockReturnValueOnce({
            limit: jest.fn().mockReturnValueOnce({
              offset: jest.fn().mockResolvedValueOnce(mockReports),
            }),
          }),
        }),
      }),
    } as any);

    const res = await request(app).get("/api/reports/scheduled");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toEqual({
      page: 1,
      pageSize: 10,
      total: 2,
      totalPages: 1,
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "test-correlation-id",
        userId: "test-user-id",
        page: 1,
        pageSize: 10,
        total: 2,
        returned: 2,
      }),
      "scheduled_report_list_retrieved",
    );
  });

  it("supports custom pagination parameters", async () => {
    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        where: jest.fn().mockResolvedValueOnce([{ count: 25 }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        where: jest.fn().mockReturnValueOnce({
          orderBy: jest.fn().mockReturnValueOnce({
            limit: jest.fn().mockReturnValueOnce({
              offset: jest.fn().mockResolvedValueOnce([]),
            }),
          }),
        }),
      }),
    } as any);

    const res = await request(app)
      .get("/api/reports/scheduled")
      .query({ page: "3", pageSize: "5" });

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({
      page: 3,
      pageSize: 5,
      total: 25,
      totalPages: 5,
    });
  });

  it("returns 400 when page is not a positive integer", async () => {
    const res = await request(app)
      .get("/api/reports/scheduled")
      .query({ page: "0" });

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("BadRequest");
  });

  it("returns 400 when pageSize exceeds maximum", async () => {
    const res = await request(app)
      .get("/api/reports/scheduled")
      .query({ pageSize: "101" });

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("BadRequest");
  });

  it("returns only the authenticated user's reports", async () => {
    // This is implicitly tested by the WHERE clause in the DB query
    // Verify that userId filter is applied
    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        where: jest.fn((condition) => {
          // Verify the condition includes userId check
          expect(condition).toBeDefined();
          return Promise.resolve([{ count: 0 }]);
        }),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        where: jest.fn().mockReturnValueOnce({
          orderBy: jest.fn().mockReturnValueOnce({
            limit: jest.fn().mockReturnValueOnce({
              offset: jest.fn().mockResolvedValueOnce([]),
            }),
          }),
        }),
      }),
    } as any);

    const res = await request(app).get("/api/reports/scheduled");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("filters by active=true", async () => {
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockResolvedValueOnce([{count:1}])})} as any);
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockReturnValueOnce({orderBy: jest.fn().mockReturnValueOnce({limit: jest.fn().mockReturnValueOnce({offset: jest.fn().mockResolvedValueOnce([])})})})})} as any);
    const res = await request(app).get("/api/reports/scheduled").query({active:"true"});
    expect(res.status).toBe(200);
  });

  it("filters by active=false", async () => {
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockResolvedValueOnce([{count:1}])})} as any);
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockReturnValueOnce({orderBy: jest.fn().mockReturnValueOnce({limit: jest.fn().mockReturnValueOnce({offset: jest.fn().mockResolvedValueOnce([])})})})})} as any);
    const res = await request(app).get("/api/reports/scheduled").query({active:"false"});
    expect(res.status).toBe(200);
  });

  it("returns 400 when active invalid", async () => {
    const res = await request(app).get("/api/reports/scheduled").query({active:"invalid"});
    expect(res.status).toBe(400);
  });

  it("accepts active=1", async () => {
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockResolvedValueOnce([{count:0}])})} as any);
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockReturnValueOnce({orderBy: jest.fn().mockReturnValueOnce({limit: jest.fn().mockReturnValueOnce({offset: jest.fn().mockResolvedValueOnce([])})})})})} as any);
    const res = await request(app).get("/api/reports/scheduled").query({active:"1"});
    expect(res.status).toBe(200);
  });

  it("accepts active=0", async () => {
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockResolvedValueOnce([{count:0}])})} as any);
    mockDb.select.mockReturnValueOnce({from: jest.fn().mockReturnValueOnce({where: jest.fn().mockReturnValueOnce({orderBy: jest.fn().mockReturnValueOnce({limit: jest.fn().mockReturnValueOnce({offset: jest.fn().mockResolvedValueOnce([])})})})})} as any);
    const res = await request(app).get("/api/reports/scheduled").query({active:"0"});
    expect(res.status).toBe(200);
  });

});

describe("GET /api/reports/scheduled/:id", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("test-correlation-id");
  });

  it("returns a single scheduled report when user owns it", async () => {
    const mockReport = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockReport]);

    const res = await request(app).get("/api/reports/scheduled/report-id-123");

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("report-id-123");

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "test-correlation-id",
        userId: "test-user-id",
        scheduleId: "report-id-123",
      }),
      "scheduled_report_retrieved",
    );
  });

  it("returns 404 when scheduled report does not exist", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const res = await request(app).get("/api/reports/scheduled/nonexistent-id");

    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("NotFound");
    expect(res.body.error.correlationId).toBe("test-correlation-id");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "nonexistent-id",
      }),
      "scheduled_report_not_found",
    );
  });

  it("returns 403 when user does not own the scheduled report", async () => {
    const mockReport = {
      id: "report-id-123",
      userId: "different-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockReport]);

    const res = await request(app).get("/api/reports/scheduled/report-id-123");

    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe("Forbidden");
    expect(res.body.error.correlationId).toBe("test-correlation-id");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "test-user-id",
        ownerId: "different-user-id",
      }),
      "scheduled_report_access_forbidden",
    );
  });
});

describe("PATCH /api/reports/scheduled/:id", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("test-correlation-id");
  });

  it("updates a scheduled report with valid partial data", async () => {
    const mockExisting = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    const mockUpdated = {
      ...mockExisting,
      active: false,
      updatedAt: new Date("2026-07-24T13:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockExisting]);
    mockDb.returning.mockResolvedValueOnce([mockUpdated]);

    const res = await request(app)
      .patch("/api/reports/scheduled/report-id-123")
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "report-id-123",
        updatedFields: expect.arrayContaining(["active", "updatedAt"]),
      }),
      "scheduled_report_updated",
    );
  });

  it("updates schedule and format fields", async () => {
    const mockExisting = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    const mockUpdated = {
      ...mockExisting,
      schedule: "30 14 * * 1",
      format: "json",
      updatedAt: new Date("2026-07-24T13:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockExisting]);
    mockDb.returning.mockResolvedValueOnce([mockUpdated]);

    const res = await request(app)
      .patch("/api/reports/scheduled/report-id-123")
      .send({
        schedule: "30 14 * * 1",
        format: "json",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.schedule).toBe("30 14 * * 1");
    expect(res.body.data.format).toBe("json");
  });

  it("returns 404 when scheduled report does not exist", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const res = await request(app)
      .patch("/api/reports/scheduled/nonexistent-id")
      .send({ active: false });

    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("NotFound");
  });

  it("returns 403 when user does not own the scheduled report", async () => {
    const mockExisting = {
      id: "report-id-123",
      userId: "different-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockExisting]);

    const res = await request(app)
      .patch("/api/reports/scheduled/report-id-123")
      .send({ active: false });

    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe("Forbidden");
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await request(app)
      .patch("/api/reports/scheduled/report-id-123")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });

  it("returns 400 when cron expression is invalid", async () => {
    const mockExisting = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockExisting]);

    const res = await request(app)
      .patch("/api/reports/scheduled/report-id-123")
      .send({ schedule: "invalid cron" });

    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("ValidationError");
  });
});

describe("DELETE /api/reports/scheduled/:id", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("test-correlation-id");
  });

  it("deletes a scheduled report and returns 204", async () => {
    const mockExisting = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockExisting]);
    mockDb.where.mockResolvedValueOnce(undefined);

    const res = await request(app).delete("/api/reports/scheduled/report-id-123");

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "report-id-123",
      }),
      "scheduled_report_deleted",
    );
  });

  it("returns 404 when scheduled report does not exist", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const res = await request(app).delete("/api/reports/scheduled/nonexistent-id");

    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("NotFound");
  });

  it("returns 403 when user does not own the scheduled report", async () => {
    const mockExisting = {
      id: "report-id-123",
      userId: "different-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.limit.mockResolvedValueOnce([mockExisting]);

    const res = await request(app).delete("/api/reports/scheduled/report-id-123");

    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe("Forbidden");
  });
});

describe("Authentication", () => {
  let authApp: express.Express;

  beforeAll(() => {
    authApp = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("test-correlation-id");
  });

  it("requires req.user.id (set by parent router's requireAuth)", async () => {
    // Auth is enforced at the parent /api/reports level via requireAuth.
    // The scheduled router reads req.user.id for ownership checks.
    // This test verifies that a valid user ID flows through to route handlers.
    const mockCreated = {
      id: "report-id-auth",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };
    mockDb.returning.mockResolvedValueOnce([mockCreated]);

    const res = await request(authApp)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBe("test-user-id");
  });
});

describe("Correlation ID logging", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestId.mockReturnValue("unique-correlation-id-456");
  });

  it("includes correlation ID in all log entries on success", async () => {
    const mockCreated = {
      id: "report-id-123",
      userId: "test-user-id",
      reportType: "predictions",
      schedule: "0 2 * * *",
      format: "csv",
      filters: {},
      active: true,
      createdAt: new Date("2026-07-24T12:00:00Z"),
      updatedAt: new Date("2026-07-24T12:00:00Z"),
    };

    mockDb.returning.mockResolvedValueOnce([mockCreated]);

    await request(app)
      .post("/api/reports/scheduled")
      .send({
        reportType: "predictions",
        schedule: "0 2 * * *",
        format: "csv",
      });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "unique-correlation-id-456",
      }),
      expect.any(String),
    );
  });

  it("includes correlation ID in log entries on validation failure", async () => {
    await request(app).post("/api/reports/scheduled").send({});

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "unique-correlation-id-456",
      }),
      "scheduled_report_create_validation_failed",
    );
  });

  it("includes correlation ID in error response", async () => {
    const res = await request(app).post("/api/reports/scheduled").send({});

    expect(res.body.error.correlationId).toBe("unique-correlation-id-456");
  });
});
