import request from "supertest";
import express from "express";
import {
  correlationMiddleware,
  getCorrelationId,
  sanitiseCorrelationId,
  resolveCorrelationId,
  CORRELATION_ID_HEADER,
  MAX_CORRELATION_ID_LEN,
  fetchWithCorrelationId,
} from "../../src/middleware/correlation";
import { requestContextStorage } from "../../src/lib/requestContext";

describe("middleware/correlation", () => {
  describe("sanitiseCorrelationId", () => {
    it("returns undefined for empty / undefined input", () => {
      expect(sanitiseCorrelationId(undefined)).toBeUndefined();
      expect(sanitiseCorrelationId("")).toBeUndefined();
    });

    it("accepts valid alphanumeric, hyphens, and underscores", () => {
      expect(sanitiseCorrelationId("abc-123_XYZ")).toBe("abc-123_XYZ");
    });

    it("strips unsafe characters such as newlines, spaces, and quotes", () => {
      expect(sanitiseCorrelationId("valid-id\n\r<script>'\"")).toBe("valid-idscript");
    });

    it("truncates correlation ID to MAX_CORRELATION_ID_LEN (128 chars)", () => {
      const longId = "a".repeat(200);
      const sanitized = sanitiseCorrelationId(longId);
      expect(sanitized).toHaveLength(MAX_CORRELATION_ID_LEN);
      expect(sanitized).toBe("a".repeat(128));
    });
  });

  describe("resolveCorrelationId", () => {
    it("prioritizes x-correlation-id over x-request-id and req.id", () => {
      const req = {
        headers: {
          [CORRELATION_ID_HEADER]: "cid-123",
          "x-request-id": "req-456",
        },
        id: "pino-789",
      } as unknown as express.Request;

      expect(resolveCorrelationId(req)).toBe("cid-123");
    });

    it("falls back to x-request-id when x-correlation-id is missing", () => {
      const req = {
        headers: {
          "x-request-id": "req-456",
        },
        id: "pino-789",
      } as unknown as express.Request;

      expect(resolveCorrelationId(req)).toBe("req-456");
    });

    it("falls back to req.id when both headers are missing", () => {
      const req = {
        headers: {},
        id: "pino-789",
      } as unknown as express.Request;

      expect(resolveCorrelationId(req)).toBe("pino-789");
    });

    it("generates a new UUID v4 fallback when no ID is available", () => {
      const req = {
        headers: {},
      } as unknown as express.Request;

      const resolved = resolveCorrelationId(req);
      expect(resolved).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("correlationMiddleware", () => {
    it("stamps res.locals, sets X-Correlation-Id header, and sets ALS store", async () => {
      const app = express();
      let capturedContextCorrelationId: string | undefined;

      app.use(correlationMiddleware);
      app.get("/test", (req, res) => {
        capturedContextCorrelationId = getCorrelationId();
        res.json({ correlationId: res.locals.correlationId });
      });

      const res = await request(app)
        .get("/test")
        .set("x-correlation-id", "my-custom-corr-id-100");

      expect(res.status).toBe(200);
      expect(res.headers["x-correlation-id"]).toBe("my-custom-corr-id-100");
      expect(res.body.correlationId).toBe("my-custom-corr-id-100");
      expect(capturedContextCorrelationId).toBe("my-custom-corr-id-100");
    });

    it("generates a correlation ID when client provides none", async () => {
      const app = express();
      app.use(correlationMiddleware);
      app.get("/test", (_req, res) => {
        res.json({ ok: true });
      });

      const res = await request(app).get("/test");

      expect(res.status).toBe(200);
      expect(res.headers["x-correlation-id"]).toBeDefined();
      expect(res.headers["x-correlation-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("fetchWithCorrelationId", () => {
    it("injects X-Correlation-Id into outbound fetch headers when context is active", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = mockFetch;

      try {
        await requestContextStorage.run(
          { requestId: "req-1", correlationId: "corr-outbound-999" },
          async () => {
            await fetchWithCorrelationId("https://example.com/api");
          },
        );

        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get("x-correlation-id")).toBe("corr-outbound-999");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("calls fetch unchanged when no context is active", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = mockFetch;

      try {
        await fetchWithCorrelationId("https://example.com/api");
        expect(mockFetch).toHaveBeenCalledWith("https://example.com/api", undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
