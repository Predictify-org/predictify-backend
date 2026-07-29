import { marketCacheKeys, invalidateMarketCache } from "../src/cache/marketsCache";
import { redisConnection } from "../src/queue";

jest.mock("../src/queue", () => ({
  redisConnection: {
    del: jest.fn(),
  },
}));

jest.mock("../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "test-request-id"),
}));

describe("marketsCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("marketCacheKeys", () => {
    it("generates correct 'all' key", () => {
      expect(marketCacheKeys.all).toBe("markets:all");
    });

    it("generates correct 'byId' key", () => {
      expect(marketCacheKeys.byId("market-123")).toBe("markets:market-123");
    });
  });

  describe("invalidateMarketCache", () => {
    it("deletes both specific market key and list key", async () => {
      (redisConnection.del as jest.Mock).mockResolvedValue(1);

      await invalidateMarketCache("market-123");

      expect(redisConnection.del).toHaveBeenCalledTimes(2);
      expect(redisConnection.del).toHaveBeenCalledWith("markets:market-123");
      expect(redisConnection.del).toHaveBeenCalledWith("markets:all");
    });

    it("logs success message after invalidation", async () => {
      (redisConnection.del as jest.Mock).mockResolvedValue(1);
      const loggerModule = require("../src/config/logger");
      const loggerSpy = jest.spyOn(loggerModule.logger, "info");

      await invalidateMarketCache("market-123");

      expect(loggerSpy).toHaveBeenCalledWith(
        {
          requestId: "test-request-id",
          marketId: "market-123",
          keys: ["markets:market-123", "markets:all"],
        },
        "Market cache invalidated"
      );

      loggerSpy.mockRestore();
    });

    it("handles Redis errors gracefully without throwing", async () => {
      (redisConnection.del as jest.Mock).mockRejectedValue(new Error("Redis connection failed"));
      const loggerModule = require("../src/config/logger");
      const loggerSpy = jest.spyOn(loggerModule.logger, "error");

      await expect(invalidateMarketCache("market-123")).resolves.not.toThrow();

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          marketId: "market-123",
        }),
        "Failed to invalidate market cache"
      );

      loggerSpy.mockRestore();
    });

    it("continues even if one key deletion fails", async () => {
      (redisConnection.del as jest.Mock)
        .mockRejectedValueOnce(new Error("First key failed"))
        .mockResolvedValueOnce(1);

      await expect(invalidateMarketCache("market-123")).resolves.not.toThrow();

      expect(redisConnection.del).toHaveBeenCalledTimes(2);
    });
  });
});
