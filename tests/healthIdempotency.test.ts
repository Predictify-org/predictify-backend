/**
 * tests/healthIdempotency.test.ts
 *
 * Verifies POST /api/health/mutations is protected by the Idempotency-Key
 * middleware (issue #665). The global idempotency middleware in src/index.ts
 * is registered *after* /api/health, so it never runs for this route;
 * src/routes/health.ts now applies it directly on the /mutations route.
 *
 * The db mock is a small stateful in-memory map (mirrors the approach in
 * tests/authIdempotency.test.ts) so persist-then-replay round trips can be
 * exercised without a real database.
 */

import { auditLogs, idempotencyRecords } from "../src/db/schema";

const idempotencyStore = new Map<string, Record<string, unknown>>();

// src/middleware/timeout.ts's requestTimeout() aborts res.locals.abortSignal
// on the request's "close" event, which — independent of this change — can
// fire under supertest before the response is fully sent, racing
// abortableRace() in the health route handler. That's a pre-existing,
// unrelated issue (reproduces with requestTimeout + abortableRace alone, no
// idempotency involved); stub both out here so this suite stays focused on
// idempotency behavior specifically.
jest.mock("../src/middleware/timeout", () => ({
  requestTimeout: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  abortableRace: (promise: Promise<unknown>) => promise,
}));

// src/middleware/idempotency.ts reads/writes via "../db" (src/db/index.ts) —
// a separate module/instance from "../db/client", which the health route
// itself uses for its own auditLogs query below.
jest.mock("../src/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => Array.from(idempotencyStore.values()),
        }),
      }),
    }),
    insert: () => ({
      values: async (record: Record<string, unknown>) => {
        idempotencyStore.set(record.key as string, record);
      },
    }),
  },
}));

jest.mock("../src/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [
              { afterState: { mode: "active", maintenance: false } },
            ],
          }),
        }),
      }),
    }),
  },
  pool: { query: jest.fn() },
}));

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("mock-correlation-id"),
}));

import express from "express";
import request from "supertest";
import { healthRouter } from "../src/routes/health";
import { errorHandler } from "../src/middleware/errorHandler";
import { createAuditLog } from "../src/services/auditService";

const mockCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/health", healthRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;

beforeEach(() => {
  jest.clearAllMocks();
  idempotencyStore.clear();
  app = makeApp();
});

describe("Idempotency for POST /api/health/mutations", () => {
  it("replays the stored response for a repeated Idempotency-Key + body", async () => {
    const key = "health-mutation-key-1";
    const body = { mode: "maintenance", maintenance: true };

    const first = await request(app)
      .post("/api/health/mutations")
      .set("Idempotency-Key", key)
      .send(body);

    expect(first.status).toBe(200);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(first.body.status).toBe("updated");
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post("/api/health/mutations")
      .set("Idempotency-Key", key)
      .send(body);

    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    // The route handler (and its audit log write) must not run a second time.
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the same Idempotency-Key is reused with a different body", async () => {
    const key = "health-mutation-key-2";

    await request(app)
      .post("/api/health/mutations")
      .set("Idempotency-Key", key)
      .send({ mode: "maintenance", maintenance: true })
      .expect(200);

    const conflict = await request(app)
      .post("/api/health/mutations")
      .set("Idempotency-Key", key)
      .send({ mode: "active", maintenance: false })
      .expect(409);

    expect(conflict.body.error.code).toBe("conflict");
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a malformed Idempotency-Key", async () => {
    const res = await request(app)
      .post("/api/health/mutations")
      .set("Idempotency-Key", "a".repeat(256))
      .send({ mode: "maintenance", maintenance: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_idempotency_key");
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("processes every request independently when no Idempotency-Key is sent", async () => {
    await request(app)
      .post("/api/health/mutations")
      .send({ mode: "maintenance", maintenance: true })
      .expect(200);

    await request(app)
      .post("/api/health/mutations")
      .send({ mode: "maintenance", maintenance: true })
      .expect(200);

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(2);
  });
});

// Sanity check that the schema imports used to build the mock actually exist.
describe("schema sanity", () => {
  it("idempotencyRecords and auditLogs are distinct table objects", () => {
    expect(idempotencyRecords).not.toBe(auditLogs);
  });
});
