// Set up environment variables before importing anything that parses them
process.env.JWT_SECRET = "super-secret-key-that-is-at-least-32-bytes-long";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";
process.env.ADMIN_ALLOWLIST = "G-ADMIN-ADDRESS-1,G-ADMIN-ADDRESS-2";
process.env.PUBLIC_APP_URL = "https://app.predictify.test";

import request from "supertest";
import { createApp } from "../src/index";
import * as marketService from "../src/services/marketService";

jest.mock("../src/services/marketService", () => ({
  ...jest.requireActual("../src/services/marketService"),
  getMarketById: jest.fn(),
}));

const mockGetMarketById = marketService.getMarketById as jest.Mock;

describe("GET /api/markets/:id/share", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns OG and Twitter card metadata for an existing market", async () => {
    mockGetMarketById.mockResolvedValue({
      id: "market-1",
      question: "Will it rain tomorrow?",
      status: "active",
      resolutionTime: "2026-07-01T00:00:00.000Z",
    });

    const res = await request(createApp()).get("/api/markets/market-1/share");

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe("https://app.predictify.test/markets/market-1");
    expect(res.body.data.og["og:title"]).toBe("Will it rain tomorrow?");
    expect(res.body.data.og["og:type"]).toBe("website");
    expect(res.body.data.twitter["twitter:card"]).toBe("summary_large_image");
    expect(res.body.data.twitter["twitter:image"]).toContain("/api/markets/market-1/og-image.png");
  });

  it("returns 404 with an error envelope for an unknown market", async () => {
    mockGetMarketById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/markets/does-not-exist/share");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
