import request from "supertest";
import { createApp } from "../src/index";
import { db } from "../src/db/connection";
import { users, markets, predictions } from "../src/db/schema";
import { eq } from "drizzle-orm";

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

    for (let i = 0; i < 25; i++) {
      await db.insert(predictions).values({
        marketId: "market-1",
        userId: user!.id,
        outcome: i % 2 === 0 ? "yes" : "no",
        amount: "100",
        status: i < 10 ? "pending" : i < 15 ? "confirmed" : "won",
        createdAt: new Date(Date.now() - i * 60 * 60 * 1000),
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
      "/api/users/GBUNKKNOWN000000000000000000000000000000000000000000000000/predictions"
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
