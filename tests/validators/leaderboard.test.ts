/**
 * tests/validators/leaderboard.test.ts
 *
 * Unit tests for the Zod schemas exported from src/validators/leaderboard.ts.
 *
 * Coverage targets
 * ────────────────
 *   1. leaderboardQuerySchema — query params: limit, offset, refresh, period,
 *      strict unknown key rejection, type coercion, defaults
 *   2. leaderboardUserParamsSchema — stellar address path param validation
 *   3. leaderboardUserQuerySchema — period query param for user endpoint
 *   4. LeaderboardPeriod enum — correct string values
 *   5. Edge cases — whitespace, decimal values, boundary values
 */

import { z } from "zod";
import {
  leaderboardQuerySchema,
  leaderboardUserParamsSchema,
  leaderboardUserQuerySchema,
  LeaderboardPeriod,
} from "../../src/validators/leaderboard";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A syntactically valid 56-char Stellar G-address. */
const VALID_ADDRESS = "GAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF";

/** Another valid 56-char address (different pattern). */
const VALID_ADDRESS_2 = "GBTCHKHMWCS5TOX2LAD4DAEKTC3UFSFXQ2MRLED5EYOA34RH4ZX72JK";

/** A 56-char string that fails because prefix is 'A' not 'G'. */
const WRONG_PREFIX = "AAHK7EYR7AQ5B56K2RRYUWWC7EJ5CWWWURC2Q4GQRHBDQY7ZLMQVB6TF";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Run safeParse and expect success; return parsed data. */
function parseOk<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const r = schema.safeParse(input);
  expect(r.success).toBe(true);
  return (r as z.SafeParseSuccess<T>).data;
}

/** Run safeParse and expect failure; return the ZodError. */
function parseErr(schema: z.ZodSchema, input: unknown): z.ZodError {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  return (r as z.SafeParseError<unknown>).error;
}

// ── 1. LeaderboardPeriod enum ─────────────────────────────────────────────

describe("LeaderboardPeriod", () => {
  it("has correct string values", () => {
    expect(LeaderboardPeriod.ALL_TIME).toBe("all-time");
    expect(LeaderboardPeriod.MONTHLY).toBe("monthly");
    expect(LeaderboardPeriod.WEEKLY).toBe("weekly");
  });
});

// ── 2. leaderboardQuerySchema ───────────────────────────────────────────────

describe("leaderboardQuerySchema", () => {
  describe("default values", () => {
    it("returns defaults when no query params are provided", () => {
      const data = parseOk(leaderboardQuerySchema, {});
      expect(data.limit).toBe(50);
      expect(data.offset).toBe(0);
      expect(data.refresh).toBe(false);
      expect(data.period).toBe(LeaderboardPeriod.ALL_TIME);
    });
  });

  describe("limit", () => {
    it("accepts a valid limit within range", () => {
      const data = parseOk(leaderboardQuerySchema, { limit: 25 });
      expect(data.limit).toBe(25);
    });

    it("coerces string limit to number", () => {
      const data = parseOk(leaderboardQuerySchema, { limit: "30" });
      expect(data.limit).toBe(30);
    });

    it("rejects limit of 0", () => {
      const err = parseErr(leaderboardQuerySchema, { limit: 0 });
      expect(err.issues[0].message).toMatch(/between 1 and 100/i);
    });

    it("rejects negative limit", () => {
      const err = parseErr(leaderboardQuerySchema, { limit: -1 });
      expect(err.issues[0].message).toMatch(/between 1 and 100/i);
    });

    it("rejects limit exceeding 100", () => {
      const err = parseErr(leaderboardQuerySchema, { limit: 101 });
      expect(err.issues[0].message).toMatch(/100/i);
    });

    it("rejects decimal limit", () => {
      const err = parseErr(leaderboardQuerySchema, { limit: 10.5 });
      expect(err.issues[0].message).toMatch(/integer/i);
    });

    it("rejects non-numeric limit string", () => {
      const err = parseErr(leaderboardQuerySchema, { limit: "abc" });
      expect(err.issues[0].message).toMatch(/number/i);
    });
  });

  describe("offset", () => {
    it("accepts a valid offset", () => {
      const data = parseOk(leaderboardQuerySchema, { offset: 100 });
      expect(data.offset).toBe(100);
    });

    it("accepts offset of 0", () => {
      const data = parseOk(leaderboardQuerySchema, { offset: 0 });
      expect(data.offset).toBe(0);
    });

    it("coerces string offset to number", () => {
      const data = parseOk(leaderboardQuerySchema, { offset: "50" });
      expect(data.offset).toBe(50);
    });

    it("rejects negative offset", () => {
      const err = parseErr(leaderboardQuerySchema, { offset: -1 });
      expect(err.issues[0].message).toMatch(/non-negative/i);
    });

    it("rejects decimal offset", () => {
      const err = parseErr(leaderboardQuerySchema, { offset: 1.5 });
      expect(err.issues[0].message).toMatch(/integer/i);
    });
  });

  describe("refresh", () => {
    it("accepts boolean refresh", () => {
      const data = parseOk(leaderboardQuerySchema, { refresh: true });
      expect(data.refresh).toBe(true);
    });

    it("coerces string 'true' to boolean", () => {
      const data = parseOk(leaderboardQuerySchema, { refresh: "true" });
      expect(data.refresh).toBe(true);
    });

    it("coerces string 'false' to boolean", () => {
      const data = parseOk(leaderboardQuerySchema, { refresh: "false" });
      expect(data.refresh).toBe(false);
    });

    it("defaults refresh to false", () => {
      const data = parseOk(leaderboardQuerySchema, {});
      expect(data.refresh).toBe(false);
    });
  });

  describe("period", () => {
    it("accepts 'all-time' period", () => {
      const data = parseOk(leaderboardQuerySchema, { period: "all-time" });
      expect(data.period).toBe(LeaderboardPeriod.ALL_TIME);
    });

    it("accepts 'monthly' period", () => {
      const data = parseOk(leaderboardQuerySchema, { period: "monthly" });
      expect(data.period).toBe(LeaderboardPeriod.MONTHLY);
    });

    it("accepts 'weekly' period", () => {
      const data = parseOk(leaderboardQuerySchema, { period: "weekly" });
      expect(data.period).toBe(LeaderboardPeriod.WEEKLY);
    });

    it("defaults to all-time when omitted", () => {
      const data = parseOk(leaderboardQuerySchema, {});
      expect(data.period).toBe(LeaderboardPeriod.ALL_TIME);
    });

    it("rejects invalid period value", () => {
      const err = parseErr(leaderboardQuerySchema, { period: "invalid" });
      expect(err.issues[0].message).toMatch(/period must be one of/i);
    });
  });

  describe("strict mode", () => {
    it("rejects unknown query parameters", () => {
      const err = parseErr(leaderboardQuerySchema, { unknownParam: "value" });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it("rejects multiple unknown parameters", () => {
      const err = parseErr(leaderboardQuerySchema, {
        foo: "bar",
        baz: "qux",
        limit: 10,
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  describe("combined parameters", () => {
    it("accepts all valid parameters simultaneously", () => {
      const data = parseOk(leaderboardQuerySchema, {
        limit: 25,
        offset: 10,
        refresh: true,
        period: "monthly",
      });
      expect(data.limit).toBe(25);
      expect(data.offset).toBe(10);
      expect(data.refresh).toBe(true);
      expect(data.period).toBe(LeaderboardPeriod.MONTHLY);
    });
  });
});

// ── 3. leaderboardUserParamsSchema ─────────────────────────────────────────

describe("leaderboardUserParamsSchema", () => {
  it("accepts a valid Stellar address", () => {
    const data = parseOk(leaderboardUserParamsSchema, {
      stellarAddress: VALID_ADDRESS,
    });
    expect(data.stellarAddress).toBe(VALID_ADDRESS);
  });

  it("rejects an invalid Stellar address", () => {
    const err = parseErr(leaderboardUserParamsSchema, {
      stellarAddress: "INVALID",
    });
    expect(err.issues[0].message).toMatch(/Stellar address/i);
  });

  it("rejects address with wrong prefix", () => {
    const err = parseErr(leaderboardUserParamsSchema, {
      stellarAddress: WRONG_PREFIX,
    });
    expect(err.issues[0].message).toMatch(/Stellar address/i);
  });

  it("rejects empty address", () => {
    const err = parseErr(leaderboardUserParamsSchema, {
      stellarAddress: "",
    });
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("rejects missing stellarAddress", () => {
    const err = parseErr(leaderboardUserParamsSchema, {});
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("strips whitespace from address", () => {
    const addr = `  ${VALID_ADDRESS}  `;
    const data = parseOk(leaderboardUserParamsSchema, {
      stellarAddress: addr,
    });
    expect(data.stellarAddress).toBe(VALID_ADDRESS);
  });

  it("rejects unknown keys in strict mode", () => {
    const err = parseErr(leaderboardUserParamsSchema, {
      stellarAddress: VALID_ADDRESS,
      extraParam: "should not be here",
    });
    expect(err.issues.length).toBeGreaterThan(0);
  });
});

// ── 4. leaderboardUserQuerySchema ──────────────────────────────────────────

describe("leaderboardUserQuerySchema", () => {
  it("defaults period to all-time when omitted", () => {
    const data = parseOk(leaderboardUserQuerySchema, {});
    expect(data.period).toBe(LeaderboardPeriod.ALL_TIME);
  });

  it("accepts monthly period", () => {
    const data = parseOk(leaderboardUserQuerySchema, { period: "monthly" });
    expect(data.period).toBe(LeaderboardPeriod.MONTHLY);
  });

  it("accepts weekly period", () => {
    const data = parseOk(leaderboardUserQuerySchema, { period: "weekly" });
    expect(data.period).toBe(LeaderboardPeriod.WEEKLY);
  });

  it("rejects invalid period", () => {
    const err = parseErr(leaderboardUserQuerySchema, { period: "invalid" });
    expect(err.issues[0].message).toMatch(/period must be one of/i);
  });

  it("rejects unknown query parameters in strict mode", () => {
    const err = parseErr(leaderboardUserQuerySchema, {
      period: "monthly",
      unknownParam: "value",
    });
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("rejects limit parameter on user endpoint (not allowed)", () => {
    const err = parseErr(leaderboardUserQuerySchema, {
      limit: 50,
    });
    expect(err.issues.length).toBeGreaterThan(0);
  });
});

// ── 5. Type inference ──────────────────────────────────────────────────────

describe("type inference", () => {
  it("leaderboardQuerySchema infers correct type", () => {
    const _typeCheck: z.infer<typeof leaderboardQuerySchema> = {
      limit: 10,
      offset: 0,
      refresh: false,
      period: LeaderboardPeriod.ALL_TIME,
    };
    expect(_typeCheck).toBeDefined();
  });
});
