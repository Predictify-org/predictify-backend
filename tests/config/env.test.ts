import { env } from "../../src/config/env";

describe("env", () => {
  it("parses PG_POOL_MAX with default 10", () => {
    expect(env.PG_POOL_MAX).toBe(10);
  });

  it("parses PG_STATEMENT_TIMEOUT_MS with default 5000", () => {
    expect(env.PG_STATEMENT_TIMEOUT_MS).toBe(5000);
  });
});
