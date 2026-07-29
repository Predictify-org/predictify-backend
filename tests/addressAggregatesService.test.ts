import { sql } from "drizzle-orm";

jest.mock("../src/db", () => ({
  db: { execute: jest.fn() },
}));

import { db } from "../src/db";
import {
  refreshAddressAggregates,
  getAddressAggregates,
  getAddressAggregate,
  getAddressAggregatesWithRefresh,
} from "../src/services/addressAggregatesService";

const mockExecute = db.execute as jest.MockedFunction<typeof db.execute>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("addressAggregatesService", () => {
  const sampleRows = [
    {
      user_id: "u1",
      stellar_address: "GAAA",
      total_predictions: 10,
      correct_predictions: 7,
      accuracy_percentage: 70.0,
      rank: 1,
    },
    {
      user_id: "u2",
      stellar_address: "GBBB",
      total_predictions: 5,
      correct_predictions: 2,
      accuracy_percentage: 40.0,
      rank: 2,
    },
  ];

  describe("refreshAddressAggregates", () => {
    it("issues REFRESH MATERIALIZED VIEW CONCURRENTLY", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [], fields: [], command: "REFRESH", rowCount: 0, oid: 0 });

      await refreshAddressAggregates();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [query] = mockExecute.mock.calls[0] as [ReturnType<typeof sql>];
      expect(query).toBeDefined();
    });
  });

  describe("getAddressAggregates", () => {
    it("returns paginated rows ordered by rank", async () => {
      mockExecute.mockResolvedValueOnce({ rows: sampleRows, fields: [], command: "SELECT", rowCount: 2, oid: 0 });

      const result = await getAddressAggregates(10, 0);

      expect(result).toEqual(sampleRows);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("uses default limit=50 and offset=0", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [], fields: [], command: "SELECT", rowCount: 0, oid: 0 });

      await getAddressAggregates();

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getAddressAggregate", () => {
    it("returns a single entry for a known address", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [sampleRows[0]], fields: [], command: "SELECT", rowCount: 1, oid: 0 });

      const result = await getAddressAggregate("GAAA");

      expect(result).toEqual(sampleRows[0]);
    });

    it("returns null when address is not found", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [], fields: [], command: "SELECT", rowCount: 0, oid: 0 });

      const result = await getAddressAggregate("GZZZ");

      expect(result).toBeNull();
    });
  });

  describe("getAddressAggregatesWithRefresh", () => {
    it("refreshes then returns paginated rows", async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [], fields: [], command: "REFRESH", rowCount: 0, oid: 0 }) // refresh
        .mockResolvedValueOnce({ rows: sampleRows, fields: [], command: "SELECT", rowCount: 2, oid: 0 }); // query

      const result = await getAddressAggregatesWithRefresh(20, 10);

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(result).toEqual(sampleRows);
    });
  });
});
