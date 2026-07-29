import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminFreezeRouter } from "../src/routes/admin/users/freeze";
import { resetUserFreezeForTests, isUserFrozen } from "../src/services/userFreezeService";
import { errorHandler } from "../src/middleware/errorHandler";

// Prevent a real DB connection at import time.
jest.mock("../src/db/client", () => ({ db: {} }));

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-at-least-32-chars!!";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
// A syntactically valid Stellar public key (G + 55 base32 chars).
const TARGET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: ADMIN_ADDRESS, role: "user" });

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/users", createAdminFreezeRouter());
  app.use(errorHandler);
  return app;
}

beforeEach(() => resetUserFreezeForTests());

describe("admin user freeze", () => {
  it("rejects non-admin callers with 403", async () => {
    const res = await request(makeApp())
      .post(`/api/admin/users/${TARGET}/freeze`)
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("freezes, reports status, and unfreezes a user", async () => {
    const app = makeApp();

    const frozen = await request(app)
      .post(`/api/admin/users/${TARGET}/freeze`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ reason: "suspicious activity" });
    expect(frozen.status).toBe(200);
    expect(frozen.body.data).toMatchObject({ frozen: true, reason: "suspicious activity" });
    expect(isUserFrozen(TARGET)).toBe(true);

    const status = await request(app)
      .get(`/api/admin/users/${TARGET}/freeze`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(status.status).toBe(200);
    expect(status.body.data.frozen).toBe(true);

    const unfrozen = await request(app)
      .delete(`/api/admin/users/${TARGET}/freeze`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(unfrozen.status).toBe(200);
    expect(unfrozen.body.data.frozen).toBe(false);
    expect(isUserFrozen(TARGET)).toBe(false);
  });

  it("rejects an invalid stellar address with 400", async () => {
    const res = await request(makeApp())
      .post("/api/admin/users/not-an-address/freeze")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});
