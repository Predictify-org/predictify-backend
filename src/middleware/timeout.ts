import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";

export interface RequestTimeoutOptions {
  /** HTTP status code to send when the timeout is exceeded. Defaults to 408. */
  statusCode?: number;
  /** Machine-readable error code included in the response envelope. Defaults to "timeout". */
  code?: string;
  /** Human-readable message included in the response envelope. */
  message?: string;
}

/**
 * Creates an Express middleware that enforces a maximum request duration.
 * If the route handler does not finish before `timeoutMs`, the request is
 * aborted gracefully with an error envelope (408 Request Timeout by default).
 *
 * The AbortSignal exposed on `res.locals.abortSignal` lets downstream route
 * handlers cooperatively stop waiting on in-flight work (e.g. via
 * `abortableRace`) once the deadline is reached or the client disconnects,
 * instead of forcibly killing the underlying operation.
 *
 * When the timeout fires a structured warning is emitted at `logger.warn` with:
 *   - `correlationId` — echoed from `res.locals.correlationId` (or "unknown")
 *   - `timeoutMs`     — the configured deadline
 *   - `path`          — `req.originalUrl` for easier log queries
 *   - `method`        — HTTP method
 *
 * @param timeoutMs - Time in milliseconds before the request times out
 * @param options   - Overrides for the status code / error code / message sent on timeout
 */
export function requestTimeout(timeoutMs: number, options: RequestTimeoutOptions = {}) {
  const {
    statusCode = 408,
    code = "timeout",
    message = "Request timeout exceeded",
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    let settled = false;
    const controller = new AbortController();
    res.locals.abortSignal = controller.signal;

    const finish = () => {
      settled = true;
      clearTimeout(timer);
    };

    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      abort();

      if (!res.headersSent) {
        // Structured warning so ops tooling / dashboards can alert on
        // request_timeout_exceeded events by path and configured deadline.
        const correlationId = (res.locals.correlationId as string) || "unknown";
        logger.warn(
          {
            correlationId,
            timeoutMs,
            path: req.originalUrl,
            method: req.method,
          },
          "request_timeout_exceeded",
        );

        res.status(statusCode).json({
          error: {
            code,
            message,
            requestId: correlationId,
          },
        });
      }
    }, timeoutMs);

    req.on("close", () => {
      abort();
    });

    res.on("finish", finish);
    res.on("close", finish);

    next();
  };
}

/** Thrown by `abortableRace` when the given signal fires before the promise settles. */
export class RequestAbortedError extends Error {
  constructor(message = "Request aborted before completion") {
    super(message);
    this.name = "RequestAbortedError";
  }
}

/**
 * Races `promise` against `signal`. If `signal` aborts first, the returned
 * promise rejects with `RequestAbortedError` so the caller can stop waiting
 * on (and acting on the result of) work that the timeout middleware has
 * already given up on — cooperative cancellation rather than a hard kill of
 * the underlying operation.
 */
export function abortableRace<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new RequestAbortedError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RequestAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
