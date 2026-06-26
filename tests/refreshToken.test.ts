import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";
import { hashToken } from "../src/services/refreshTokenService";
import { db } from "../src/db/index";

// Mock Drizzle db instance
jest.mock("../src/db/index", () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

describe("Refresh Token Rotation and Lifecycle", () => {
  let app: any;

  // Local helper mocks for method chaining
  const mockFrom = jest.fn();
  const mockWhere = jest.fn();
  const mockLimit = jest.fn();
  const mockValues = jest.fn();
  const mockSet = jest.fn();
  const mockUpdateWhere = jest.fn();

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    const mockSelect = db.select as jest.Mock;
    const mockInsert = db.insert as jest.Mock;
    const mockUpdate = db.update as jest.Mock;

    // Reset chains
    mockSelect.mockReturnValue({
      from: mockFrom.mockReturnValue({
        where: mockWhere.mockReturnValue({
          limit: mockLimit,
        }),
      }),
    });

    mockInsert.mockReturnValue({
      values: mockValues.mockResolvedValue([Symbol("inserted")]),
    });

    mockUpdate.mockReturnValue({
      set: mockSet.mockReturnValue({
        where: mockUpdateWhere.mockResolvedValue([Symbol("updated")]),
      }),
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("returns 400 if refreshToken is not provided or invalid", async () => {
      const res = await request(app).post("/api/auth/refresh").send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    });

    it("returns 401 if refresh token is not found in database", async () => {
      mockLimit.mockResolvedValueOnce([]); // No token found

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: "non-existent-token" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_token");
    });

    it("returns 401 if refresh token is expired", async () => {
      const expiredDate = new Date(Date.now() - 1000);
      mockLimit.mockResolvedValueOnce([
        {
          id: "token-uuid-1",
          userId: "user-uuid-123",
          tokenHash: "hashed-token",
          familyId: "family-uuid-999",
          parentId: null,
          expiresAt: expiredDate,
          revokedAt: null,
        },
      ]);

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: "expired-token" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_token");
    });

    it("rotates refresh token and issues new access token on valid request", async () => {
      const validDate = new Date(Date.now() + 1000000);
      const userId = "user-uuid-123";
      const familyId = "family-uuid-999";

      // 1. First DB query returns the token record
      mockLimit.mockResolvedValueOnce([
        {
          id: "token-uuid-1",
          userId,
          tokenHash: hashToken("valid-token"),
          familyId,
          parentId: null,
          expiresAt: validDate,
          revokedAt: null,
        },
      ]);

      // 2. Second DB query returns the user details for JWT signing
      mockLimit.mockResolvedValueOnce([
        {
          id: userId,
          stellarAddress: "GC3O2R44K...STELLAR",
          createdAt: new Date(),
        },
      ]);

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: "valid-token" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("accessToken");
      expect(res.body).toHaveProperty("refreshToken");
      expect(res.body.refreshToken).not.toBe("valid-token");

      // Verify Access Token payload
      const decoded: any = jwt.verify(
        res.body.accessToken,
        process.env.JWT_SECRET as string
      );
      expect(decoded.sub).toBe(userId);
      expect(decoded.stellarAddress).toBe("GC3O2R44K...STELLAR");

      // Verify revoke old token update query was run
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date) })
      );

      // Verify insert new token query was run
      expect(db.insert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          familyId,
          parentId: "token-uuid-1",
        })
      );
    });

    it("detects reuse, revokes all family tokens, and returns 403", async () => {
      const validDate = new Date(Date.now() + 1000000);
      const userId = "user-uuid-123";
      const familyId = "family-uuid-999";

      // Token has already been revoked
      mockLimit.mockResolvedValueOnce([
        {
          id: "token-uuid-1",
          userId,
          tokenHash: hashToken("reused-token"),
          familyId,
          parentId: null,
          expiresAt: validDate,
          revokedAt: new Date(Date.now() - 5000), // revoked 5s ago
        },
      ]);

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ refreshToken: "reused-token" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("token_reuse_detected");

      // Verify family-wide revocation update query was executed
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date) })
      );
      expect(mockUpdateWhere).toHaveBeenCalled();
    });
  });

  describe("POST /api/auth/logout", () => {
    it("revokes family and returns 200 OK", async () => {
      const familyId = "family-uuid-999";

      mockLimit.mockResolvedValueOnce([
        {
          id: "token-uuid-1",
          userId: "user-uuid-123",
          tokenHash: hashToken("logout-token"),
          familyId,
          parentId: null,
          expiresAt: new Date(Date.now() + 1000000),
          revokedAt: null,
        },
      ]);

      const res = await request(app)
        .post("/api/auth/logout")
        .send({ refreshToken: "logout-token" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      // Verify revocation query executed
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date) })
      );
    });
  });
});
