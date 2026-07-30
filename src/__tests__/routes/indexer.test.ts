import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { indexerRouter } from "../../routes/indexer";
import * as indexerModule from "../../indexer";

// Here we mock securityHeaders to attach expected headers for isolated header verification if required.
jest.mock("../../middleware/securityHeaders", () => ({
  securityHeaders: (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  },
}));

// Setup an Express instance for isolated router testing
const app = express();
app.use(express.json());
app.use("/api/indexer", indexerRouter);

describe("POST /api/indexer Router & Validator Tests", () => {
  let runPollCycleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Spy on runPollCycle to control its execution during tests
    runPollCycleSpy = jest.spyOn(indexerModule, "runPollCycle").mockResolvedValue();
  });

  afterEach(() => {
    runPollCycleSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  //  SUCCESSFUL REQUESTS
  // ---------------------------------------------------------------------------
  describe("Success Scenarios (200 OK)", () => {
    it("should accept a valid 'poll' action and invoke runPollCycle", async () => {
      const payload = { action: "poll", limit: 100, force: true };

      const response = await request(app)
        .post("/api/indexer")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          action: "poll",
          limit: 100,
          force: true,
        },
      });
      expect(runPollCycleSpy).toHaveBeenCalledTimes(1);
    });

    it("should apply default values when optional fields ('limit', 'force') are omitted", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "status" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        action: "status",
        limit: 50,    // Zod default
        force: false, // Zod default
      });
      // Should NOT call runPollCycle since action is 'status', not 'poll'
      expect(runPollCycleSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  //  VALIDATION FAILURE SCENARIOS (400 BAD REQUEST)
  // ---------------------------------------------------------------------------
  describe("Validation Scenarios (400 Bad Request)", () => {
    it("should fail when 'action' field is completely missing", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ limit: 10 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Bad Request");
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "action",
            message: "Action must be one of: 'start', 'stop', 'poll', or 'status'",
          }),
        ])
      );
    });

    it("should fail when 'action' is an invalid enum string", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "invalid_action_name" });

      expect(response.status).toBe(400);
      expect(response.body.details[0]).toMatchObject({
        field: "action",
        code: "invalid_enum_value",
      });
    });

    it("should fail when 'limit' is less than minimum allowed (1)", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "poll", limit: 0 });

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([
        {
          field: "limit",
          message: "Limit must be at least 1",
          code: "too_small",
        },
      ]);
    });

    it("should fail when 'limit' exceeds maximum allowed (500)", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "poll", limit: 1000 });

      expect(response.status).toBe(400);
      expect(response.body.details[0]).toMatchObject({
        field: "limit",
        message: "Limit cannot exceed 500",
      });
    });

    it("should fail when data types are incorrect (e.g., 'force' is a string instead of boolean)", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "poll", force: "true" });

      expect(response.status).toBe(400);
      expect(response.body.details[0]).toMatchObject({
        field: "force",
        code: "invalid_type",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // SECURITY HEADERS VERIFICATION
  // ---------------------------------------------------------------------------
  describe("Middleware Verification", () => {
    it("should apply security headers on the POST response", async () => {
      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "status" });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    });
  });

  // ---------------------------------------------------------------------------
  // SERVER ERROR HANDLING (500)
  // ---------------------------------------------------------------------------
  describe("Error Handling (500 Internal Server Error)", () => {
    it("should handle exceptions thrown by runPollCycle gracefully", async () => {
      runPollCycleSpy.mockRejectedValue(new Error("Database connection pool exhausted"));

      const response = await request(app)
        .post("/api/indexer")
        .send({ action: "poll" });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: "Internal Server Error",
        message: "Database connection pool exhausted",
      });
    });
  });
});