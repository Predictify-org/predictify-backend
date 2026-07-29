import express from "express";
import request from "supertest";
import { correlationMiddleware, CORRELATION_ID_HEADER } from "../src/middleware/correlation";
import { commentsRouter } from "../src/routes/comments";
import { listMarketComments } from "../src/services/marketCommentsService";

jest.mock("../src/services/marketCommentsService", () => ({
  listMarketComments: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
}));

const ALLOWED_ORIGIN = "http://localhost:5173";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  app.use("/api/comments", commentsRouter);
  app.use("/api/markets", commentsRouter);
  return app;
}

describe("Comments API X-Correlation-Id Propagation", () => {
  describe("GET /api/comments", () => {
    it("returns X-Correlation-Id response header when client passes custom X-Correlation-Id", async () => {
      const customCorrId = "client-corr-id-12345";
      const res = await request(createTestApp())
        .get("/api/comments")
        .set("Origin", ALLOWED_ORIGIN)
        .set(CORRELATION_ID_HEADER, customCorrId);

      expect(res.status).toBe(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);
      expect(res.body.message).toBe("Comments fetched securely");
    });

    it("generates and returns a valid UUID v4 X-Correlation-Id header when none is provided", async () => {
      const res = await request(createTestApp())
        .get("/api/comments")
        .set("Origin", ALLOWED_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(res.headers[CORRELATION_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("sanitizes unsafe correlation IDs passed in request header", async () => {
      const unsafeCorrId = "corr-123<script>alert(1)</script>";
      const res = await request(createTestApp())
        .get("/api/comments")
        .set("Origin", ALLOWED_ORIGIN)
        .set(CORRELATION_ID_HEADER, unsafeCorrId);

      expect(res.status).toBe(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe("corr-123scriptalert1script");
    });

    it("returns 400 validation error envelope when invalid query params are provided", async () => {
      const res = await request(createTestApp())
        .get("/api/comments?limit=invalid_number")
        .set("Origin", ALLOWED_ORIGIN)
        .set(CORRELATION_ID_HEADER, "test-corr-id");

      expect(res.status).toBe(400);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe("test-corr-id");
      expect(res.body).toHaveProperty("error");
      expect(res.body.error.code).toBe("validation_error");
    });
  });

  describe("POST /api/comments", () => {
    it("creates a comment and echoes X-Correlation-Id header", async () => {
      const customCorrId = "post-comment-corr-99";
      const payload = {
        marketId: "market-100",
        body: "This is a prediction market comment",
        authorAddress: "GABC1234567890",
      };

      const res = await request(createTestApp())
        .post("/api/comments")
        .set("Origin", ALLOWED_ORIGIN)
        .set(CORRELATION_ID_HEADER, customCorrId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);
      expect(res.body.message).toBe("Comment created successfully");
      expect(res.body.data.marketId).toBe("market-100");
    });

    it("propagates X-Correlation-Id header to outbound webhook calls when outboundUrl is specified", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ received: true }), { status: 200 }));
      globalThis.fetch = mockFetch;

      const customCorrId = "outbound-propagate-test-456";

      try {
        const res = await request(createTestApp())
          .post("/api/comments")
          .set("Origin", ALLOWED_ORIGIN)
          .set(CORRELATION_ID_HEADER, customCorrId)
          .send({
            marketId: "market-outbound",
            body: "Testing outbound propagation",
            outboundUrl: "https://webhook.site/test-endpoint",
          });

        expect(res.status).toBe(201);
        expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);

        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toBe("https://webhook.site/test-endpoint");
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get("x-correlation-id")).toBe(customCorrId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles outbound call failures gracefully without crashing comment creation", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = mockFetch;

      try {
        const res = await request(createTestApp())
          .post("/api/comments")
          .set("Origin", ALLOWED_ORIGIN)
          .set(CORRELATION_ID_HEADER, "outbound-fail-corr")
          .send({
            marketId: "market-fail",
            body: "Testing outbound failure",
            outboundUrl: "https://webhook.site/failing-endpoint",
          });

        expect(res.status).toBe(201);
        expect(res.headers[CORRELATION_ID_HEADER]).toBe("outbound-fail-corr");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rejects invalid body with standardized error envelope", async () => {
      const res = await request(createTestApp())
        .post("/api/comments")
        .set("Origin", ALLOWED_ORIGIN)
        .send({ body: "" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });
  });

  describe("GET /api/markets/:id/comments", () => {
    it("echoes X-Correlation-Id header on market comments listing", async () => {
      const customCorrId = "market-comments-corr-777";
      const res = await request(createTestApp())
        .get("/api/markets/m-test/comments")
        .set("Origin", ALLOWED_ORIGIN)
        .set(CORRELATION_ID_HEADER, customCorrId);

      expect(res.status).toBe(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);
      expect(listMarketComments).toHaveBeenCalledWith("m-test", undefined, undefined);
    });

    it("returns 400 validation error envelope when query limit is invalid on market comments", async () => {
      const res = await request(createTestApp())
        .get("/api/markets/m-test/comments?limit=invalid")
        .set("Origin", ALLOWED_ORIGIN);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });
  });
});
