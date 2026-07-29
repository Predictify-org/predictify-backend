/**
 * Tests for the admin plugin CRUD routes.
 *
 *   GET    /api/admin/plugins
 *   POST   /api/admin/plugins
 *   GET    /api/admin/plugins/:id
 *   PATCH  /api/admin/plugins/:id
 *   DELETE /api/admin/plugins/:id
 *
 * Strategy:
 *  - Use a FakePluginRepository so no real DB is needed.
 *  - Sign real JWTs (with role:"admin") to exercise the full requireAdmin path.
 *  - Mount `createAdminPluginsRouter()` directly on a minimal express app so
 *    the rate-limit ceiling can be lowered for the 429 test.
 */

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createAdminPluginsRouter } from "../src/routes/admin/plugins";
import { errorHandler } from "../src/middleware/errorHandler";
import type {
  PluginRepository,
  PluginListResult,
  CreatePluginInput,
  UpdatePluginInput,
} from "../src/services/pluginService";
import { PluginNotFoundError } from "../src/services/pluginService";
import type { Plugin } from "../src/db/schema";

// ── JWT fixtures ─────────────────────────────────────────────────────────────
const SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDR =
  "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR =
  "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

const adminJwt = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDR, role: "user" });

// ── DB mock (prevents Pool connection at import time) ───────────────────────
jest.mock("../src/db/client", () => ({ db: {} }));

// ── Fake repository ─────────────────────────────────────────────────────────

class FakePluginRepo implements PluginRepository {
  plugins: Plugin[] = [];
  private nextId = 1;

  private makePlugin(input: CreatePluginInput): Plugin {
    const now = new Date();
    const id = `00000000-0000-0000-0000-${String(this.nextId++).padStart(12, "0")}`;
    return {
      id,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async list(filters: {
    enabled?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PluginListResult> {
    let filtered = [...this.plugins];
    if (filters.enabled !== undefined) {
      filtered = filtered.filter((p) => p.enabled === filters.enabled);
    }
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const page = filtered.slice(offset, offset + limit);
    return {
      data: page.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        enabled: p.enabled,
        config: p.config,
        createdAt:
          p.createdAt instanceof Date
            ? p.createdAt.toISOString()
            : String(p.createdAt),
        updatedAt:
          p.updatedAt instanceof Date
            ? p.updatedAt.toISOString()
            : String(p.updatedAt),
      })),
      total: filtered.length,
      limit,
      offset,
    };
  }

  async getById(id: string): Promise<Plugin | null> {
    return this.plugins.find((p) => p.id === id) ?? null;
  }

  async create(input: CreatePluginInput): Promise<Plugin> {
    // Simulate DB unique constraint on name
    if (this.plugins.some((p) => p.name === input.name)) {
      const err = new Error(
        'duplicate key value violates unique constraint "plugins_name_unique"',
      ) as Error & { code: string };
      err.code = "23505";
      throw err;
    }
    const plugin = this.makePlugin(input);
    this.plugins.push(plugin);
    return plugin;
  }

  async update(id: string, input: UpdatePluginInput): Promise<Plugin> {
    const idx = this.plugins.findIndex((p) => p.id === id);
    if (idx === -1) throw new PluginNotFoundError(id);
    // Simulate DB unique constraint on name
    if (
      input.name !== undefined &&
      this.plugins.some((p) => p.id !== id && p.name === input.name)
    ) {
      const err = new Error(
        'duplicate key value violates unique constraint "plugins_name_unique"',
      ) as Error & { code: string };
      err.code = "23505";
      throw err;
    }
    const now = new Date();
    const p = this.plugins[idx]!;
    if (input.name !== undefined) p.name = input.name;
    if (input.description !== undefined) p.description = input.description;
    if (input.enabled !== undefined) p.enabled = input.enabled;
    if (input.config !== undefined) p.config = input.config;
    p.updatedAt = now;
    return p;
  }

  async delete(id: string): Promise<string | null> {
    const idx = this.plugins.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const name = this.plugins[idx]!.name;
    this.plugins.splice(idx, 1);
    return name;
  }
}

// ── App factory ─────────────────────────────────────────────────────────────

function makeApp(rateLimitPerMinute = 600): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as express.Request & { id?: string }
    ).id =
      (req.headers["x-request-id"] as string | undefined) ?? "admin-plugins-req";
    next();
  });
  app.use(
    "/api/admin/plugins",
    createAdminPluginsRouter({
      repo: new FakePluginRepo(),
      rateLimitPerMinute,
    }),
  );
  app.use(errorHandler);
  return app;
}

function makeAppWithRepo(
  repo: PluginRepository,
  rateLimitPerMinute = 600,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as express.Request & { id?: string }
    ).id =
      (req.headers["x-request-id"] as string | undefined) ?? "admin-plugins-req";
    next();
  });
  app.use(
    "/api/admin/plugins",
    createAdminPluginsRouter({ repo, rateLimitPerMinute }),
  );
  app.use(errorHandler);
  return app;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
});

// ── Auth guard ──────────────────────────────────────────────────────────────

describe("requireAdmin guard", () => {
  it("GET / returns 403 without an Authorization header", async () => {
    const res = await request(makeApp()).get("/api/admin/plugins");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("POST / returns 403 without an Authorization header", async () => {
    const res = await request(makeApp()).post("/api/admin/plugins").send({});
    expect(res.status).toBe(403);
  });

  it("PATCH / returns 403 without an Authorization header", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/plugins/some-id")
      .send({});
    expect(res.status).toBe(403);
  });

  it("DELETE / returns 403 without an Authorization header", async () => {
    const res = await request(makeApp()).delete("/api/admin/plugins/some-id");
    expect(res.status).toBe(403);
  });

  it("returns 403 with a non-admin JWT", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with a JWT signed by a different secret", async () => {
    const forged = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      "not-the-real-secret-but-32-chars-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(makeApp())
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with an expired JWT", async () => {
    const expired = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      SECRET,
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: -1 },
    );
    const res = await request(makeApp())
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(403);
  });
});

// ── GET / ── list plugins ──────────────────────────────────────────────────

describe("GET /api/admin/plugins — list plugins", () => {
  it("returns empty list when no plugins exist", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0 });
  });

  it("returns all plugins", async () => {
    const app = makeApp();
    // Create plugins via POST
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "plugin-a" });
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "plugin-b", enabled: false });

    const res = await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.data[0].name).toBe("plugin-a");
    expect(res.body.data[1].name).toBe("plugin-b");
  });

  it("filters by enabled=true", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "enabled-plugin", enabled: true });
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "disabled-plugin", enabled: false });

    const res = await request(app)
      .get("/api/admin/plugins?enabled=true")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("enabled-plugin");
  });

  it("filters by enabled=false", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "enabled-plugin", enabled: true });
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "disabled-plugin", enabled: false });

    const res = await request(app)
      .get("/api/admin/plugins?enabled=false")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("disabled-plugin");
  });

  it("supports limit and offset", async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/admin/plugins")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ name: `plugin-${i}` });
    }

    const res = await request(app)
      .get("/api/admin/plugins?limit=2&offset=1")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  it("rejects invalid enabled value", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins?enabled=maybe")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects non-numeric limit", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins?limit=abc")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(400);
  });

  it("rejects limit out of range", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins?limit=9999")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ── POST / ── create plugin ────────────────────────────────────────────────

describe("POST /api/admin/plugins — create plugin", () => {
  it("creates a plugin and returns 201", async () => {
    const res = await request(makeApp())
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "my-plugin", description: "my desc", config: { key: "val" } });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("my-plugin");
    expect(res.body.data.description).toBe("my desc");
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.config).toEqual({ key: "val" });
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.createdAt).toBeDefined();
  });

  it("defaults enabled to true and config to {}", async () => {
    const res = await request(makeApp())
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "minimal" });

    expect(res.status).toBe(201);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.config).toEqual({});
    expect(res.body.data.description).toBeNull();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(makeApp())
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when name is empty after trim", async () => {
    const res = await request(makeApp())
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "   " });

    expect(res.status).toBe(400);
  });

  it("returns 409 when name already exists", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "unique" });

    const res = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "unique" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("name_conflict");
  });

  it("returns 201 with only the name field (extra keys ignored)", async () => {
    const res = await request(makeApp())
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "ok" });

    expect(res.status).toBe(201);
  });
});

// ── GET /:id ── get plugin by ID ──────────────────────────────────────────

describe("GET /api/admin/plugins/:id — get plugin by ID", () => {
  it("returns a plugin by ID", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "read-me" });
    const id = create.body.data.id;

    const res = await request(app)
      .get(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.name).toBe("read-me");
  });

  it("returns 404 for a non-existent plugin", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for an invalid UUID", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins/not-a-uuid")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ── PATCH /:id ── update plugin ───────────────────────────────────────────

describe("PATCH /api/admin/plugins/:id — update plugin", () => {
  it("updates a plugin name", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "old-name" });
    const id = create.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "new-name" });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("new-name");
  });

  it("updates enabled status", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "toggle-me" });
    const id = create.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it("updates config", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "config-me" });
    const id = create.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ config: { newKey: "newVal" } });

    expect(res.status).toBe(200);
    expect(res.body.data.config).toEqual({ newKey: "newVal" });
  });

  it("clears description when set to null", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "clear-me", description: "was here" });
    const id = create.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ description: null });

    expect(res.status).toBe(200);
    expect(res.body.data.description).toBeNull();
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/plugins/00000000-0000-0000-0000-000000000001")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toMatch(/at least one field/);
  });

  it("returns 404 for a non-existent plugin", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/plugins/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for an invalid UUID", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/plugins/not-a-uuid")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "nope" });

    expect(res.status).toBe(400);
  });
});

// ── DELETE /:id ── delete plugin ──────────────────────────────────────────

describe("DELETE /api/admin/plugins/:id — delete plugin", () => {
  it("deletes a plugin and returns its id and name", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "delete-me" });
    const id = create.body.data.id;

    const res = await request(app)
      .delete(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.name).toBe("delete-me");
  });

  it("returns 404 when deleting a non-existent plugin", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/plugins/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for an invalid UUID", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/plugins/not-a-uuid")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(400);
  });

  it("plugin is gone after deletion", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "gone-soon" });
    const id = create.body.data.id;

    await request(app)
      .delete(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    const get = await request(app)
      .get(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(get.status).toBe(404);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 after the per-token ceiling is exceeded", async () => {
    const app = makeAppWithRepo(new FakePluginRepo(), 2);

    await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);
    await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);

    const third = await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });

  it("isolates buckets per admin token", async () => {
    const otherAdminJwt = signJwt({
      sub: "GOTHERADMINADMINADMINADMINADMINADMINADMINADMINADMINADMIN",
      role: "admin",
    });

    const app = makeAppWithRepo(new FakePluginRepo(), 1);
    const a = await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);
    const b = await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${otherAdminJwt}`);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

// ── Response surface ───────────────────────────────────────────────────────

describe("response surface", () => {
  it("exposes standard rate-limit headers on successful responses", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });

  it("returns the documented error envelope on validation failure", async () => {
    const res = await request(makeApp())
      .get("/api/admin/plugins?enabled=invalid")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("X-Request-Id", "shape-test");

    expect(res.body).toMatchObject({
      error: {
        code: "validation_error",
        details: expect.any(Array),
        requestId: "shape-test",
      },
    });
  });
});

// ── Full CRUD lifecycle ────────────────────────────────────────────────────

describe("full CRUD lifecycle", () => {
  it("create → read → update → delete works end-to-end", async () => {
    const app = makeApp();

    // Create
    const create = await request(app)
      .post("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({
        name: "lifecycle-plugin",
        description: "testing lifecycle",
        config: { version: 1 },
      });
    expect(create.status).toBe(201);
    const id = create.body.data.id;

    // Read
    const read = await request(app)
      .get(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(read.status).toBe(200);
    expect(read.body.data.name).toBe("lifecycle-plugin");

    // Update
    const update = await request(app)
      .patch(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "updated-lifecycle" });
    expect(update.status).toBe(200);
    expect(update.body.data.name).toBe("updated-lifecycle");

    // List verification
    const list = await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe("updated-lifecycle");

    // Delete
    const del = await request(app)
      .delete(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(del.status).toBe(200);

    // Verify gone
    const gone = await request(app)
      .get(`/api/admin/plugins/${id}`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(gone.status).toBe(404);
  });
});

// ── Error propagation ─────────────────────────────────────────────────────

describe("error propagation", () => {
  it("unexpected errors bubble to global handler (500)", async () => {
    // Use a repo that throws unexpectedly
    const brokenRepo: PluginRepository = {
      list: async () => {
        throw new Error("db down");
      },
      getById: async () => null,
      create: async () => ({} as Plugin),
      update: async () => {
        throw new PluginNotFoundError("x");
      },
      delete: async () => null,
    };

    const app = makeAppWithRepo(brokenRepo);
    const res = await request(app)
      .get("/api/admin/plugins")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
  });
});
