/**
 * requestId.test.ts
 *
 * Covers acceptance criteria for the X-Request-Id propagation feature:
 *
 *  1. Inbound X-Request-Id is echoed back in the response header.
 *  2. When no inbound id is provided, a UUID v4 is generated and echoed.
 *  3. An oversized inbound id is capped at 64 characters.
 *  4. Characters outside [A-Za-z0-9\-_.] are stripped (injection prevention).
 *  5. The id appears in the error envelope (requestId field).
 *  6. AsyncLocalStorage: getRequestId() returns the id within a request context.
 *  7. fetchWithRequestId forwards the id header to outbound calls.
 */

import request from "supertest";
import { createApp } from "../src/index";
import { requestContextStorage, getRequestId } from "../src/lib/requestContext";
import { fetchWithRequestId, REQUEST_ID_HEADER } from "../src/lib/http";

// ── helpers ────────────────────────────────────────────────────────────────

/** UUID v4 regex. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── 1 & 2: Response header echoing ────────────────────────────────────────

describe("X-Request-Id response header", () => {
  const app = createApp();

  it("echoes an inbound X-Request-Id", async () => {
    const inboundId = "my-trace-abc-123";
    const res = await request(app)
      .get("/health")
      .set("x-request-id", inboundId);

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe(inboundId);
  });

  it("generates a UUID v4 when no X-Request-Id is provided", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    const id = res.headers["x-request-id"] as string;
    expect(id).toMatch(UUID_RE);
  });

  it("generates different IDs for consecutive requests", async () => {
    const [r1, r2] = await Promise.all([
      request(app).get("/health"),
      request(app).get("/health"),
    ]);
    expect(r1.headers["x-request-id"]).not.toBe(r2.headers["x-request-id"]);
  });
});

// ── 3 & 4: Sanitisation ───────────────────────────────────────────────────

describe("X-Request-Id sanitisation", () => {
  const app = createApp();

  it("truncates an id that exceeds 64 characters", async () => {
    const longId = "a".repeat(100);
    const res = await request(app)
      .get("/health")
      .set("x-request-id", longId);

    expect(res.headers["x-request-id"]).toHaveLength(64);
  });

  it("strips characters outside [A-Za-z0-9\\-_.]", async () => {
    // newlines, angle brackets, and semicolons are classic log-injection chars
    const maliciousId = "ok-id\nnewline<script>;drop";
    const res = await request(app)
      .get("/health")
      .set("x-request-id", maliciousId);

    const echoed = res.headers["x-request-id"] as string;
    expect(echoed).toBe("ok-idnewlinescriptdrop");
  });

  it("returns a generated UUID when inbound id becomes empty after sanitisation", async () => {
    // All characters are outside the safe set — result after sanitising is "".
    // pinoHttp sanitises via genReqId; an empty string is falsy so a UUID is
    // generated instead.
    const res = await request(app)
      .get("/health")
      .set("x-request-id", "!!!###$$$");

    const echoed = res.headers["x-request-id"] as string;
    // Either a UUID or the sanitised (possibly empty → UUID) value.
    // The sanitise function returns "" here which is falsy → UUID generated.
    expect(echoed).toMatch(UUID_RE);
  });
});

// ── 5: Error envelope ─────────────────────────────────────────────────────

describe("Error envelope includes requestId", () => {
  it("includes the inbound request id in a 404 response header", async () => {
    const id = "debug-id-404";
    const res = await request(createApp())
      .get("/api/markets/nonexistent-id-that-returns-404")
      .set("x-request-id", id);

    // The market stub returns null → 404 with error envelope.
    expect(res.status).toBe(404);
    // The X-Request-Id response header must be echoed.
    expect(res.headers["x-request-id"]).toBe(id);
  });

  it("includes requestId in the 500 error envelope via errorHandler (unit)", async () => {
    // Unit-test the error handler directly by calling it with mocked
    // Request / Response objects that mimic what Express + pinoHttp produce.
    const { errorHandler } = await import("../src/middleware/errorHandler");
    const { requestContextStorage: ctx } = await import("../src/lib/requestContext");

    const id = "debug-id-500";
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    const fakeReq = {
      id,
      path: "/test",
      method: "GET",
      headers: {},
    } as unknown as import("express").Request;

    const fakeRes = {
      status: statusMock,
    } as unknown as import("express").Response;

    // Run inside an ALS context the same way the real middleware does.
    await new Promise<void>((resolve) => {
      ctx.run({ requestId: id }, () => {
        errorHandler(new Error("boom"), fakeReq, fakeRes, jest.fn());
        resolve();
      });
    });

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ requestId: id }),
      }),
    );
  });
});

// ── 6: AsyncLocalStorage ──────────────────────────────────────────────────

describe("AsyncLocalStorage – getRequestId()", () => {
  it("returns undefined outside a request context", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("returns the stored request id inside a run() context", async () => {
    const id = "als-test-id";
    await new Promise<void>((resolve) => {
      requestContextStorage.run({ requestId: id }, () => {
        expect(getRequestId()).toBe(id);
        resolve();
      });
    });
  });

  it("isolates ids across concurrent contexts", async () => {
    const results: string[] = [];

    await Promise.all(
      ["ctx-A", "ctx-B", "ctx-C"].map(
        (id) =>
          new Promise<void>((resolve) => {
            requestContextStorage.run({ requestId: id }, () => {
              // Simulate async work before reading.
              setImmediate(() => {
                results.push(getRequestId()!);
                resolve();
              });
            });
          }),
      ),
    );

    expect(results.sort()).toEqual(["ctx-A", "ctx-B", "ctx-C"]);
  });

  it("is accessible within a request handler via getRequestId()", async () => {
    let capturedId: string | undefined;

    const app = createApp();
    app.get("/capture", (_req, res) => {
      capturedId = getRequestId();
      res.json({ ok: true });
    });

    const inboundId = "handler-capture-id";
    await request(app).get("/capture").set("x-request-id", inboundId);

    expect(capturedId).toBe(inboundId);
  });
});

// ── 7: fetchWithRequestId ─────────────────────────────────────────────────

describe("fetchWithRequestId", () => {
  it("forwards the current request id as X-Request-Id", async () => {
    const id = "fetch-test-id";
    let capturedHeader: string | null = null;

    // Stub global fetch to inspect headers without making a real network call.
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (_input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get(REQUEST_ID_HEADER);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    await requestContextStorage.run({ requestId: id }, async () => {
      await fetchWithRequestId("https://example.com/rpc");
    });

    expect(capturedHeader).toBe(id);
    global.fetch = originalFetch;
  });

  it("does not add the header when outside a request context", async () => {
    let capturedHeader: string | null = "sentinel";

    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (_input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get(REQUEST_ID_HEADER);
      return new Response(null, { status: 200 });
    }) as any;

    await fetchWithRequestId("https://example.com/rpc");

    expect(capturedHeader).toBeNull();
    global.fetch = originalFetch;
  });

  it("preserves existing headers passed by the caller", async () => {
    const id = "preserve-headers-id";
    let capturedHeaders: Headers | null = null;

    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (_input: any, init?: any) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 200 });
    }) as any;

    await requestContextStorage.run({ requestId: id }, async () => {
      await fetchWithRequestId("https://example.com/rpc", {
        headers: { "content-type": "application/json" },
      });
    });

    expect(capturedHeaders!.get("content-type")).toBe("application/json");
    expect(capturedHeaders!.get(REQUEST_ID_HEADER)).toBe(id);
    global.fetch = originalFetch;
  });
});
