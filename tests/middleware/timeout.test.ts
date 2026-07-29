import { abortableRace, RequestAbortedError, requestTimeout } from "../../src/middleware/timeout";
import { Request, Response, NextFunction } from "express";
import { logger } from "../../src/config/logger";

jest.mock("../../src/config/logger", () => ({
  logger: {
    warn: jest.fn(),
  },
}));

describe("requestTimeout Middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    jest.useFakeTimers();
    req = {
      on: jest.fn(),
      originalUrl: "/api/markets",
      method: "GET",
    };
    res = {
      locals: { correlationId: "test-req-id" },
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      on: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("calls next()", () => {
    const middleware = requestTimeout(1000);
    middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("sends 408 and logs warning when timeout is exceeded and headers are not sent", () => {
    const middleware = requestTimeout(1000);
    middleware(req as Request, res as Response, next);

    jest.advanceTimersByTime(1000);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "test-req-id", timeoutMs: 1000 }),
      "request_timeout_exceeded"
    );
    expect(res.status).toHaveBeenCalledWith(408);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "timeout",
        message: "Request timeout exceeded",
        requestId: "test-req-id",
      },
    });
  });

  it("does not send 408 or log if headers are already sent", () => {
    const middleware = requestTimeout(1000);
    res.headersSent = true;
    middleware(req as Request, res as Response, next);

    jest.advanceTimersByTime(1000);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("honors a custom statusCode/code/message, e.g. 504 for gateway timeouts", () => {
    const middleware = requestTimeout(1000, {
      statusCode: 504,
      code: "gateway_timeout",
      message: "Leaderboard request timed out",
    });
    middleware(req as Request, res as Response, next);

    jest.advanceTimersByTime(1000);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "gateway_timeout",
        message: "Leaderboard request timed out",
        requestId: "test-req-id",
      },
    });
  });
});

describe("abortableRace", () => {
  it("resolves with the promise's value when it settles before the signal aborts", async () => {
    const controller = new AbortController();
    await expect(abortableRace(Promise.resolve("ok"), controller.signal)).resolves.toBe("ok");
  });

  it("passes through the original promise when no signal is given", async () => {
    await expect(abortableRace(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("rejects with RequestAbortedError once the signal aborts, ignoring the original promise", async () => {
    const controller = new AbortController();
    const neverResolves = new Promise(() => {});

    const race = abortableRace(neverResolves, controller.signal);
    controller.abort();

    await expect(race).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortableRace(Promise.resolve("ok"), controller.signal)).rejects.toBeInstanceOf(
      RequestAbortedError,
    );
  });
});
