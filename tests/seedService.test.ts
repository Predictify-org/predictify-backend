const executeMock = jest.fn();

jest.mock("../src/db", () => ({
  db: {
    execute: executeMock,
  },
}));

import { sampleMarketSeedKey, sampleMarkets, seedSampleMarkets } from "../src/services/seedService";

describe("seedSampleMarkets", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("inserts fixed demo markets idempotently", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: sampleMarkets[0].id }] });

    const result = await seedSampleMarkets();
    const query = executeMock.mock.calls[0][0] as { queryChunks?: unknown[] };
    const rendered = JSON.stringify(query.queryChunks);

    expect(result).toEqual({
      seedKey: sampleMarketSeedKey,
      requested: sampleMarkets.length,
      inserted: 1,
      marketIds: sampleMarkets.map((market) => market.id),
    });
    expect(rendered).toContain("ON CONFLICT (id) DO NOTHING");
    expect(rendered).toContain("RETURNING id");
  });

  it("tracks seeded rows with metadata", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await seedSampleMarkets();
    const query = executeMock.mock.calls[0][0] as { queryChunks?: unknown[] };
    const rendered = JSON.stringify(query.queryChunks);

    expect(rendered).toContain(sampleMarketSeedKey);
    expect(rendered).toContain("seeded");
  });
});
