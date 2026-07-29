/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for globalLeaderboardService.
 *
 * All external dependencies (db, redis, logger) are mocked so these tests
 * run without a real database or Redis connection.
 */

// ── Mock dependencies ────────────────────────────────────────────────────────

jest.mock("../src/db/client", () => ({
  db: {
    execute: jest.fn(),
  },
}));

jest.mock("../src/config/redis", () => ({
  redis: {
    get: jest.fn(),
    setex: jest.fn(),
    keys: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { db } from "../src/db/client";
import { redis } from "../src/config/redis";
import {
  getGlobalLeaderboard,
  getGlobalLeaderboardEntry,
  getGlobalLeaderboardWithRefresh,
  refreshGlobalLeaderboard,
  type GlobalLeaderboardEntry,
} from "../src/services/globalLeaderboardService";

// ── Shared fixture ───────────────────────────────────────────────────────────

const entry1: GlobalLeaderboardEntry = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  stellar_address: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
  total_predictions: 100,
  correct_predictions: 90,
  accuracy_percentage: 90.0,
  total_markets: 5,
  rank: 1,
};

const entry2: GlobalLeaderboardEntry = {
  user_id: "660e8400-e29b-41d4-a716-446655440001",
  stellar_address: "GBTCHKHMWCS5TOX2LAD4DAEKTC3UFSFXQ2MRLED5EYOA34RH4ZX72JK",
  total_predictions: 80,
  correct_predictions: 60,
  accuracy_percentage: 75.0,
  total_markets: 3,
  rank: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── getGlobalLeaderboard ─────────────────────────────────────────────────────

describe("getGlobalLeaderboard", () => {
  describe("cache behaviour", () => {
    it("returns cached data on a cache hit without querying the DB", async () => {
      (redis.get as any).mockResolvedValueOnce(JSON.stringify([entry1, entry2]));

      const result = await getGlobalLeaderboard(50, 0);

      expect(result).toEqual([entry1, entry2]);
      expect(redis.get).toHaveBeenCalledWith("leaderboard:global:50:0");
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("queries the DB on a cache miss and writes the result", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      const result = await getGlobalLeaderboard(50, 0);

      expect(result).toEqual([entry1]);
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:global:50:0",
        300,
        JSON.stringify([entry1]),
      );
    });

    it("uses a per-page cache key that encodes limit and offset", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      await getGlobalLeaderboard(25, 100);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:global:25:100");
      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:global:25:100",
        300,
        expect.any(String),
      );
    });

    it("does not cache empty results", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      const result = await getGlobalLeaderboard(50, 1000);

      expect(result).toEqual([]);
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it("falls back to the DB when the cache read throws", async () => {
      (redis.get as any).mockRejectedValueOnce(new Error("Redis timeout"));
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      const result = await getGlobalLeaderboard(50, 0);

      expect(result).toEqual([entry1]);
      expect(db.execute).toHaveBeenCalled();
    });

    it("still returns data when the cache write fails", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });
      (redis.setex as any).mockRejectedValueOnce(new Error("Redis write fail"));

      const result = await getGlobalLeaderboard(50, 0);

      expect(result).toEqual([entry1]);
    });
  });

  describe("default parameters", () => {
    it("defaults to limit=50, offset=0", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      await getGlobalLeaderboard();

      expect(redis.get).toHaveBeenCalledWith("leaderboard:global:50:0");
    });
  });

  describe("DB errors", () => {
    it("propagates DB errors to the caller", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockRejectedValueOnce(new Error("PG connection lost"));

      await expect(getGlobalLeaderboard(50, 0)).rejects.toThrow(
        "PG connection lost",
      );
    });
  });

  describe("pagination", () => {
    it("accepts limit=100 (maximum)", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      await getGlobalLeaderboard(100, 0);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:global:100:0");
    });

    it("accepts offset=0", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      await getGlobalLeaderboard(50, 0);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:global:50:0");
    });

    it("accepts large offsets (deep pagination)", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      await getGlobalLeaderboard(50, 500);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:global:50:500");
    });
  });
});

// ── getGlobalLeaderboardEntry ─────────────────────────────────────────────────

describe("getGlobalLeaderboardEntry", () => {
  const addr = entry1.stellar_address;

  describe("cache behaviour", () => {
    it("returns cached entry on a cache hit without querying the DB", async () => {
      (redis.get as any).mockResolvedValueOnce(JSON.stringify(entry1));

      const result = await getGlobalLeaderboardEntry(addr);

      expect(result).toEqual(entry1);
      expect(redis.get).toHaveBeenCalledWith(`leaderboard:global:user:${addr}`);
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("returns null from cache when the address is known-missing", async () => {
      (redis.get as any).mockResolvedValueOnce(JSON.stringify(null));

      const result = await getGlobalLeaderboardEntry("GNOTFOUND");

      expect(result).toBeNull();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("queries the DB on a cache miss and caches the result", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      const result = await getGlobalLeaderboardEntry(addr);

      expect(result).toEqual(entry1);
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(redis.setex).toHaveBeenCalledWith(
        `leaderboard:global:user:${addr}`,
        300,
        JSON.stringify(entry1),
      );
    });

    it("caches null when the user is not found (negative cache)", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      const result = await getGlobalLeaderboardEntry("GUNKNOWN");

      expect(result).toBeNull();
      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:global:user:GUNKNOWN",
        300,
        JSON.stringify(null),
      );
    });

    it("falls back to the DB when the cache read throws", async () => {
      (redis.get as any).mockRejectedValueOnce(new Error("Cache down"));
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      const result = await getGlobalLeaderboardEntry(addr);

      expect(result).toEqual(entry1);
    });

    it("still returns data when the cache write fails", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });
      (redis.setex as any).mockRejectedValueOnce(new Error("Write fail"));

      const result = await getGlobalLeaderboardEntry(addr);

      expect(result).toEqual(entry1);
    });
  });

  describe("DB errors", () => {
    it("propagates DB errors to the caller", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockRejectedValueOnce(new Error("PG unavailable"));

      await expect(getGlobalLeaderboardEntry(addr)).rejects.toThrow(
        "PG unavailable",
      );
    });
  });

  describe("return value", () => {
    it("returns null when the user has no predictions", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      expect(await getGlobalLeaderboardEntry("GNOPREDICT")).toBeNull();
    });

    it("returns the correct entry with all fields", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry1] });

      const result = await getGlobalLeaderboardEntry(addr);

      expect(result).toMatchObject({
        user_id: entry1.user_id,
        stellar_address: entry1.stellar_address,
        total_predictions: entry1.total_predictions,
        correct_predictions: entry1.correct_predictions,
        accuracy_percentage: entry1.accuracy_percentage,
        total_markets: entry1.total_markets,
        rank: entry1.rank,
      });
    });

    it("uses the stellar address in the cache key", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [entry2] });

      await getGlobalLeaderboardEntry(entry2.stellar_address);

      expect(redis.get).toHaveBeenCalledWith(
        `leaderboard:global:user:${entry2.stellar_address}`,
      );
    });
  });
});

// ── refreshGlobalLeaderboard ─────────────────────────────────────────────────

describe("refreshGlobalLeaderboard", () => {
  it("executes REFRESH MATERIALIZED VIEW CONCURRENTLY on address_aggregates_mv", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any).mockResolvedValueOnce(undefined);

    await refreshGlobalLeaderboard();

    expect(db.execute).toHaveBeenCalledTimes(1);
    const sqlCall = JSON.stringify((db.execute as any).mock.calls[0][0]);
    expect(sqlCall).toContain("REFRESH");
    expect(sqlCall).toContain("MATERIALIZED");
    expect(sqlCall).toContain("CONCURRENTLY");
    expect(sqlCall).toContain("address_aggregates_mv");
  });

  it("invalidates all leaderboard:global:* keys from Redis", async () => {
    const keys = [
      "leaderboard:global:50:0",
      "leaderboard:global:25:0",
      "leaderboard:global:user:GAAA",
    ];
    (redis.keys as any).mockResolvedValueOnce(keys);
    (redis.del as any).mockResolvedValueOnce(3);
    (db.execute as any).mockResolvedValueOnce(undefined);

    await refreshGlobalLeaderboard();

    expect(redis.keys).toHaveBeenCalledWith("leaderboard:global:*");
    expect(redis.del).toHaveBeenCalledWith(...keys);
  });

  it("skips Redis del when no cache keys exist", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any).mockResolvedValueOnce(undefined);

    await refreshGlobalLeaderboard();

    expect(redis.del).not.toHaveBeenCalled();
  });

  it("propagates DB errors to the caller", async () => {
    (db.execute as any).mockRejectedValueOnce(new Error("View refresh failed"));

    await expect(refreshGlobalLeaderboard()).rejects.toThrow(
      "View refresh failed",
    );
  });

  it("does not throw when Redis cache invalidation fails", async () => {
    (db.execute as any).mockResolvedValueOnce(undefined);
    (redis.keys as any).mockRejectedValueOnce(new Error("Redis down"));

    // Should still succeed despite the cache failure
    await expect(refreshGlobalLeaderboard()).resolves.toBeUndefined();
  });
});

// ── getGlobalLeaderboardWithRefresh ──────────────────────────────────────────

describe("getGlobalLeaderboardWithRefresh", () => {
  it("refreshes the view then returns fresh paginated results", async () => {
    // First db.execute call = REFRESH; second = SELECT
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any)
      .mockResolvedValueOnce(undefined) // REFRESH call
      .mockResolvedValueOnce({ rows: [entry1] }); // SELECT call after cache miss
    (redis.get as any).mockResolvedValueOnce(null); // cache miss after invalidation

    const result = await getGlobalLeaderboardWithRefresh(50, 0);

    expect(result).toEqual([entry1]);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("uses the provided limit and offset for the paginated query", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [entry2] });
    (redis.get as any).mockResolvedValueOnce(null);

    const result = await getGlobalLeaderboardWithRefresh(10, 20);

    expect(result).toEqual([entry2]);
    expect(redis.get).toHaveBeenCalledWith("leaderboard:global:10:20");
  });

  it("defaults to limit=50, offset=0", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] });
    (redis.get as any).mockResolvedValueOnce(null);

    await getGlobalLeaderboardWithRefresh();

    expect(redis.get).toHaveBeenCalledWith("leaderboard:global:50:0");
  });

  it("propagates DB errors from the refresh step", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any).mockRejectedValueOnce(new Error("Refresh failed"));

    await expect(getGlobalLeaderboardWithRefresh(50, 0)).rejects.toThrow(
      "Refresh failed",
    );
  });

  it("propagates DB errors from the subsequent query step", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    (db.execute as any)
      .mockResolvedValueOnce(undefined) // refresh OK
      .mockRejectedValueOnce(new Error("Query failed")); // select fails
    (redis.get as any).mockResolvedValueOnce(null);

    await expect(getGlobalLeaderboardWithRefresh(50, 0)).rejects.toThrow(
      "Query failed",
    );
  });
});
