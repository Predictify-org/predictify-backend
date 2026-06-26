import { pool, closeDb, connectWithRetry } from "../../src/db/client";

describe("db client", () => {
  it("exports a Pool with the configured max size", () => {
    expect(pool).toBeDefined();
    expect(pool.options.max).toBe(10);
  });

  it("retry rejects after exhausting attempts when DB is unreachable", async () => {
    await expect(connectWithRetry()).rejects.toThrow();
  }, 60000);
});

describe("closeDb", () => {
  it("resolves without throwing", async () => {
    await expect(closeDb()).resolves.toBeUndefined();
  });
});

const dbTestUrl = process.env.DATABASE_URL_TEST;

if (dbTestUrl) {
  describe("Postgres integration", () => {
    afterAll(async () => {
      const { Pool } = require("pg");
      const cleanPool = new Pool({ connectionString: dbTestUrl, max: 1 });
      await cleanPool.end();
    });

    it("runs SELECT 1 successfully", async () => {
      const { Pool } = require("pg");
      const integPool = new Pool({ connectionString: dbTestUrl, max: 1 });
      const result = await integPool.query("SELECT 1");
      expect(result.rows[0]).toBeDefined();
      await integPool.end();
    });

    it("pool respects max size", async () => {
      const { Pool } = require("pg");
      const max = 3;
      const integPool = new Pool({ connectionString: dbTestUrl, max });
      expect(integPool.options.max).toBe(max);
      const clients = [];
      for (let i = 0; i < max; i++) {
        clients.push(await integPool.connect());
      }
      for (const c of clients) {
        c.release();
      }
      await integPool.end();
    });

    it("statement timeout cancels long queries", async () => {
      const { Pool } = require("pg");
      const integPool = new Pool({
        connectionString: `${dbTestUrl}?statement_timeout=100`,
        max: 1,
      });
      await expect(
        integPool.query("SELECT pg_sleep(5)")
      ).rejects.toThrow();
      await integPool.end();
    });
  });
}
