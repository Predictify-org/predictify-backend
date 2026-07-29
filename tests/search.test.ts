/**
 * tests/search.test.ts
 *
 * Tests for /api/search routes including:
 *   - GET  /api/search         — read-only search (existing)
 *   - POST /api/search         — save a search query (mutation, idempotent)
 *   - PATCH /api/search/:id    — update a saved search (mutation, idempotent)
 */

import express from "express";
import request from "supertest";
import { searchRouter } from "../src/routes/search";
import { requestContextStorage } from "../src/lib/requestContext";

// Mock the idempotency middleware — the real one requires a database connection.
// We provide a simplified version that validates the key format and passes through.
jest.mock("../src/middleware/idempotency", () => ({
  idempotency: (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = req.headers["idempotency-key"];
    if (key && typeof key === "string" && (key.length > 255 || !/^[\x20-\x7E]+$/.test(key))) {
      res.status(400).json({
        error: { code: "invalid_idempotency_key", message: "Invalid idempotency key format" },
      });
      return;
    }
    next();
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      requestContextStorage.run({ requestId: "test-req-id" }, next);
    },
  );
  app.use("/api/search", searchRouter);
  return app;
}

describe("GET /api/search", () => {
  it("returns search results with default parameters", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "test query" });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.meta.query).toBe("test query");
  });

  it("accepts limit and page parameters", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "test", limit: "25", page: "2" });

    expect(response.status).toBe(200);
    expect(response.body.data.meta.limit).toBe(25);
    expect(response.body.data.meta.page).toBe(2);
  });

  it("rejects empty search query", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects query that is too long", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "a".repeat(201) });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects control characters in query", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "test\x00query" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects limit exceeding 100", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "test", limit: "101" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects limit below 1", async () => {
    const response = await request(makeApp())
      .get("/api/search")
      .query({ q: "test", limit: "0" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });
});

describe("POST /api/search (mutation)", () => {
  it("saves a search query with valid body", async () => {
    const response = await request(makeApp())
      .post("/api/search")
      .send({ query: "prediction markets" })
      .set("idempotency-key", "test-key-1");

    expect(response.status).toBe(201);
    expect(response.body.data.query).toBe("prediction markets");
    expect(response.body.data.id).toBeDefined();
    expect(response.body.data.createdAt).toBeDefined();
  });

  it("saves a search query with optional label", async () => {
    const response = await request(makeApp())
      .post("/api/search")
      .send({ query: "stellar development", label: "Dev Search" })
      .set("idempotency-key", "test-key-2");

    expect(response.status).toBe(201);
    expect(response.body.data.query).toBe("stellar development");
    expect(response.body.data.label).toBe("Dev Search");
  });

  it("rejects empty query", async () => {
    const response = await request(makeApp())
      .post("/api/search")
      .send({ query: "" })
      .set("idempotency-key", "test-key-3");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects query with control characters", async () => {
    const response = await request(makeApp())
      .post("/api/search")
      .send({ query: "test\x01query" })
      .set("idempotency-key", "test-key-4");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects query exceeding max length", async () => {
    const response = await request(makeApp())
      .post("/api/search")
      .send({ query: "a".repeat(201) })
      .set("idempotency-key", "test-key-5");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects invalid idempotency-key format", async () => {
    const response = await request(makeApp())
      .post("/api/search")
      .send({ query: "test" })
      .set("idempotency-key", "a".repeat(256));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_idempotency_key");
  });
});

describe("PATCH /api/search/:id (mutation)", () => {
  it("updates a saved search label", async () => {
    const response = await request(makeApp())
      .patch("/api/search/search-123")
      .send({ label: "Updated Label" })
      .set("idempotency-key", "test-key-patch-1");

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe("search-123");
    expect(response.body.data.label).toBe("Updated Label");
    expect(response.body.data.updatedAt).toBeDefined();
  });

  it("rejects empty label", async () => {
    const response = await request(makeApp())
      .patch("/api/search/search-123")
      .send({ label: "" })
      .set("idempotency-key", "test-key-patch-2");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects label exceeding max length", async () => {
    const response = await request(makeApp())
      .patch("/api/search/search-123")
      .send({ label: "a".repeat(101) })
      .set("idempotency-key", "test-key-patch-3");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("rejects missing body", async () => {
    const response = await request(makeApp())
      .patch("/api/search/search-123")
      .send({})
      .set("idempotency-key", "test-key-patch-4");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });
});
