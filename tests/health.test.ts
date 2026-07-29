process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import request from "supertest";
import { createApp } from "../src/index";
import { db } from "../src/db/client";

jest.mock("../src/db/client", () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([
      { afterState: { mode: "active", maintenance: false } }
    ]),
  },
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("mock-correlation-id"),
}));

describe("healthRouter endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /health", () => {
    it("returns ok status and db state", async () => {
      const res = await request(createApp()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.state).toEqual({ mode: "active", maintenance: false });
    });
  });

  describe("POST /health/mutations", () => {
    it("updates health state and logs audit", async () => {
      const res = await request(createApp())
        .post("/health/mutations")
        .send({ mode: "maintenance", maintenance: true });
        
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("updated");
      expect(res.body.state.mode).toBe("maintenance");
      expect(res.body.state.maintenance).toBe(true);
    });
  });
});
