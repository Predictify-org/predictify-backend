import request from "supertest";
import express from "express";
import { tagsRouter } from "../../src/routes/tags";
import { closeAuthPool } from "../../src/middleware/requireAuth";
import { getMarketTags } from "../../src/repositories/marketRepository";
import { errorHandler } from "../../src/middleware/errorHandler";

jest.mock("../../src/middleware/timeout", () => {
  const actual = jest.requireActual("../../src/middleware/timeout");
  return {
    ...actual,
    requestTimeout: actual.requestTimeout,
  };
});

jest.mock("../../src/repositories/marketRepository");
describe("Tags API", () => {
  let app: any;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/tags", tagsRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useRealTimers();
    (getMarketTags as jest.Mock).mockResolvedValue([
      { tag: "stellar", count: 10 },
      { tag: "wave", count: 5 },
      { tag: "fwc26", count: 2 },
    ]);
  });

  afterAll(async () => {
    await closeAuthPool();
  });

  it("should return a list of tags", async () => {
    const res = await request(app).get("/api/tags");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: ["stellar", "wave", "fwc26"] });
  });

  it("should respect the limit query parameter", async () => {
    const res = await request(app).get("/api/tags?limit=2");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: ["stellar", "wave"] });
  });

  it("should return 400 for invalid limit", async () => {
    const res = await request(app).get("/api/tags?limit=invalid");
    expect(res.status).toBe(400);
    // Zod validation error is handled by errorHandler
    expect(res.body).toHaveProperty("error.code", "validation_error");
  });

  it("should return 400 for limit out of bounds", async () => {
    const res = await request(app).get("/api/tags?limit=200");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error.code", "validation_error");
  });

  it("should return X-Correlation-Id header from accessLog middleware", async () => {
    const res = await request(app)
      .get("/api/tags")
      .set("X-Correlation-Id", "test-corr-123");
    expect(res.status).toBe(200);
    expect(res.headers["x-correlation-id"]).toBe("test-corr-123");
  });

  it("should generate a correlation ID when none is supplied", async () => {
    const res = await request(app).get("/api/tags");
    expect(res.status).toBe(200);
    expect(res.headers["x-correlation-id"]).toBeDefined();
    expect(res.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("should return 504 when tag lookup exceeds the timeout", async () => {
    jest.useFakeTimers();
    (getMarketTags as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ tag: "slow", count: 1 }]), 6000)),
    );

    const responsePromise = request(app).get("/api/tags");
    await jest.advanceTimersByTimeAsync(5000);
    const res = await responsePromise;

    expect(res.status).toBe(504);
    expect(res.body.error).toMatchObject({
      code: "gateway_timeout",
      message: "Tags request timed out",
      requestId: expect.any(String),
    });
  });

  it("should abandon the handler result after timeout instead of sending a second response", async () => {
    jest.useFakeTimers();

    let resolveTags: ((value: Array<{ tag: string; count: number }>) => void) | undefined;
    (getMarketTags as jest.Mock).mockImplementation(
      () => new Promise((resolve) => {
        resolveTags = resolve;
      }),
    );

    const responsePromise = request(app).get("/api/tags");
    await jest.advanceTimersByTimeAsync(5000);
    const res = await responsePromise;

    expect(res.status).toBe(504);

    resolveTags?.([{ tag: "late", count: 1 }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getMarketTags).toHaveBeenCalledTimes(1);
  });
});
