import express from "express";
import request from "supertest";

const mockSeedSampleMarkets = jest.fn();

jest.mock("../src/middleware/requireAdmin", () => ({
  requireAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.adminAddress = "GADMIN";
    next();
  },
}));

jest.mock("../src/services/seedService", () => ({
  seedSampleMarkets: mockSeedSampleMarkets,
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    fatal: jest.fn(),
  },
}));

function createAdminSeedApp(adminSeedRouter: express.Router) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/seed", adminSeedRouter);
  return app;
}

async function loadRouterWithNodeEnv(nodeEnv: "test" | "production") {
  process.env.NODE_ENV = nodeEnv;
  jest.resetModules();
  const module = await import("../src/routes/admin/seed");
  return module.adminSeedRouter;
}

describe("adminSeedRouter", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.clearAllMocks();
  });

  it("seeds markets outside production", async () => {
    const router = await loadRouterWithNodeEnv("test");
    mockSeedSampleMarkets.mockResolvedValue({
      seedKey: "sample-markets-v1",
      requested: 3,
      inserted: 3,
      marketIds: ["seed-market-btc-100k-2026"],
    });

    const res = await request(createAdminSeedApp(router)).post("/api/admin/seed");

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ seedKey: "sample-markets-v1", inserted: 3 });
    expect(mockSeedSampleMarkets).toHaveBeenCalledTimes(1);
  });

  it("does not expose the seed endpoint in production", async () => {
    const router = await loadRouterWithNodeEnv("production");

    const res = await request(createAdminSeedApp(router)).post("/api/admin/seed");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
    expect(mockSeedSampleMarkets).not.toHaveBeenCalled();
  });
});
