import request from "supertest";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { v4 as uuidv4 } from "uuid";
import { closeDb, pool } from "../../src/db/client";
import { closeAuthPool } from "../../src/middleware/requireAuth";
import { signAccessToken } from "../../src/services/jwtService";
import { requestContextStorage } from "../../src/lib/requestContext";
import { authRouter } from "../../src/routes/auth";
import { errorHandler } from "../../src/middleware/errorHandler";
import { hashToken, issueRefreshToken } from "../../src/services/refreshTokenService";
import { eq } from "drizzle-orm";
import { refreshTokens, users } from "../../src/db/schema";

jest.mock("../../src/middleware/rateLimit", () => ({
  createPerUserRateLimiter: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock("../../src/middleware/loginRateLimit", () => ({
  loginRateLimit: jest.fn((_: any, _res: any, next: any) => next()),
}));

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const INVALID_ADDRESS = "invalid-address";
const WHITESPACE_ADDRESS = "   ";

function createAuthApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const requestId = uuidv4();
    requestContextStorage.run({ requestId }, next);
  });
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  return app;
}

function signNonce(keypair: Keypair, nonce: string): string {
  return keypair.sign(Buffer.from(nonce, "utf8")).toString("base64");
}

async function seedRefreshToken(userId: string, stellarAddress: string): Promise<string> {
  const { token } = await issueRefreshToken(userId);
  return token;
}

describe("Integration Test: /api/auth end-to-end", () => {
  let app: express.Express;

  beforeAll(() => {
    app = createAuthApp();
  });

  afterAll(async () => {
    await closeAuthPool();
    await closeDb();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE auth_challenges, refresh_tokens, users RESTART IDENTITY CASCADE");
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/auth/challenge
  // ───────────────────────────────────────────────────────────────────────

  describe("POST /api/auth/challenge", () => {
    describe("validation errors (422)", () => {
      it("returns 422 if stellarAddress is missing", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({})
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
        expect(response.body.error.fields.stellarAddress).toContain("Stellar address is required");
        expect(response.headers).toHaveProperty("x-correlation-id");
      });

      it("returns 422 if stellarAddress is null", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: null })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
      });

      it("returns 422 if stellarAddress is not a string", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: 12345 })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
      });

      it("returns 422 if stellarAddress is invalid Stellar address", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: INVALID_ADDRESS })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
        expect(response.body.error.fields.stellarAddress[0]).toContain("Invalid Stellar");
      });

      it("returns 422 if stellarAddress is only whitespace", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: WHITESPACE_ADDRESS })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
      });

      it("returns 422 if extra unknown fields are provided", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: VALID_ADDRESS, extraField: "should-fail" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
      });
    });

    describe("success (201)", () => {
      it("returns 201 with nonce if stellarAddress is valid", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: VALID_ADDRESS })
          .expect(201);

        expect(response.body).toHaveProperty("nonce");
        expect(response.body).toHaveProperty("expiresAt");
        expect(response.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(response.headers).toHaveProperty("x-correlation-id");

        const dbRows = await pool.query(
          "SELECT * FROM auth_challenges WHERE stellar_address = $1",
          [VALID_ADDRESS],
        );
        expect(dbRows.rows).toHaveLength(1);
        expect(dbRows.rows[0].nonce).toBe(response.body.nonce);
      });

      it("trims whitespace from stellarAddress", async () => {
        const response = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: `  ${VALID_ADDRESS}  ` })
          .expect(201);

        expect(response.body).toHaveProperty("nonce");
        expect(response.headers).toHaveProperty("x-correlation-id");

        const dbRows = await pool.query(
          "SELECT * FROM auth_challenges WHERE stellar_address = $1",
          [VALID_ADDRESS],
        );
        expect(dbRows.rows).toHaveLength(1);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/auth/verify
  // ───────────────────────────────────────────────────────────────────────

  describe("POST /api/auth/verify", () => {
    describe("validation errors (422)", () => {
      it("returns 422 if stellarAddress is missing", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            nonce: "test-nonce",
            signature: "test-signature",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
      });

      it("returns 422 if nonce is missing", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: VALID_ADDRESS,
            signature: "test-signature",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.nonce");
      });

      it("returns 422 if signature is missing", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: VALID_ADDRESS,
            nonce: "test-nonce",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.signature");
      });

      it("returns 422 if stellarAddress is invalid", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: INVALID_ADDRESS,
            nonce: "test-nonce",
            signature: "test-signature",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.stellarAddress");
      });

      it("returns 422 if nonce is empty string", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: VALID_ADDRESS,
            nonce: "",
            signature: "test-signature",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.nonce");
        expect(response.body.error.fields.nonce[0]).toContain("non-empty");
      });

      it("returns 422 if signature is empty string", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: VALID_ADDRESS,
            nonce: "test-nonce",
            signature: "",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.signature");
        expect(response.body.error.fields.signature[0]).toContain("non-empty");
      });

      it("returns 422 if extra unknown fields are provided", async () => {
        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: VALID_ADDRESS,
            nonce: "test-nonce",
            signature: "test-signature",
            extraField: "should-fail",
          })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
      });
    });

    describe("success (200)", () => {
      it("returns 200 with tokens for valid request and creates user in DB", async () => {
        const keypair = Keypair.random();
        const address = keypair.publicKey();

        const challengeRes = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: address })
          .expect(201);

        const { nonce } = challengeRes.body;
        const signature = signNonce(keypair, nonce);

        const verifyRes = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: address,
            nonce,
            signature,
          })
          .expect(200);

        expect(verifyRes.body).toHaveProperty("accessToken");
        expect(verifyRes.body).toHaveProperty("expiresIn");
        expect(verifyRes.headers).toHaveProperty("x-correlation-id");

        const dbRows = await pool.query(
          "SELECT * FROM users WHERE stellar_address = $1",
          [address],
        );
        expect(dbRows.rows).toHaveLength(1);
      });

      it("returns 401 for invalid signature", async () => {
        const keypair = Keypair.random();
        const address = keypair.publicKey();

        const challengeRes = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: address })
          .expect(201);

        const { nonce } = challengeRes.body;
        const wrongKeypair = Keypair.random();
        const badSignature = signNonce(wrongKeypair, nonce);

        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: address,
            nonce,
            signature: badSignature,
          })
          .expect(401);

        expect(response.body.error).toHaveProperty("code", "unauthorized");
      });

      it("returns 401 for reused nonce", async () => {
        const keypair = Keypair.random();
        const address = keypair.publicKey();

        const challengeRes = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: address })
          .expect(201);

        const { nonce } = challengeRes.body;
        const signature = signNonce(keypair, nonce);

        await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: address,
            nonce,
            signature,
          })
          .expect(200);

        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: address,
            nonce,
            signature,
          })
          .expect(401);

        expect(response.body.error).toHaveProperty("code", "unauthorized");
      });

      it("trims whitespace from all string fields", async () => {
        const keypair = Keypair.random();
        const address = keypair.publicKey();

        const challengeRes = await request(app)
          .post("/api/auth/challenge")
          .send({ stellarAddress: `  ${address}  ` })
          .expect(201);

        const { nonce } = challengeRes.body;
        const signature = signNonce(keypair, nonce);

        const response = await request(app)
          .post("/api/auth/verify")
          .send({
            stellarAddress: `  ${address}  `,
            nonce: `  ${nonce}  `,
            signature: `  ${signature}  `,
          })
          .expect(200);

        expect(response.body).toHaveProperty("accessToken");
        expect(response.headers).toHaveProperty("x-correlation-id");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/auth/refresh
  // ───────────────────────────────────────────────────────────────────────

  describe("POST /api/auth/refresh", () => {
    describe("validation errors (422)", () => {
      it("returns 422 if refreshToken is missing", async () => {
        const response = await request(app)
          .post("/api/auth/refresh")
          .send({})
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
        expect(response.body.error.fields.refreshToken).toContain("refreshToken is required");
      });

      it("returns 422 if refreshToken is null", async () => {
        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: null })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is not a string", async () => {
        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: 12345 })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is empty string", async () => {
        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: "" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is only whitespace", async () => {
        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: "   " })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if extra unknown fields are provided", async () => {
        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: "valid-token", extraField: "should-fail" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
      });
    });

    describe("success (200)", () => {
      it("returns 200 with new tokens if refreshToken is valid", async () => {
        const userRes = await pool.query(
          "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
          [VALID_ADDRESS],
        );
        const userId = userRes.rows[0].id;
        const rawToken = await seedRefreshToken(userId, VALID_ADDRESS);

        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: rawToken })
          .expect(200);

        expect(response.body).toHaveProperty("accessToken");
        expect(response.body).toHaveProperty("refreshToken");
        expect(response.headers).toHaveProperty("x-correlation-id");
      });

      it("trims whitespace from refreshToken", async () => {
        const userRes = await pool.query(
          "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
          [VALID_ADDRESS],
        );
        const userId = userRes.rows[0].id;
        const rawToken = await seedRefreshToken(userId, VALID_ADDRESS);

        const response = await request(app)
          .post("/api/auth/refresh")
          .send({ refreshToken: `  ${rawToken}  ` })
          .expect(200);

        expect(response.body).toHaveProperty("accessToken");
        expect(response.headers).toHaveProperty("x-correlation-id");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/auth/logout
  // ───────────────────────────────────────────────────────────────────────

  describe("POST /api/auth/logout", () => {
    describe("validation errors (422)", () => {
      it("returns 422 if refreshToken is missing", async () => {
        const response = await request(app)
          .post("/api/auth/logout")
          .send({})
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is empty string", async () => {
        const response = await request(app)
          .post("/api/auth/logout")
          .send({ refreshToken: "" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is not a string", async () => {
        const response = await request(app)
          .post("/api/auth/logout")
          .send({ refreshToken: 12345 })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if extra unknown fields are provided", async () => {
        const response = await request(app)
          .post("/api/auth/logout")
          .send({ refreshToken: "valid-token", extraField: "should-fail" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
      });
    });

    describe("success (204)", () => {
      it("returns 204 No Content if refreshToken is valid", async () => {
        const userRes = await pool.query(
          "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
          [VALID_ADDRESS],
        );
        const userId = userRes.rows[0].id;
        const rawToken = await seedRefreshToken(userId, VALID_ADDRESS);

        await request(app)
          .post("/api/auth/logout")
          .send({ refreshToken: rawToken })
          .expect(204);

        const tokenRows = await pool.query(
          "SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1",
          [hashToken(rawToken)],
        );
        expect(tokenRows.rows[0].revoked_at).not.toBeNull();
      });

      it("returns 204 even with whitespace-padded token", async () => {
        const userRes = await pool.query(
          "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
          [VALID_ADDRESS],
        );
        const userId = userRes.rows[0].id;
        const rawToken = await seedRefreshToken(userId, VALID_ADDRESS);

        await request(app)
          .post("/api/auth/logout")
          .send({ refreshToken: `  ${rawToken}  ` })
          .expect(204);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/auth/wallet/logout
  // ───────────────────────────────────────────────────────────────────────

  describe("POST /api/auth/wallet/logout", () => {
    describe("validation errors (422)", () => {
      it("returns 422 if refreshToken is missing", async () => {
        const response = await request(app)
          .post("/api/auth/wallet/logout")
          .send({})
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is empty string", async () => {
        const response = await request(app)
          .post("/api/auth/wallet/logout")
          .send({ refreshToken: "" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if refreshToken is not a string", async () => {
        const response = await request(app)
          .post("/api/auth/wallet/logout")
          .send({ refreshToken: 12345 })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
        expect(response.body.error).toHaveProperty("fields.refreshToken");
      });

      it("returns 422 if extra unknown fields are provided", async () => {
        const response = await request(app)
          .post("/api/auth/wallet/logout")
          .send({ refreshToken: "valid-token", extraField: "should-fail" })
          .expect(422);

        expect(response.body.error).toHaveProperty("code", "validation_error");
      });
    });

    describe("success (204)", () => {
      it("returns 204 No Content if refreshToken is valid", async () => {
        const userRes = await pool.query(
          "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
          [VALID_ADDRESS],
        );
        const userId = userRes.rows[0].id;
        const rawToken = await seedRefreshToken(userId, VALID_ADDRESS);

        await request(app)
          .post("/api/auth/wallet/logout")
          .send({ refreshToken: rawToken })
          .expect(204);

        const tokenRows = await pool.query(
          "SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1",
          [hashToken(rawToken)],
        );
        expect(tokenRows.rows[0].revoked_at).not.toBeNull();
      });

      it("returns 204 even with whitespace-padded token", async () => {
        const userRes = await pool.query(
          "INSERT INTO users (stellar_address) VALUES ($1) RETURNING id",
          [VALID_ADDRESS],
        );
        const userId = userRes.rows[0].id;
        const rawToken = await seedRefreshToken(userId, VALID_ADDRESS);

        await request(app)
          .post("/api/auth/wallet/logout")
          .send({ refreshToken: `  ${rawToken}  ` })
          .expect(204);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Error response structure validation
  // ───────────────────────────────────────────────────────────────────────

  describe("Error Response Structure", () => {
    it("includes correlationId in all error responses", async () => {
      const response = await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: INVALID_ADDRESS })
        .expect(422);

      expect(response.body.error).toHaveProperty("correlationId");
      expect(response.body.error.correlationId).toMatch(/^[a-zA-Z0-9-]+$/);
    });

    it("includes code and message in validation errors", async () => {
      const response = await request(app)
        .post("/api/auth/challenge")
        .send({})
        .expect(422);

      expect(response.body.error).toHaveProperty("code");
      expect(response.body.error).toHaveProperty("message");
      expect(response.body.error).toHaveProperty("fields");
    });

    it("includes fields object for validation errors", async () => {
      const response = await request(app)
        .post("/api/auth/verify")
        .send({ stellarAddress: INVALID_ADDRESS })
        .expect(422);

      expect(response.body.error).toHaveProperty("fields");
      expect(typeof response.body.error.fields).toBe("object");
    });
  });
});
