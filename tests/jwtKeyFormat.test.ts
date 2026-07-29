import { parseJwtKeysEnv, formatJwtKeysEnv, DEFAULT_KID } from "../src/utils/jwtKeyFormat";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(40);

describe("parseJwtKeysEnv", () => {
  it("parses a single kid:secret pair", () => {
    expect(parseJwtKeysEnv(`2026-01-01:${SECRET_A}`)).toEqual([
      { kid: "2026-01-01", secret: SECRET_A },
    ]);
  });

  it("parses multiple comma-separated pairs in order", () => {
    expect(parseJwtKeysEnv(`a:${SECRET_A},b:${SECRET_B}`)).toEqual([
      { kid: "a", secret: SECRET_A },
      { kid: "b", secret: SECRET_B },
    ]);
  });

  it("trims whitespace around entries and fields", () => {
    expect(parseJwtKeysEnv(`  a : ${SECRET_A} , b:${SECRET_B}  `)).toEqual([
      { kid: "a", secret: SECRET_A },
      { kid: "b", secret: SECRET_B },
    ]);
  });

  it("ignores empty entries from trailing/double commas", () => {
    expect(parseJwtKeysEnv(`a:${SECRET_A},,b:${SECRET_B},`)).toEqual([
      { kid: "a", secret: SECRET_A },
      { kid: "b", secret: SECRET_B },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseJwtKeysEnv("")).toEqual([]);
  });

  it("accepts kids containing letters, digits, dots, underscores, and hyphens", () => {
    expect(parseJwtKeysEnv(`a.b_c-2026.01:${SECRET_A}`)).toEqual([
      { kid: "a.b_c-2026.01", secret: SECRET_A },
    ]);
  });

  it("throws when an entry has no colon separator", () => {
    expect(() => parseJwtKeysEnv("no-colon-here")).toThrow(/"kid:secret" format/);
  });

  it("throws when the kid contains an invalid character", () => {
    expect(() => parseJwtKeysEnv(`bad kid:${SECRET_A}`)).toThrow(/is invalid/);
  });

  it("throws when the kid is empty", () => {
    expect(() => parseJwtKeysEnv(`:${SECRET_A}`)).toThrow(/is invalid/);
  });

  it("throws when a secret is shorter than 32 characters", () => {
    expect(() => parseJwtKeysEnv("kid:too-short")).toThrow(/at least 32 characters/);
  });

  it("includes the offending kid in the secret-length error", () => {
    expect(() => parseJwtKeysEnv("my-kid:short")).toThrow(/"my-kid"/);
  });
});

describe("formatJwtKeysEnv", () => {
  it("serializes keys back to the kid:secret,... format", () => {
    expect(
      formatJwtKeysEnv([
        { kid: "a", secret: SECRET_A },
        { kid: "b", secret: SECRET_B },
      ]),
    ).toBe(`a:${SECRET_A},b:${SECRET_B}`);
  });

  it("returns an empty string for an empty list", () => {
    expect(formatJwtKeysEnv([])).toBe("");
  });

  it("round-trips through parseJwtKeysEnv", () => {
    const keys = [
      { kid: "x", secret: SECRET_A },
      { kid: "y", secret: SECRET_B },
    ];
    expect(parseJwtKeysEnv(formatJwtKeysEnv(keys))).toEqual(keys);
  });
});

describe("DEFAULT_KID", () => {
  it("is the reserved literal 'default'", () => {
    expect(DEFAULT_KID).toBe("default");
  });
});
