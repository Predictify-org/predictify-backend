import { startAuditSpan, endAuditSpan, recordErrorOnSpan } from "../../src/otel/spans";
import { SpanStatusCode, SpanKind } from "@opentelemetry/api";

jest.mock("../../src/otel/tracer", () => ({
  getTracer: jest.fn(),
}));

jest.mock("../../src/lib/requestContext", () => ({
  getRequestId: jest.fn(() => "ctx-request-id"),
}));

import { getTracer } from "../../src/otel/tracer";
import { getRequestId } from "../../src/lib/requestContext";

function createMockSpan() {
  return {
    setAttribute: jest.fn(),
    setStatus: jest.fn(),
    end: jest.fn(),
    recordException: jest.fn(),
  };
}

function createMockReq(overrides = {}) {
  return {
    method: "GET",
    path: "/api/admin/audit",
    ...overrides,
  } as any;
}

function createMockRes(overrides = {}) {
  return {
    statusCode: 200,
    locals: {},
    ...overrides,
  } as any;
}

describe("otel/spans", () => {
  let mockSpan: ReturnType<typeof createMockSpan>;
  let mockTracer: { startSpan: jest.Mock };

  beforeEach(() => {
    mockSpan = createMockSpan();
    mockTracer = { startSpan: jest.fn(() => mockSpan) };
    (getTracer as jest.Mock).mockReturnValue(mockTracer);
    (getRequestId as jest.Mock).mockReturnValue("ctx-request-id");
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("startAuditSpan", () => {
    it("starts a span with the given name and SERVER kind", () => {
      const req = createMockReq();
      const res = createMockRes();

      const span = startAuditSpan("audit.market.list", req, res);

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        "audit.market.list",
        expect.objectContaining({ kind: SpanKind.SERVER }),
      );
      expect(span).toBe(mockSpan);
    });

    it("sets http.method and http.path attributes from the request", () => {
      const req = createMockReq({ method: "POST", path: "/api/admin/audit/search" });
      const res = createMockRes();

      startAuditSpan("audit.admin.search", req, res);

      const [, options] = mockTracer.startSpan.mock.calls[0];
      expect(options.attributes["http.method"]).toBe("POST");
      expect(options.attributes["http.path"]).toBe("/api/admin/audit/search");
    });

    it("uses correlationId from res.locals when present", () => {
      const req = createMockReq();
      const res = createMockRes({ locals: { correlationId: "corr-123" } });

      startAuditSpan("audit.market.list", req, res);

      const [, options] = mockTracer.startSpan.mock.calls[0];
      expect(options.attributes["correlation.id"]).toBe("corr-123");
    });

    it("falls back to getRequestId() when res.locals.correlationId is missing", () => {
      const req = createMockReq();
      const res = createMockRes({ locals: {} });

      startAuditSpan("audit.market.list", req, res);

      const [, options] = mockTracer.startSpan.mock.calls[0];
      expect(options.attributes["correlation.id"]).toBe("ctx-request-id");
    });

    it("falls back to unknown when neither correlationId source is available", () => {
      (getRequestId as jest.Mock).mockReturnValue(undefined);
      const req = createMockReq();
      const res = createMockRes({ locals: {} });

      startAuditSpan("audit.market.list", req, res);

      const [, options] = mockTracer.startSpan.mock.calls[0];
      expect(options.attributes["correlation.id"]).toBe("unknown");
    });

    it("merges extraAttrs into the span attributes", () => {
      const req = createMockReq();
      const res = createMockRes();

      startAuditSpan("audit.market.get", req, res, { marketId: "m-1" });

      const [, options] = mockTracer.startSpan.mock.calls[0];
      expect(options.attributes.marketId).toBe("m-1");
    });
  });

  describe("endAuditSpan", () => {
    it("sets http.status_code and OK status for a successful response", () => {
      const res = createMockRes({ statusCode: 200 });

      endAuditSpan(mockSpan as any, res);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("http.status_code", 200);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    });

    it("sets ERROR status for a 4xx/5xx response", () => {
      const res = createMockRes({ statusCode: 404 });

      endAuditSpan(mockSpan as any, res);

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "HTTP 404",
      });
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("recordErrorOnSpan", () => {
    it("records an Error instance directly", () => {
      const err = new Error("boom");

      recordErrorOnSpan(mockSpan as any, err);

      expect(mockSpan.recordException).toHaveBeenCalledWith(err);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "boom",
      });
    });

    it("wraps a non-Error value in an Error before recording", () => {
      recordErrorOnSpan(mockSpan as any, "string failure");

      expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "string failure",
      });
    });

    it("does not call span.end()", () => {
      recordErrorOnSpan(mockSpan as any, new Error("x"));
      expect(mockSpan.end).not.toHaveBeenCalled();
    });
  });
});
