import { pool, closeDb, getDb } from "../../src/db/client";
import { users } from "../../src/db/schema";

describe("Postgres integration (testcontainers)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("connects and runs SELECT 1", async () => {
    const result = await pool.query("SELECT 1 AS value");
    expect(result.rows[0].value).toBe(1);
  });

  it("pool exposes the configured max size", () => {
    expect(pool.options.max).toBe(10);
  });

  it("supports prepared statements", async () => {
    const result = await pool.query("SELECT $1::int AS num", [42]);
    expect(result.rows[0].num).toBe(42);
  });

  it("handles concurrent queries", async () => {
    const results = await Promise.all([
      pool.query("SELECT 1 AS a"),
      pool.query("SELECT 2 AS b"),
      pool.query("SELECT 3 AS c"),
    ]);
    expect(results[0].rows[0].a).toBe(1);
    expect(results[1].rows[0].b).toBe(2);
    expect(results[2].rows[0].c).toBe(3);
  });

  it("accesses migrated schema via Drizzle ORM", async () => {
    const db = getDb();
    const result = await db.select().from(users).limit(1);
    expect(Array.isArray(result)).toBe(true);
  });
});
