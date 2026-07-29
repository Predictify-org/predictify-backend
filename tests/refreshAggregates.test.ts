jest.mock("../src/db/client", () => ({ db: {} }));
jest.mock("../src/services/addressAggregatesService");

import * as addressAggregatesService from "../src/services/addressAggregatesService";
import { startRefreshAggregatesWorker } from "../src/workers/refreshAggregates";

const mockRefresh = addressAggregatesService.refreshAddressAggregates as jest.MockedFunction<
  typeof addressAggregatesService.refreshAddressAggregates
>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("startRefreshAggregatesWorker", () => {
  it("calls refreshAddressAggregates on each interval tick", async () => {
    mockRefresh.mockResolvedValue();

    const handle = startRefreshAggregatesWorker(60_000);

    // First tick
    jest.advanceTimersByTime(60_000);
    await Promise.resolve(); // flush microtasks
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    // Second tick
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockRefresh).toHaveBeenCalledTimes(2);

    clearInterval(handle);
  });

  it("logs error but does not throw when refresh fails", async () => {
    mockRefresh.mockRejectedValueOnce(new Error("db down"));

    const handle = startRefreshAggregatesWorker(60_000);

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();

    // Worker should still be alive and callable again
    mockRefresh.mockResolvedValue();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockRefresh).toHaveBeenCalledTimes(2);

    clearInterval(handle);
  });

  it("returns a clearable interval handle", () => {
    mockRefresh.mockResolvedValue();

    const handle = startRefreshAggregatesWorker(60_000);
    clearInterval(handle);

    jest.advanceTimersByTime(120_000);
    // Should not have been called after clear
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
