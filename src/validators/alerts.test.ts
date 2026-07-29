import { ZodError } from "zod";
import { listAlertsQuerySchema, markAlertsReadBodySchema } from "./alerts";

describe("listAlertsQuerySchema", () => {
  it("accepts an empty query and applies defaults", () => {
    const result = listAlertsQuerySchema.parse({});
    expect(result).toEqual({
      limit: 20,
      unreadOnly: undefined,
      severity: undefined,
      cursor: undefined,
    });
  });

  it("coerces unreadOnly=true to boolean true", () => {
    const result = listAlertsQuerySchema.parse({ unreadOnly: "true" });
    expect(result.unreadOnly).toBe(true);
  });

  it("coerces unreadOnly=false to boolean false", () => {
    const result = listAlertsQuerySchema.parse({ unreadOnly: "false" });
    expect(result.unreadOnly).toBe(false);
  });

  it("rejects an invalid unreadOnly value", () => {
    expect(() => listAlertsQuerySchema.parse({ unreadOnly: "yes" })).toThrow(ZodError);
  });

  it("accepts each valid severity", () => {
    for (const severity of ["info", "warning", "critical"]) {
      expect(listAlertsQuerySchema.parse({ severity }).severity).toBe(severity);
    }
  });

  it("rejects an invalid severity", () => {
    expect(() => listAlertsQuerySchema.parse({ severity: "urgent" })).toThrow(ZodError);
  });

  it("coerces a valid numeric limit string", () => {
    expect(listAlertsQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("rejects a limit below 1", () => {
    expect(() => listAlertsQuerySchema.parse({ limit: "0" })).toThrow(ZodError);
  });

  it("rejects a limit above 100", () => {
    expect(() => listAlertsQuerySchema.parse({ limit: "101" })).toThrow(ZodError);
  });

  it("rejects a non-integer limit", () => {
    expect(() => listAlertsQuerySchema.parse({ limit: "10.5" })).toThrow(ZodError);
  });

  it("accepts a valid cursor string", () => {
    expect(listAlertsQuerySchema.parse({ cursor: "abc123" }).cursor).toBe("abc123");
  });

  it("rejects an empty cursor string", () => {
    expect(() => listAlertsQuerySchema.parse({ cursor: "" })).toThrow(ZodError);
  });

  it("rejects an unknown query parameter", () => {
    expect(() => listAlertsQuerySchema.parse({ foo: "bar" })).toThrow(ZodError);
  });
});

describe("markAlertsReadBodySchema", () => {
  it("accepts an empty body", () => {
    expect(markAlertsReadBodySchema.parse({})).toEqual({ alertIds: undefined });
  });

  it("accepts a valid array of UUIDs", () => {
    const ids = [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ];
    expect(markAlertsReadBodySchema.parse({ alertIds: ids }).alertIds).toEqual(ids);
  });

  it("rejects a non-UUID string in alertIds", () => {
    expect(() => markAlertsReadBodySchema.parse({ alertIds: ["not-a-uuid"] })).toThrow(ZodError);
  });

  it("rejects alertIds that is not an array", () => {
    expect(() => markAlertsReadBodySchema.parse({ alertIds: "not-an-array" })).toThrow(ZodError);
  });

  it("rejects more than 500 alertIds", () => {
    const ids = Array.from(
      { length: 501 },
      () => "11111111-1111-1111-1111-111111111111",
    );
    expect(() => markAlertsReadBodySchema.parse({ alertIds: ids })).toThrow(ZodError);
  });

  it("rejects an unknown body field", () => {
    expect(() => markAlertsReadBodySchema.parse({ extra: true })).toThrow(ZodError);
  });
});
