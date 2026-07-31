import { warmAuditCache } from "../../services/auditCacheWarm";
import { logger } from "../../config/logger";
import { env } from "../../config/env";

jest.mock("../../config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe("auditCacheWarm", () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should warm the audit cache successfully", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    await warmAuditCache();

    expect(global.fetch).toHaveBeenCalledWith(
      `http://localhost:${env.PORT}/api/audit?limit=10`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-audit-cache-warm": "true",
          "x-correlation-id": expect.any(String),
        }),
      })
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.any(String) }),
      "Starting audit cache warm"
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200 }),
      "Audit cache warm completed successfully"
    );
  });

  it("should handle failed cache warm response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await warmAuditCache();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        url: expect.any(String),
      }),
      "Audit cache warm failed"
    );
  });

  it("should handle fetch error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network Error"));

    await warmAuditCache();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        url: expect.any(String),
      }),
      "Audit cache warm failed"
    );
  });
});
