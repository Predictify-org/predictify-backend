import {
  initFeatureFlags,
  stopFeatureFlags,
  getFlag,
  getAllFlags,
  createFlag,
  updateFlag,
  deleteFlag,
} from "../src/services/featureFlags";
import { db } from "../src/db/client";

jest.mock("../src/db/client", () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    fatal: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("Feature Flags Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopFeatureFlags();
    jest.useRealTimers();
  });

  it("loads flags on init and caches them", async () => {
    const mockRows = [{ id: "test-flag", enabled: true, variant: "A", description: "test" }];
    const selectMock = { from: jest.fn().mockResolvedValue(mockRows) };
    (db.select as jest.Mock).mockReturnValue(selectMock);

    await initFeatureFlags();

    const all = getAllFlags();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("test-flag");

    const flag = getFlag("test-flag");
    expect(flag).toEqual({ enabled: true, variant: "A" });
  });

  it("refreshes cache on interval and handles error gracefully", async () => {
    const mockRows = [{ id: "test-flag", enabled: true, variant: "A", description: "test" }];
    const selectMock = { from: jest.fn().mockResolvedValueOnce(mockRows) };
    (db.select as jest.Mock).mockReturnValue(selectMock);

    await initFeatureFlags();
    expect(getAllFlags()).toHaveLength(1);

    // Now make the next fetch fail
    selectMock.from.mockRejectedValueOnce(new Error("DB Error"));
    
    // Advance timers
    jest.advanceTimersByTime(30000); // default 30s
    await Promise.resolve(); // flush promises

    // Should keep stale cache
    expect(getAllFlags()).toHaveLength(1);
  });

  it("creates a flag and updates cache", async () => {
    const mockRow = { id: "new-flag", enabled: true, variant: "B", description: null };
    const insertMock = {
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([mockRow]),
      }),
    };
    (db.insert as jest.Mock).mockReturnValue(insertMock);

    const result = await createFlag({ key: "new-flag", enabled: true, variant: "B" });
    
    expect(result.id).toBe("new-flag");
    expect(getFlag("new-flag")).toEqual({ enabled: true, variant: "B" });
  });

  it("updates a flag and updates cache", async () => {
    const mockRow = { id: "existing-flag", enabled: false, variant: "C", description: null };
    const updateMock = {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([mockRow]),
        }),
      }),
    };
    (db.update as jest.Mock).mockReturnValue(updateMock);

    const result = await updateFlag("existing-flag", { enabled: false, variant: "C" });
    
    expect(result?.id).toBe("existing-flag");
    expect(getFlag("existing-flag")).toEqual({ enabled: false, variant: "C" });
  });

  it("deletes a flag and updates cache", async () => {
    // Manually add to cache by initializing first or just rely on delete logic
    const mockRow = { id: "delete-me", enabled: true, variant: null, description: null };
    const deleteMock = {
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([mockRow]),
      }),
    };
    (db.delete as jest.Mock).mockReturnValue(deleteMock);

    const result = await deleteFlag("delete-me");
    expect(result).toBe(true);
    expect(getFlag("delete-me")).toBeUndefined();
  });
});
