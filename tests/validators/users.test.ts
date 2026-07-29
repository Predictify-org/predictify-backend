/**
 * tests/validators/users.test.ts
 *
 * Unit tests for the Zod schemas exported from src/validators/users.ts.
 *
 * Coverage targets
 * ────────────────
 *   1. stellarAddressSchema — valid & invalid Stellar addresses
 *   2. userPredictionsParamsSchema — path param validation
 *   3. userPredictionsQuerySchema — query params: status, limit, cursor, strict unknown key rejection
 *   4. userProfileParamsSchema — path param validation for profile endpoint
 *   5. userPortfolioParamsSchema — path param validation for portfolio endpoint
 *   6. Type inference (z.infer) matches expected types
 *   7. Edge cases — whitespace trimming, numeric coercion, default limit
 */

import { z } from "zod";
import {
  stellarAddressSchema,
  userPredictionsParamsSchema,
  userPredictionsQuerySchema,
  userProfileParamsSchema,
  userPortfolioParamsSchema,
} from "../../src/validators/users";
import { DEFAULT_PAGE_SIZE } from "../../src/utils/cursor";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A syntactically valid 56-char Stellar G-address. */
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const VALID_ADDRESS_2 = "GBBD47UZQ5DXGX23UKMHLGG5TZPJJKISVQYER3SPRINGS57LVEDSTQCEO";

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

// ── 1. stellarAddressSchema ────────────────────────────────────────────────

describe("stellarAddressSchema", () => {
  it("accepts a valid 56-char G-prefixed base-32 address", () => {
    const out = parseOk(stellarAddressSchema, VALID_ADDRESS);
    expect(out).toBe(VALID_ADDRESS);
  });

  it("rejects addresses shorter than 56 characters", () => {
    const err = parseErr(stellarAddressSchema, "GSHORT");
    expect(err.issues[0]?.code).toBe("invalid_string");
  });

  it("rejects addresses longer than 56 characters", () => {
    const err = parseErr(stellarAddressSchema, VALID_ADDRESS + "X");
    expect(err.issues[0]?.code).toBe("invalid_string");
  });

  it("rejects addresses that do not start with G", () => {
    const bad = "A" + VALID_ADDRESS.slice(1);
    const err = parseErr(stellarAddressSchema, bad);
    expect(err.issues[0]?.code).toBe("invalid_string");
  });

  it("rejects addresses with lowercase letters", () => {
    const err = parseErr(stellarAddressSchema, VALID_ADDRESS.toLowerCase());
    expect(err.issues[0]?.code).toBe("invalid_string");
  });

  it.each(["0", "1", "8", "9"] as const)(
    "rejects addresses containing invalid base-32 char '%s'",
    (ch) => {
      const bad = VALID_ADDRESS.slice(0, 55) + ch;
      const err = parseErr(stellarAddressSchema, bad);
      expect(err.issues[0]?.code).toBe("invalid_string");
    },
  );

  it("trims surrounding whitespace before validation", () => {
    const out = parseOk(stellarAddressSchema, `  ${VALID_ADDRESS}\t`);
    expect(out).toBe(VALID_ADDRESS);
  });

  it("rejects empty string", () => {
    const err = parseErr(stellarAddressSchema, "");
    expect(err.issues[0]?.code).toBe("invalid_string");
  });

  it("rejects non-string inputs (number)", () => {
    const err = parseErr(stellarAddressSchema, 12345);
    expect(err.issues[0]?.code).toBe("invalid_type");
  });

  it("rejects null", () => {
    const err = parseErr(stellarAddressSchema, null);
    expect(err.issues[0]?.code).toBe("invalid_type");
  });

  it("rejects undefined (required_error)", () => {
    const err = parseErr(stellarAddressSchema, undefined);
    expect(err.issues[0]?.code).toBe("invalid_type");
    expect(err.issues[0]?.message).toContain("required");
  });
});

// ── 2. userPredictionsParamsSchema ──────────────────────────────────────────

describe("userPredictionsParamsSchema", () => {
  it("accepts a valid address param", () => {
    const out = parseOk(userPredictionsParamsSchema, { address: VALID_ADDRESS });
    expect(out.address).toBe(VALID_ADDRESS);
  });

  it("rejects invalid address param", () => {
    const err = parseErr(userPredictionsParamsSchema, { address: "not-an-address" });
    expect(err.issues).toHaveLength(1);
  });

  it("rejects missing address param", () => {
    const err = parseErr(userPredictionsParamsSchema, {});
    expect(err.issues[0]?.path).toEqual(["address"]);
  });

  it("rejects extra unknown keys (strict)", () => {
    const err = parseErr(userPredictionsParamsSchema, {
      address: VALID_ADDRESS,
      extra: "field",
    });
    expect(err.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("type inference produces { address: string }", () => {
    type T = z.infer<typeof userPredictionsParamsSchema>;
    const _assert: { address: string } = {} as T;
    void _assert;
  });
});

// ── 3. userPredictionsQuerySchema ───────────────────────────────────────────

describe("userPredictionsQuerySchema", () => {
  describe("limit — coercion, range, default", () => {
    it("defaults limit to DEFAULT_PAGE_SIZE when absent", () => {
      const out = parseOk(userPredictionsQuerySchema, {});
      expect(out.limit).toBe(DEFAULT_PAGE_SIZE);
    });

    it("coerces numeric string limit to number", () => {
      const out = parseOk(userPredictionsQuerySchema, { limit: "25" });
      expect(out.limit).toBe(25);
      expect(typeof out.limit).toBe("number");
    });

    it("accepts limit = 1 (minimum)", () => {
      const out = parseOk(userPredictionsQuerySchema, { limit: "1" });
      expect(out.limit).toBe(1);
    });

    it("accepts limit = 100 (maximum)", () => {
      const out = parseOk(userPredictionsQuerySchema, { limit: "100" });
      expect(out.limit).toBe(100);
    });

    it("rejects limit = 0", () => {
      const err = parseErr(userPredictionsQuerySchema, { limit: "0" });
      expect(err.issues[0]?.path).toEqual(["limit"]);
    });

    it("rejects limit = 101 (above maximum)", () => {
      const err = parseErr(userPredictionsQuerySchema, { limit: "101" });
      expect(err.issues[0]?.path).toEqual(["limit"]);
    });

    it("rejects non-integer limit (1.5)", () => {
      const err = parseErr(userPredictionsQuerySchema, { limit: "1.5" });
      expect(err.issues[0]?.code).toBe("invalid_type");
    });

    it("rejects non-numeric limit string", () => {
      const err = parseErr(userPredictionsQuerySchema, { limit: "abc" });
      expect(err.issues[0]?.code).toBe("invalid_type");
    });
  });

  describe("status — enum validation", () => {
    it.each(["pending", "confirmed", "won", "lost", "claimed"] as const)(
      "accepts status = %s",
      (status) => {
        const out = parseOk(userPredictionsQuerySchema, { status });
        expect(out.status).toBe(status);
      },
    );

    it("rejects an unknown status value", () => {
      const err = parseErr(userPredictionsQuerySchema, { status: "settled" });
      expect(err.issues[0]?.code).toBe("invalid_enum_value");
    });

    it("omits status when not provided", () => {
      const out = parseOk(userPredictionsQuerySchema, {});
      expect("status" in out).toBe(false);
    });
  });

  describe("cursor — optional string", () => {
    it("accepts a cursor string", () => {
      const cursor = "eyJzb3J0VmFsdWUiOiJ0ZXN0In0";
      const out = parseOk(userPredictionsQuerySchema, { cursor });
      expect(out.cursor).toBe(cursor);
    });

    it("trims a cursor with whitespace", () => {
      const cursor = "abc123";
      const out = parseOk(userPredictionsQuerySchema, { cursor: ` ${cursor} ` });
      expect(out.cursor).toBe(cursor);
    });

    it("rejects an empty-string cursor", () => {
      const err = parseErr(userPredictionsQuerySchema, { cursor: "" });
      expect(err.issues[0]?.path).toEqual(["cursor"]);
    });

    it("rejects cursor as number", () => {
      const err = parseErr(userPredictionsQuerySchema, { cursor: 42 });
      expect(err.issues[0]?.code).toBe("invalid_type");
    });
  });

  describe("strict — unknown query keys", () => {
    it("rejects an unknown query parameter", () => {
      const err = parseErr(userPredictionsQuerySchema, {
        status: "pending",
        unknownParam: "drop-table",
      });
      expect(err.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    });

    it("rejects multiple unknown keys", () => {
      const err = parseErr(userPredictionsQuerySchema, {
        foo: "1",
        bar: "2",
      });
      const unrec = err.issues.find((i) => i.code === "unrecognized_keys");
      expect(unrec).toBeDefined();
      expect((unrec as z.UnrecognizedKeysIssue).keys).toEqual(
        expect.arrayContaining(["foo", "bar"]),
      );
    });
  });

  describe("happy-path combinations", () => {
    it("parses a fully-specified query correctly", () => {
      const out = parseOk(userPredictionsQuerySchema, {
        status: "won",
        cursor: "someCursor",
        limit: "50",
      });
      expect(out).toEqual({ status: "won", cursor: "someCursor", limit: 50 });
    });

    it("type inference matches documented shape", () => {
      type T = z.infer<typeof userPredictionsQuerySchema>;
      const _sample: T = { status: "pending", cursor: "x", limit: 10 };
      const _partial: T = { limit: 20 };
      void _sample;
      void _partial;
    });
  });
});

// ── 4. userProfileParamsSchema ──────────────────────────────────────────────

describe("userProfileParamsSchema", () => {
  it("accepts a valid stellarAddress", () => {
    const out = parseOk(userProfileParamsSchema, { stellarAddress: VALID_ADDRESS });
    expect(out.stellarAddress).toBe(VALID_ADDRESS);
  });

  it("rejects invalid stellarAddress", () => {
    const err = parseErr(userProfileParamsSchema, { stellarAddress: "G" });
    expect(err.issues).toHaveLength(1);
  });

  it("rejects missing stellarAddress", () => {
    const err = parseErr(userProfileParamsSchema, {});
    expect(err.issues[0]?.path).toEqual(["stellarAddress"]);
  });

  it("rejects unknown keys (strict)", () => {
    const err = parseErr(userProfileParamsSchema, {
      stellarAddress: VALID_ADDRESS,
      extraField: true,
    });
    expect(err.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("type inference produces { stellarAddress: string }", () => {
    type T = z.infer<typeof userProfileParamsSchema>;
    const _assert: { stellarAddress: string } = {} as T;
    void _assert;
  });
});

// ── 5. userPortfolioParamsSchema ────────────────────────────────────────────

describe("userPortfolioParamsSchema", () => {
  it("accepts a valid addr", () => {
    const out = parseOk(userPortfolioParamsSchema, { addr: VALID_ADDRESS_2 });
    expect(out.addr).toBe(VALID_ADDRESS_2);
  });

  it("rejects invalid addr", () => {
    const err = parseErr(userPortfolioParamsSchema, { addr: "bad-addr" });
    expect(err.issues).toHaveLength(1);
  });

  it("rejects missing addr", () => {
    const err = parseErr(userPortfolioParamsSchema, {});
    expect(err.issues[0]?.path).toEqual(["addr"]);
  });

  it("rejects unknown keys (strict)", () => {
    const err = parseErr(userPortfolioParamsSchema, {
      addr: VALID_ADDRESS_2,
      surprise: "field",
    });
    expect(err.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("type inference produces { addr: string }", () => {
    type T = z.infer<typeof userPortfolioParamsSchema>;
    const _assert: { addr: string } = {} as T;
    void _assert;
  });
});
