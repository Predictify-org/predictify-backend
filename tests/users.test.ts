import request from "supertest";
import { createApp } from "../src/index";
import { db } from "../src/db";
import { users, markets, predictions } from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("GET /api/users/health", () => {
  it("returns ok when the database probe succeeds", async () => {
    const res = await request(createApp()).get("/api/users/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.dependencies.database.status).toBe("ok");
    expect(res.body.correlationId).toBeDefined();
  });

  it("returns down with a 503 when database probing fails", async () => {
    jest.spyOn(require("../src/db/client").pool, "query").mockRejectedValueOnce(new Error("db unavailable"));

    const res = await request(createApp()).get("/api/users/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.dependencies.database.status).toBe("down");
    expect(res.body.dependencies.database.error).toContain("db unavailable");
  });
});

describe("GET /api/users/:address/predictions", () => {
  const testAddress = "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO";

  beforeAll(async () => {
    // Clean up test data
    await db.delete(predictions);
    await db.delete(markets);
    await db.delete(users);

    // Seed test data
    await db.insert(users).values({ stellarAddress: testAddress });
    const user = await db.query.users.findFirst({
      where: eq(users.stellarAddress, testAddress),
    });

    await db.insert(markets).values({
      id: "market-1",
      question: "Will ETH reach $10k by EOY?",
      status: "active",
      resolutionTime: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      indexedLedger: 0,
    });

    const baseTime = new Date("2026-01-01T00:00:00.000Z");

    for (let i = 0; i < 25; i++) {
      await db.insert(predictions).values({
        id: `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
        marketId: "market-1",
        userId: user!.id,
        outcome: i % 2 === 0 ? "yes" : "no",
        amount: "100",
        status: i < 10 ? "pending" : i < 15 ? "confirmed" : "won",
        createdAt: new Date(baseTime.getTime() - Math.floor(i / 2) * 60 * 60 * 1000),
      });
    }
  });

  afterAll(async () => {
    // Clean up
    await db.delete(predictions);
    await db.delete(markets);
    await db.delete(users);
  });

  it("should return 404 for unknown address", async () => {
    const res = await request(createApp()).get(
      `/api/users/${"G" + "A".repeat(55)}/predictions`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("should return all predictions when no status filter", async () => {
    const res = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?limit=10`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.nextCursor).toBeDefined();
  });

  it("should filter by status", async () => {
    const res = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?status=pending&limit=20`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.every((p: any) => p.status === "pending")).toBe(true);
  });

  it("should handle pagination with cursor", async () => {
    const page1 = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?limit=10`
    );
    expect(page1.body.nextCursor).toBeDefined();

    const page2 = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?limit=10&cursor=${encodeURIComponent(
        page1.body.nextCursor
      )}`
    );
    expect(page2.status).toBe(200);
    expect(page2.body.data.length).toBeGreaterThan(0);
  });


  it("should not skip predictions that share a cursor timestamp", async () => {
    const seenIds = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < 9; page++) {
      const res = await request(createApp()).get(
        `/api/users/${testAddress}/predictions?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      );

      expect(res.status).toBe(200);
      for (const prediction of res.body.data) {
        expect(seenIds.has(prediction.id)).toBe(false);
        seenIds.add(prediction.id);
      }

      cursor = res.body.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(seenIds.size).toBe(25);
  });

  it("should reject malformed cursors", async () => {
    const res = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?cursor=not-a-cursor`
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("should validate address format", async () => {
    const res = await request(createApp()).get(
      "/api/users/invalid-address/predictions"
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_address");
  });

  it("should be stable across status changes", async () => {
    // Query all predictions
    const allRes = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?limit=100`
    );

    // Query by status
    const statusRes = await request(createApp()).get(
      `/api/users/${testAddress}/predictions?status=pending&limit=100`
    );

    // Cursor should work consistently
    expect(allRes.body.data).toBeDefined();
    expect(statusRes.body.data).toBeDefined();
  });
});
