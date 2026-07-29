import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createAdminFraudRouter } from "../src/routes/admin/fraud";
import { errorHandler } from "../src/middleware/errorHandler";
import type {
  FraudFlagDTO,
  FraudRepo,
  FlagWriteInput,
  PredictionRow,
} from "../src/services/fraudService";

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDR =
  "GADMIN7777777777777777777777777777777777777777777777777777";

function signAdmin(): string {
  return jwt.sign({ sub: ADMIN_ADDR, role: "admin" }, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

class FakeRepo implements FraudRepo {
  rows: PredictionRow[] = [];
  written: FlagWriteInput[] = [];
  flags: FraudFlagDTO[] = [];
  async loadRecentPredictions(): Promise<PredictionRow[]> {
    return this.rows;
  }
  async upsertFlags(rows: FlagWriteInput[]): Promise<number> {
    this.written.push(...rows);
    return rows.length;
  }
  async listFlags(filters: {
    status?: "open" | "dismissed" | "confirmed";
    limit?: number;
  }): Promise<FraudFlagDTO[]> {
    const arr = filters.status
      ? this.flags.filter((f) => f.status === filters.status)
      : this.flags;
    return arr.slice(0, filters.limit ?? 50);
  }
}

function makeApp(repo: FraudRepo): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { id?: string }).id =
      (req.headers["x-request-id"] as string | undefined) ?? "req-id-test";
    next();
  });
  app.use(
    "/api/admin/fraud",
    createAdminFraudRouter({ repo, rateLimitPerMinute: 1000 }),
  );
  app.use(errorHandler);
  return app;
}

describe("admin fraud routes", () => {
  describe("auth", () => {
    it("GET /flags returns 403 without an admin token", async () => {
      const res = await request(makeApp(new FakeRepo())).get(
        "/api/admin/fraud/flags",
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("POST /scan returns 403 without an admin token", async () => {
      const res = await request(makeApp(new FakeRepo()))
        .post("/api/admin/fraud/scan")
        .send({});
      expect(res.status).toBe(403);
    });

    it("GET /flags returns 403 with a non-admin token", async () => {
      const userToken = jwt.sign(
        { sub: "GUSER", role: "user" },
        SECRET,
        { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" },
      );
      const res = await request(makeApp(new FakeRepo()))
        .get("/api/admin/fraud/flags")
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /flags", () => {
    it("returns the listed flags as an admin", async () => {
      const repo = new FakeRepo();
      repo.flags = [
        {
          id: "id-1",
          clusterKey: "GA|GB",
          userId: "u-a",
          stellarAddress: "GA",
          reason: "SHARED_FUNDING_SOURCE",
          evidence: { foo: "bar" },
          score: 5,
          status: "open",
          reviewedBy: null,
          reviewedAt: null,
          correlationId: "cid",
          createdAt: new Date("2026-06-01T00:00:00Z"),
          updatedAt: new Date("2026-06-01T00:00:00Z"),
        },
      ];
      const res = await request(makeApp(repo))
        .get("/api/admin/fraud/flags")
        .set("Authorization", `Bearer ${signAdmin()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        clusterKey: "GA|GB",
        reason: "SHARED_FUNDING_SOURCE",
        status: "open",
      });
      expect(res.headers["x-request-id"]).toBe("req-id-test");
    });

    it("rejects invalid status enum", async () => {
      const res = await request(makeApp(new FakeRepo()))
        .get("/api/admin/fraud/flags?status=nope")
        .set("Authorization", `Bearer ${signAdmin()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects out-of-range limit", async () => {
      const res = await request(makeApp(new FakeRepo()))
        .get("/api/admin/fraud/flags?limit=9999")
        .set("Authorization", `Bearer ${signAdmin()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects non-numeric limit", async () => {
      const res = await request(makeApp(new FakeRepo()))
        .get("/api/admin/fraud/flags?limit=abc")
        .set("Authorization", `Bearer ${signAdmin()}`);
      expect(res.status).toBe(400);
    });

    it("forwards the status filter to the repo", async () => {
      const repo = new FakeRepo();
      repo.flags = [
        {
          id: "1",
          clusterKey: "k",
          userId: "u",
          stellarAddress: "G",
          reason: "r",
          evidence: {},
          score: 0,
          status: "confirmed",
          reviewedBy: null,
          reviewedAt: null,
          correlationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "2",
          clusterKey: "k",
          userId: "u",
          stellarAddress: "G",
          reason: "r",
          evidence: {},
          score: 0,
          status: "open",
          reviewedBy: null,
          reviewedAt: null,
          correlationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const res = await request(makeApp(repo))
        .get("/api/admin/fraud/flags?status=confirmed")
        .set("Authorization", `Bearer ${signAdmin()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("confirmed");
    });
  });

  describe("POST /scan", () => {
    it("runs a scan with no body and returns the summary", async () => {
      const repo = new FakeRepo();
      const res = await request(makeApp(repo))
        .post("/api/admin/fraud/scan")
        .set("Authorization", `Bearer ${signAdmin()}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        scanned: 0,
        edges: 0,
        clusters: 0,
        flagsWritten: 0,
      });
      expect(res.body.data.correlationId).toBe("req-id-test");
    });

    it("rejects unknown body keys (strict schema)", async () => {
      const res = await request(makeApp(new FakeRepo()))
        .post("/api/admin/fraud/scan")
        .set("Authorization", `Bearer ${signAdmin()}`)
        .send({ wat: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects negative lookbackMs", async () => {
      const res = await request(makeApp(new FakeRepo()))
        .post("/api/admin/fraud/scan")
        .set("Authorization", `Bearer ${signAdmin()}`)
        .send({ lookbackMs: -10 });
      expect(res.status).toBe(400);
    });

    it("persists flags when the repo returns suspicious rows", async () => {
      const repo = new FakeRepo();
      repo.rows = [
        {
          predictionId: "p1",
          userId: "u-a",
          stellarAddress: "GA",
          marketId: "m",
          outcome: "yes",
          amount: "100",
          txHash: "",
          fundingSource: "GF",
          createdAt: new Date(),
        },
        {
          predictionId: "p2",
          userId: "u-b",
          stellarAddress: "GB",
          marketId: "m",
          outcome: "yes",
          amount: "100",
          txHash: "",
          fundingSource: "GF",
          createdAt: new Date(),
        },
      ];
      const res = await request(makeApp(repo))
        .post("/api/admin/fraud/scan")
        .set("Authorization", `Bearer ${signAdmin()}`)
        .send({ lookbackMs: 60_000 });
      expect(res.status).toBe(200);
      expect(res.body.data.clusters).toBe(1);
      expect(res.body.data.flagsWritten).toBe(2);
      expect(repo.written).toHaveLength(2);
    });
  });
});
