/**
 * Tests for the notification digest worker (#217).
 * The DB layer is mocked; we assert digest grouping and per-user delivery.
 */
import {
  buildDigests,
  runNotificationDigest,
  type UserDigest,
} from "../src/workers/notificationDigest";
import { db } from "../src/db";

jest.mock("../src/db", () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn(),
  };
  return { db: chain };
});

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDb = db as unknown as { where: jest.Mock };

describe("notificationDigest", () => {
  beforeEach(() => jest.clearAllMocks());

  it("groups enabled preferences into one digest per user with sorted categories", async () => {
    mockDb.where.mockResolvedValue([
      { userId: "u1", category: "market" },
      { userId: "u1", category: "auth" },
      { userId: "u2", category: "market" },
    ]);

    const digests = await buildDigests();

    expect(digests).toHaveLength(2);
    const u1 = digests.find((d) => d.userId === "u1") as UserDigest;
    expect(u1.categories).toEqual(["auth", "market"]);
    expect(digests.find((d) => d.userId === "u2")?.categories).toEqual(["market"]);
  });

  it("delivers one digest per user and counts successes", async () => {
    mockDb.where.mockResolvedValue([
      { userId: "u1", category: "market" },
      { userId: "u2", category: "market" },
    ]);
    const sink = jest.fn().mockResolvedValue(undefined);

    const result = await runNotificationDigest(sink, "weekly");

    expect(sink).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ delivered: 2, failed: 1 - 1 });
  });

  it("isolates sink failures without aborting the run", async () => {
    mockDb.where.mockResolvedValue([
      { userId: "u1", category: "market" },
      { userId: "u2", category: "market" },
    ]);
    const sink = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const result = await runNotificationDigest(sink);

    expect(result).toEqual({ delivered: 1, failed: 1 });
  });
});
