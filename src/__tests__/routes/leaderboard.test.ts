/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { leaderboardRouter } from "../../routes/leaderboard";
import * as leaderboardService from "../../services/leaderboardService";

// Mock the service
jest.mock("../../services/leaderboardService");
jest.mock("../../utils/cursor", () => {
  const actual = jest.requireActual("../../utils/cursor");
  return { ...actual };
});

// Mock the logger to avoid noise in test output
jest.mock("../../config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// Helper to extract bare ETag hash
function etagHash(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

describe("Leaderboard Routes", () => {
  let app: express.Application;

  const mockLeaderboardEntry = {
    user_id: "user-123",
    stellar_address: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
    total_predictions: 100,
    correct_predictions: 85,
    accuracy_percentage: 85.0,
    rank: 1,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/leaderboard", leaderboardRouter);
  });

  describe("GET /api/leaderboard", () => {
    it("should return leaderboard with default parameters", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app).get("/api/leaderboard");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([mockLeaderboardEntry]);
      expect(response.body.meta).toEqual({
        limit: 50,
        offset: 0,
        count: 1,
        refresh: false,
        period: "all-time",
      });
    });

    it("should accept period parameter", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ period: "monthly" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardPage).toHaveBeenCalledWith(
        50,
        "monthly",
        undefined,
      );
      expect(response.body.meta.period).toBe("monthly");
    });

    it("should accept weekly period", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ period: "weekly" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardPage).toHaveBeenCalledWith(
        50,
        "weekly",
        undefined,
      );
      expect(response.body.meta.period).toBe("weekly");
    });

    it("should reject invalid period", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ period: "invalid-period" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe("validation_error");
      expect(response.body.error.details).toBeDefined();
    });

    it("should accept limit parameter", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ limit: 25 });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardPage).toHaveBeenCalledWith(
        25,
        "all-time",
        undefined,
      );
      expect(response.body.meta.limit).toBe(25);
    });

    it("should accept offset parameter", async () => {
      (leaderboardService.getLeaderboard as any).mockResolvedValueOnce([
        mockLeaderboardEntry,
      ]);

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ offset: 100 });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(
        50,
        100,
        "all-time",
      );
      expect(response.body.meta.offset).toBe(100);
    });

    it("should reject negative limit", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ limit: -1 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should reject limit exceeding 100", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ limit: 101 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should reject negative offset", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ offset: -1 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should reject limit with decimal value", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ limit: 10.5 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should reject unknown query parameters", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ unknownParam: "value" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should reject offset with decimal value", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ offset: 1.5 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should support refresh parameter with all-time period", async () => {
      (
        leaderboardService.getLeaderboardPageWithRefresh as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ refresh: true });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardPageWithRefresh).toHaveBeenCalledWith(
        50,
        "all-time",
        undefined,
      );
      expect(response.body.meta.refresh).toBe(true);
    });

    it("should support refresh parameter with monthly period", async () => {
      (
        leaderboardService.getLeaderboardPageWithRefresh as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ refresh: true, period: "monthly" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardPageWithRefresh).toHaveBeenCalledWith(
        50,
        "monthly",
        undefined,
      );
    });

    it("should support refresh parameter with weekly period", async () => {
      (
        leaderboardService.getLeaderboardPageWithRefresh as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ refresh: true, period: "weekly" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardPageWithRefresh).toHaveBeenCalledWith(
        50,
        "weekly",
        undefined,
      );
    });

    it("should return empty array when no results", async () => {
      (leaderboardService.getLeaderboardPage as jest.Mock).mockResolvedValueOnce(
        { entries: [], nextCursor: null },
      );

      const response = await request(app).get("/api/leaderboard");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.count).toBe(0);
    });

    it("should handle service errors", async () => {
      (leaderboardService.getLeaderboardPage as jest.Mock).mockRejectedValueOnce(
        new Error("Database error"),
      );

      const response = await request(app).get("/api/leaderboard");

      expect(response.status).toBe(500);
    });

    it("should coerce string parameters to correct types", async () => {
      (leaderboardService.getLeaderboardWithRefresh as any).mockResolvedValueOnce([
        mockLeaderboardEntry,
      ]);

      const response = await request(app)
        .get("/api/leaderboard")
        .query({ limit: "25", offset: "50", refresh: "true" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getLeaderboardWithRefresh).toHaveBeenCalledWith(
        25,
        50,
        "all-time",
      );
      expect(response.body.meta.limit).toBe(25);
      expect(response.body.meta.offset).toBe(50);
      expect(response.body.meta.refresh).toBe(true);
    });

    it("should return structured validation error with code, message, details, and requestId", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ limit: -5 });

      expect(response.status).toBe(400);
      expect(response.body.error).toHaveProperty("code", "validation_error");
      expect(response.body.error).toHaveProperty("message");
      expect(response.body.error).toHaveProperty("details");
      expect(Array.isArray(response.body.error.details)).toBe(true);
    });
  });

  describe("GET /api/leaderboard/user/:stellarAddress", () => {
    it("should return user leaderboard entry with default period", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const response = await request(app).get(
        `/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockLeaderboardEntry);
      expect(leaderboardService.getUserLeaderboardEntry).toHaveBeenCalledWith(
        mockLeaderboardEntry.stellar_address,
        "all-time",
      );
    });

    it("should accept period parameter for user endpoint", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const response = await request(app)
        .get(`/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`)
        .query({ period: "monthly" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getUserLeaderboardEntry).toHaveBeenCalledWith(
        mockLeaderboardEntry.stellar_address,
        "monthly",
      );
    });

    it("should accept weekly period for user endpoint", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const response = await request(app)
        .get(`/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`)
        .query({ period: "weekly" });

      expect(response.status).toBe(200);
      expect(leaderboardService.getUserLeaderboardEntry).toHaveBeenCalledWith(
        mockLeaderboardEntry.stellar_address,
        "weekly",
      );
    });

    it("should reject invalid period for user endpoint", async () => {
      const response = await request(app)
        .get(`/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`)
        .query({ period: "invalid" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should reject invalid stellar address format", async () => {
      const response = await request(app).get(
        "/api/leaderboard/user/NOT_A_VALID_ADDRESS",
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
      expect(response.body.error.message).toContain("Stellar address");
    });

    it("should reject stellar address with wrong prefix", async () => {
      const response = await request(app).get(
        "/api/leaderboard/user/AHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should return 404 when user not found with valid address", async () => {
      const validAddress =
        "GAQQV3Q3YZ7GXQFX3WQ5RZ5K5Y5Q5X5X5X5X5X5X5X5X5X5X5X5X5X5X5";
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(null);

      const response = await request(app).get(
        `/api/leaderboard/user/${validAddress}`,
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_found");
    });

    it("should handle service errors for user endpoint", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockRejectedValueOnce(new Error("Database error"));

      const response = await request(app).get(
        `/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`,
      );

      expect(response.status).toBe(500);
    });

    it("should work with different stellar addresses", async () => {
      const altAddress =
        "GBTCHKHMWCS5TOX2LAD4DAEKTC3UFSFXQ2MRLED5EYOA34RH4ZX72JK";
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce({
        ...mockLeaderboardEntry,
        stellar_address: altAddress,
      });

      const response = await request(app).get(
        `/api/leaderboard/user/${altAddress}`,
      );

      expect(response.status).toBe(200);
      expect(leaderboardService.getUserLeaderboardEntry).toHaveBeenCalledWith(
        altAddress,
        "all-time",
      );
    });

    it("should reject unknown query parameters on user endpoint", async () => {
      const response = await request(app)
        .get(`/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`)
        .query({ unknownParam: "value" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });
  });

  describe("ETag / 304 conditional GET for GET /api/leaderboard", () => {
    it("returns 200 with ETag and Cache-Control on first request", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const res = await request(app).get("/api/leaderboard");

      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 304 when If-None-Match matches current ETag", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const first = await request(app).get("/api/leaderboard");
      const etag = first.headers["etag"] as string;

      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const second = await request(app)
        .get("/api/leaderboard")
        .set("If-None-Match", etag);

      expect(second.status).toBe(304);
      expect(second.text).toBe("");
    });

    it("returns 200 when If-None-Match does not match", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const res = await request(app)
        .get("/api/leaderboard")
        .set("If-None-Match", '"00000000stale00000000"');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([mockLeaderboardEntry]);
    });

    it("returns 304 with unquoted (bare hash) If-None-Match", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const first = await request(app).get("/api/leaderboard");
      const bareHash = etagHash(first.headers["etag"] as string);

      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const second = await request(app)
        .get("/api/leaderboard")
        .set("If-None-Match", bareHash);

      expect(second.status).toBe(304);
    });

    it("ETag is stable across repeated requests for the same data", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });
      const r1 = await request(app).get("/api/leaderboard");

      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });
      const r2 = await request(app).get("/api/leaderboard");

      expect(r1.headers["etag"]).toBe(r2.headers["etag"]);
    });

    it("ETag changes when leaderboard data changes", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });
      const r1 = await request(app).get("/api/leaderboard");

      const changedEntry = { ...mockLeaderboardEntry, total_predictions: 200 };
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [changedEntry],
        nextCursor: null,
      });
      const r2 = await request(app).get("/api/leaderboard");

      expect(r1.headers["etag"]).not.toBe(r2.headers["etag"]);
    });

    it("304 still includes ETag header", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const first = await request(app).get("/api/leaderboard");
      const etag = first.headers["etag"] as string;

      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const second = await request(app)
        .get("/api/leaderboard")
        .set("If-None-Match", etag);

      expect(second.status).toBe(304);
      expect(second.headers["etag"]).toBe(etag);
    });
  });

  describe("ETag / 304 conditional GET for GET /api/leaderboard/user/:stellarAddress", () => {
    it("returns 200 with ETag and Cache-Control on first request", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const res = await request(app).get(
        `/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`,
      );

      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toMatch(/^"[a-f0-9]{64}"$/);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 304 when If-None-Match matches", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const first = await request(app).get(
        `/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`,
      );
      const etag = first.headers["etag"] as string;

      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const second = await request(app)
        .get(`/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`)
        .set("If-None-Match", etag);

      expect(second.status).toBe(304);
      expect(second.text).toBe("");
    });

    it("returns 200 when If-None-Match does not match", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const res = await request(app)
        .get(`/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`)
        .set("If-None-Match", '"00000000stale00000000"');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(mockLeaderboardEntry);
    });
  });

  describe("GET /api/leaderboard cursor pagination", () => {
    it("should return nextCursor when more pages exist", async () => {
      (
        leaderboardService.getLeaderboardPage as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry, { ...mockLeaderboardEntry, rank: 2 }],
        nextCursor: "djF8MTB8MDAwMDAwMDAwMnx1c2VyLTIzNA",
      });

      const response = await request(app).get("/api/leaderboard");

      expect(response.status).toBe(200);
      expect(response.body.nextCursor).toBe(
        "djF8MTB8MDAwMDAwMDAwMnx1c2VyLTIzNA",
      );
    });

    it("should omit nextCursor when on last page", async () => {
      (
        leaderboardService.getLeaderboardPage as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app).get("/api/leaderboard");

      expect(response.status).toBe(200);
      expect(response.body.nextCursor).toBeUndefined();
    });

    it("should forward cursor parameter to service", async () => {
      (
        leaderboardService.getLeaderboardPage as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const testCursor =
        "djF8MTB8MDAwMDAwMDAwMnx1c2VyLTIzNA";
      await request(app)
        .get("/api/leaderboard")
        .query({ cursor: testCursor });

      expect(leaderboardService.getLeaderboardPage).toHaveBeenCalledWith(
        50,
        "all-time",
        testCursor,
      );
    });

    it("should reject empty cursor string", async () => {
      const response = await request(app)
        .get("/api/leaderboard")
        .query({ cursor: "" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });

    it("should use getLeaderboardPage for first page (no cursor, offset=0)", async () => {
      (
        leaderboardService.getLeaderboardPage as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      await request(app).get("/api/leaderboard");

      expect(leaderboardService.getLeaderboardPage).toHaveBeenCalled();
      expect(leaderboardService.getLeaderboard).not.toHaveBeenCalled();
    });

    it("should use getLeaderboard for explicit non-zero offset (backward compat)", async () => {
      (
        leaderboardService.getLeaderboard as jest.Mock
      ).mockResolvedValueOnce([mockLeaderboardEntry]);

      await request(app)
        .get("/api/leaderboard")
        .query({ offset: 50 });

      expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(
        50,
        50,
        "all-time",
      );
      expect(leaderboardService.getLeaderboardPage).not.toHaveBeenCalled();
    });

    it("should use cursor path with refresh=true", async () => {
      (
        leaderboardService.getLeaderboardPageWithRefresh as jest.Mock
      ).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      await request(app)
        .get("/api/leaderboard")
        .query({ refresh: true });

      expect(
        leaderboardService.getLeaderboardPageWithRefresh,
      ).toHaveBeenCalled();
    });

    it("should handle cursor errors gracefully", async () => {
      (
        leaderboardService.getLeaderboardPage as jest.Mock
      ).mockRejectedValueOnce(new Error("Cursor error"));

      const response = await request(app).get("/api/leaderboard");

      expect(response.status).toBe(500);
    });
  });

  describe("Response format validation", () => {
    it("should include all required meta fields", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app).get("/api/leaderboard");

      expect(response.body.meta).toHaveProperty("limit");
      expect(response.body.meta).toHaveProperty("offset");
      expect(response.body.meta).toHaveProperty("count");
      expect(response.body.meta).toHaveProperty("refresh");
      expect(response.body.meta).toHaveProperty("period");
    });

    it("should return data as array in meta response", async () => {
      (leaderboardService.getLeaderboardPage as any).mockResolvedValueOnce({
        entries: [mockLeaderboardEntry, mockLeaderboardEntry],
        nextCursor: null,
      });

      const response = await request(app).get("/api/leaderboard");

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(2);
    });

    it("should return data as object in user response", async () => {
      (
        leaderboardService.getUserLeaderboardEntry as jest.Mock
      ).mockResolvedValueOnce(mockLeaderboardEntry);

      const response = await request(app).get(
        `/api/leaderboard/user/${mockLeaderboardEntry.stellar_address}`,
      );

      expect(typeof response.body.data).toBe("object");
      expect(Array.isArray(response.body.data)).toBe(false);
    });
  });
});
