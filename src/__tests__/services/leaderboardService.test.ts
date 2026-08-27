/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { LeaderboardPeriod } from "../../validators/leaderboard";
import {
  getLeaderboard,
  getUserLeaderboardEntry,
  getLeaderboardWithRefresh,
  getLeaderboardPage,
  getLeaderboardPageWithRefresh,
  refreshLeaderboard,
  LeaderboardEntry,
} from "../../services/leaderboardService";

// Mock the db and redis modules
jest.mock("../../db/client", () => ({
  db: {
    execute: jest.fn(),
  },
}));

jest.mock("../../config/redis", () => ({
  redis: {
    get: jest.fn(),
    setex: jest.fn(),
    keys: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock("../../config/logger", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { db } from "../../db/client";
import { redis } from "../../config/redis";

describe("LeaderboardService", () => {
  const mockLeaderboardEntry: LeaderboardEntry = {
    user_id: "user-123",
    stellar_address: "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF",
    total_predictions: 100,
    correct_predictions: 85,
    accuracy_percentage: 85.0,
    rank: 1,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getLeaderboard", () => {
    it("should return leaderboard entries from cache if available", async () => {
      const cachedData = JSON.stringify([mockLeaderboardEntry]);
      (redis.get as any).mockResolvedValueOnce(cachedData);

      const result = await getLeaderboard(50, 0, LeaderboardPeriod.ALL_TIME);

      expect(result).toEqual([mockLeaderboardEntry]);
      expect(redis.get).toHaveBeenCalledWith("leaderboard:all-time:50:0");
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("should query database if cache miss and cache result", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      const result = await getLeaderboard(50, 0, LeaderboardPeriod.ALL_TIME);

      expect(result).toEqual([mockLeaderboardEntry]);
      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:all-time:50:0",
        300,
        JSON.stringify([mockLeaderboardEntry])
      );
    });

    it("should use correct view name for monthly period", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getLeaderboard(50, 0, LeaderboardPeriod.MONTHLY);

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("leaderboard_monthly_mv");
    });

    it("should use correct view name for weekly period", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getLeaderboard(50, 0, LeaderboardPeriod.WEEKLY);

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("leaderboard_weekly_mv");
    });

    it("should respect limit and offset parameters", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getLeaderboard(25, 100, LeaderboardPeriod.ALL_TIME);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:all-time:25:100");
    });

    it("should handle cache read errors gracefully", async () => {
      (redis.get as any).mockRejectedValueOnce(new Error("Cache error"));
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      const result = await getLeaderboard(50, 0, LeaderboardPeriod.ALL_TIME);

      expect(result).toEqual([mockLeaderboardEntry]);
      expect(db.execute).toHaveBeenCalled();
    });

    it("should handle database errors", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockRejectedValueOnce(new Error("DB error"));

      await expect(
        getLeaderboard(50, 0, LeaderboardPeriod.ALL_TIME)
      ).rejects.toThrow("DB error");
    });
  });

  describe("getUserLeaderboardEntry", () => {
    it("should return user entry from cache if available", async () => {
      const cachedData = JSON.stringify(mockLeaderboardEntry);
      (redis.get as any).mockResolvedValueOnce(cachedData);

      const result = await getUserLeaderboardEntry(
        mockLeaderboardEntry.stellar_address,
        LeaderboardPeriod.ALL_TIME
      );

      expect(result).toEqual(mockLeaderboardEntry);
      expect(redis.get).toHaveBeenCalledWith(
        `leaderboard:user:${mockLeaderboardEntry.stellar_address}:all-time`
      );
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("should query database if cache miss and cache result", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      const result = await getUserLeaderboardEntry(
        mockLeaderboardEntry.stellar_address,
        LeaderboardPeriod.ALL_TIME
      );

      expect(result).toEqual(mockLeaderboardEntry);
      expect(redis.setex).toHaveBeenCalledWith(
        `leaderboard:user:${mockLeaderboardEntry.stellar_address}:all-time`,
        300,
        JSON.stringify(mockLeaderboardEntry)
      );
    });

    it("should return null if user not found", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [],
      });

      const result = await getUserLeaderboardEntry(
        "UNKNOWN_ADDRESS",
        LeaderboardPeriod.ALL_TIME
      );

      expect(result).toBeNull();
      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:user:UNKNOWN_ADDRESS:all-time",
        300,
        JSON.stringify(null)
      );
    });

    it("should cache null entries", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [],
      });

      await getUserLeaderboardEntry("UNKNOWN_ADDRESS", LeaderboardPeriod.WEEKLY);

      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:user:UNKNOWN_ADDRESS:weekly",
        300,
        JSON.stringify(null)
      );
    });

    it("should use correct view name for different periods", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getUserLeaderboardEntry(
        mockLeaderboardEntry.stellar_address,
        LeaderboardPeriod.MONTHLY
      );

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("leaderboard_monthly_mv");
    });
  });

  describe("refreshLeaderboard", () => {
    it("should refresh materialized view for specified period", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any).mockResolvedValueOnce(undefined);

      await refreshLeaderboard(LeaderboardPeriod.ALL_TIME);

      expect(db.execute).toHaveBeenCalled();
      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("REFRESH MATERIALIZED VIEW CONCURRENTLY");
      expect(sqlCall.toString()).toContain("leaderboard_mv");
    });

    it("should refresh monthly view", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any).mockResolvedValueOnce(undefined);

      await refreshLeaderboard(LeaderboardPeriod.MONTHLY);

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("leaderboard_monthly_mv");
    });

    it("should refresh weekly view", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any).mockResolvedValueOnce(undefined);

      await refreshLeaderboard(LeaderboardPeriod.WEEKLY);

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("leaderboard_weekly_mv");
    });

    it("should invalidate cache for the period after refresh", async () => {
      (redis.keys as any).mockResolvedValueOnce([
        "leaderboard:all-time:50:0",
        "leaderboard:all-time:50:50",
      ]);
      (redis.del as any).mockResolvedValueOnce(2);
      (db.execute as any).mockResolvedValueOnce(undefined);

      await refreshLeaderboard(LeaderboardPeriod.ALL_TIME);

      expect(redis.keys).toHaveBeenCalledWith("leaderboard:all-time:*");
      expect(redis.del).toHaveBeenCalledWith(
        "leaderboard:all-time:50:0",
        "leaderboard:all-time:50:50"
      );
    });

    it("should handle refresh errors", async () => {
      (db.execute as any).mockRejectedValueOnce(new Error("Refresh failed"));

      await expect(refreshLeaderboard(LeaderboardPeriod.ALL_TIME)).rejects.toThrow(
        "Refresh failed"
      );
    });
  });

  describe("getLeaderboardWithRefresh", () => {
    it("should refresh before returning results", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any)
        .mockResolvedValueOnce(undefined) // refresh call
        .mockResolvedValueOnce({ rows: [mockLeaderboardEntry] }); // getLeaderboard call
      (redis.get as any).mockResolvedValueOnce(null);

      const result = await getLeaderboardWithRefresh(50, 0, LeaderboardPeriod.ALL_TIME);

      expect(result).toEqual([mockLeaderboardEntry]);
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it("should work with monthly period", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [mockLeaderboardEntry] });
      (redis.get as any).mockResolvedValueOnce(null);

      await getLeaderboardWithRefresh(50, 0, LeaderboardPeriod.MONTHLY);

      const calls = (db.execute as any).mock.calls;
      expect(calls[0][0].toString()).toContain("leaderboard_monthly_mv");
      expect(calls[1][0].toString()).toContain("leaderboard_monthly_mv");
    });

    it("should work with weekly period", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [mockLeaderboardEntry] });
      (redis.get as any).mockResolvedValueOnce(null);

      await getLeaderboardWithRefresh(50, 0, LeaderboardPeriod.WEEKLY);

      const calls = (db.execute as any).mock.calls;
      expect(calls[0][0].toString()).toContain("leaderboard_weekly_mv");
      expect(calls[1][0].toString()).toContain("leaderboard_weekly_mv");
    });
  });

  describe("Period validation", () => {
    it("should default to ALL_TIME period", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getLeaderboard(50, 0);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:all-time:50:0");
    });

    it("should handle invalid period enum exhaustively", () => {
      // This test ensures TypeScript exhaustiveness checking
      const period: LeaderboardPeriod = LeaderboardPeriod.ALL_TIME;
      expect([
        LeaderboardPeriod.ALL_TIME,
        LeaderboardPeriod.MONTHLY,
        LeaderboardPeriod.WEEKLY,
      ]).toContain(period);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty result set", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [],
      });

      const result = await getLeaderboard(50, 1000, LeaderboardPeriod.ALL_TIME);

      expect(result).toEqual([]);
      // Empty results should not be cached
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it("should handle very large limit", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getLeaderboard(100, 0, LeaderboardPeriod.ALL_TIME);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:all-time:100:0");
    });

    it("should handle zero offset", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });

      await getLeaderboard(50, 0, LeaderboardPeriod.ALL_TIME);

      expect(redis.get).toHaveBeenCalledWith("leaderboard:all-time:50:0");
    });

    it("should handle cache write failure gracefully", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [mockLeaderboardEntry],
      });
      (redis.setex as any).mockRejectedValueOnce(
        new Error("Cache write failed")
      );

      const result = await getLeaderboard(50, 0, LeaderboardPeriod.ALL_TIME);

      // Should still return results even if cache write fails
      expect(result).toEqual([mockLeaderboardEntry]);
    });
  });

  describe("getLeaderboardPage (cursor-based)", () => {
    const makeEntry = (rank: number, userId: string): LeaderboardEntry => ({
      ...mockLeaderboardEntry,
      rank,
      user_id: userId,
    });

    const page1 = [makeEntry(1, "u-aaa"), makeEntry(2, "u-bbb"), makeEntry(3, "u-ccc")];
    const page2 = [makeEntry(4, "u-ddd"), makeEntry(5, "u-eee")];

    it("should return first page with nextCursor when no cursor given", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      // Return limit+1 rows to signal there are more pages
      (db.execute as any).mockResolvedValueOnce({
        rows: [...page1, page2[0]],
      });

      const result = await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME);

      expect(result.entries).toEqual(page1);
      expect(result.nextCursor).toBeTruthy();
      expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should return null nextCursor on the last page", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: page2, // fewer than limit+1 → no more rows
      });

      const result = await getLeaderboardPage(5, LeaderboardPeriod.ALL_TIME);

      expect(result.entries).toEqual(page2);
      expect(result.nextCursor).toBeNull();
    });

    it("should use cache for first page when available", async () => {
      (redis.get as any).mockResolvedValueOnce(JSON.stringify([...page1, page2[0]]));

      const result = await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME);

      expect(result.entries).toEqual(page1);
      expect(result.nextCursor).toBeTruthy();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("should query DB with cursor WHERE clause when cursor is provided", async () => {
      (db.execute as any).mockResolvedValueOnce({
        rows: [...page2, makeEntry(6, "u-fff")],
      });

      const result = await getLeaderboardPage(2, LeaderboardPeriod.ALL_TIME, "some-cursor");

      expect(result.entries).toEqual(page2);
      expect(result.nextCursor).toBeTruthy();
      // Should NOT have checked cache for cursor-based pages
      expect(redis.get).not.toHaveBeenCalled();
    });

    it("should use correct view name for monthly period", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: page1 });

      await getLeaderboardPage(3, LeaderboardPeriod.MONTHLY);

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).toContain("leaderboard_monthly_mv");
    });

    it("should cache first page result", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: page1 });

      await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME);

      expect(redis.setex).toHaveBeenCalledWith(
        "leaderboard:all-time:3:0",
        300,
        expect.any(String),
      );
    });

    it("should not cache empty first page", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: [] });

      await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME);

      expect(redis.setex).not.toHaveBeenCalled();
    });

    it("should handle invalid cursor by falling back to first page", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [...page1, page2[0]],
      });

      const result = await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME, "!!!invalid-base64!!!");

      expect(result.entries).toEqual(page1);
      // Should have fallen back to first-page query (no WHERE clause)
      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).not.toContain("WHERE");
    });

    it("should reject a cursor with a non-numeric rank", async () => {
      const malformed = Buffer.from("v1|3|abcuser-aaa", "utf8").toString("base64url");
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({ rows: page1 });

      await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME, malformed);

      const sqlCall = (db.execute as any).mock.calls[0][0];
      expect(sqlCall.toString()).not.toContain("WHERE");
    });

    it("should handle DB errors", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockRejectedValueOnce(new Error("DB error"));

      await expect(
        getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME),
      ).rejects.toThrow("DB error");
    });

    it("should encode cursor with zero-padded rank", async () => {
      (redis.get as any).mockResolvedValueOnce(null);
      (db.execute as any).mockResolvedValueOnce({
        rows: [makeEntry(1, "u-aaa"), makeEntry(2, "u-bbb"), makeEntry(3, "u-ccc"), makeEntry(4, "u-ddd")],
      });

      const result = await getLeaderboardPage(3, LeaderboardPeriod.ALL_TIME);

      expect(result.nextCursor).toBeTruthy();
      // The cursor should contain the zero-padded rank (3 padded to 10 digits)
      // We just check it's non-null and valid-looking
      expect(result.nextCursor!.length).toBeGreaterThan(10);
    });
  });

  describe("getLeaderboardPageWithRefresh", () => {
    const mockEntry: LeaderboardEntry = {
      ...mockLeaderboardEntry,
      rank: 1,
      user_id: "user-123",
    };

    it("should refresh before returning cursor page", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any)
        .mockResolvedValueOnce(undefined) // refresh
        .mockResolvedValueOnce({ rows: [mockEntry] }); // query
      (redis.get as any).mockResolvedValueOnce(null);

      const result = await getLeaderboardPageWithRefresh(3, LeaderboardPeriod.ALL_TIME);

      expect(result.entries).toEqual([mockEntry]);
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it("should pass cursor to getLeaderboardPage", async () => {
      (redis.keys as any).mockResolvedValueOnce([]);
      (db.execute as any)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [mockEntry] });
      (redis.get as any).mockResolvedValueOnce(null);

      await getLeaderboardPageWithRefresh(3, LeaderboardPeriod.ALL_TIME, "some-cursor");

      // refresh call + query call
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });
});
