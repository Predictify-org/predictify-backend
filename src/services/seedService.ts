import { sql } from "drizzle-orm";
import { db } from "../db";

export interface SeedMarket {
  id: string;
  question: string;
  status: "active";
  resolutionTime: Date;
  metadata: Record<string, unknown>;
  indexedLedger: number;
}

export interface SeedResult {
  seedKey: string;
  requested: number;
  inserted: number;
  marketIds: string[];
}

export const sampleMarketSeedKey = "sample-markets-v1";

export const sampleMarkets: SeedMarket[] = [
  {
    id: "seed-market-btc-100k-2026",
    question: "Will BTC trade above $100,000 before the end of 2026?",
    status: "active",
    resolutionTime: new Date("2026-12-31T23:59:59.000Z"),
    metadata: { seeded: true, seedKey: sampleMarketSeedKey, category: "crypto" },
    indexedLedger: 0,
  },
  {
    id: "seed-market-stellar-tvl-2026",
    question: "Will Stellar DeFi TVL double before the end of 2026?",
    status: "active",
    resolutionTime: new Date("2026-12-31T23:59:59.000Z"),
    metadata: { seeded: true, seedKey: sampleMarketSeedKey, category: "stellar" },
    indexedLedger: 0,
  },
  {
    id: "seed-market-ai-agent-checkout",
    question: "Will an AI agent complete a production checkout flow this quarter?",
    status: "active",
    resolutionTime: new Date("2026-09-30T23:59:59.000Z"),
    metadata: { seeded: true, seedKey: sampleMarketSeedKey, category: "ai" },
    indexedLedger: 0,
  },
];

export async function seedSampleMarkets(): Promise<SeedResult> {
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO markets (
      id,
      question,
      status,
      resolution_time,
      metadata,
      indexed_ledger
    )
    VALUES
      ${sql.join(
        sampleMarkets.map(
          (market) => sql`(
            ${market.id},
            ${market.question},
            ${market.status},
            ${market.resolutionTime},
            ${JSON.stringify(market.metadata)}::jsonb,
            ${market.indexedLedger}
          )`,
        ),
        sql`,`,
      )}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);

  return {
    seedKey: sampleMarketSeedKey,
    requested: sampleMarkets.length,
    inserted: inserted.rows.length,
    marketIds: sampleMarkets.map((market) => market.id),
  };
}
