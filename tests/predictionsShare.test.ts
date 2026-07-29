/**
 * predictionsShare.test.ts
 *
 * Focused tests for GET /api/predictions/:id/share.
 *
 * Strategy
 * ────────
 *  • The Drizzle DB is never touched — all DB access is injected via the
 *    `ShareRepo` interface so tests run without Postgres.
 *  • The Express app is created fresh (`createApp`) but the share route is
 *    also tested directly via `createShareRouter({ repo, appBaseUrl })` for
 *    tighter isolation of the route handler.
 *  • Pure helper functions (formatAmount, buildResultLabel, buildStatusFragment,
 *    getPredictionShareMeta) are tested independently of HTTP.
 *
 * Coverage
 * ────────
 *  1. Helper: formatAmount
 *  2. Helper: buildResultLabel
 *  3. Helper: buildStatusFragment
 *  4. Service: getPredictionShareMeta (happy path + not-found + market-missing)
 *  5. HTTP handler: 200, 404, no-auth-required, invalid ID edge cases
 */

import request from "supertest";
import express from "express";
import {
  formatAmount,
  buildResultLabel,
  buildStatusFragment,
  getPredictionShareMeta,
  createShareRouter,
  ShareNotFoundError,
  type ShareRepo,
  type PredictionShareMeta,
} from "../src/routes/predictions/share";

// ---------------------------------------------------------------------------
// Stubs / fixtures
// ---------------------------------------------------------------------------

type PredictionRow = {
  id: string;
  marketId: string;
  userId: string;
  outcome: string;
  amount: string;
  txHash: string;
  status: string;
  result: string | null;
  createdAt: Date;
};

type MarketRow = {
  id: string;
  question: string;
  status: string;
  resolutionOutcome: string | null;
  resolutionTime: Date;
  winningOutcome: string | null;
  metadata: Record<string, unknown> | null;
  indexedLedger: number;
  archived: boolean;
  version: number;
};

function makePrediction(overrides: Partial<PredictionRow> = {}): PredictionRow {
  return {
    id: "pred-00000000-0000-4000-a000-000000000001",
    marketId: "mkt-1",
    userId: "user-1",
    outcome: "yes",
    amount: "100000000",    // 10 XLM
    txHash: "0xabc",
    status: "pending",
    result: null,
    createdAt: new Date("2025-01-01T12:00:00Z"),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: "mkt-1",
    question: "Will Bitcoin exceed $100k by end of 2025?",
    status: "active",
    resolutionOutcome: null,
    resolutionTime: new Date("2026-01-01T00:00:00Z"),
    winningOutcome: null,
    metadata: null,
    indexedLedger: 100,
    archived: false,
    version: 1,
    ...overrides,
  };
}

/** Builds an in-memory ShareRepo stub. */
function makeRepo(opts: {
  prediction?: PredictionRow | null;
  market?: MarketRow | null;
}): ShareRepo {
  return {
    async findPredictionWithMarket(id: string) {
      if (!opts.prediction || opts.prediction.id !== id) return null;
      if (!opts.market) return null;
      return {
        prediction: opts.prediction as unknown as Parameters<ShareRepo["findPredictionWithMarket"]> extends never ? never : Awaited<ReturnType<ShareRepo["findPredictionWithMarket"]>> extends null | infer R ? (R extends { prediction: infer P } ? P : never) : never,
        market: opts.market as unknown as Parameters<ShareRepo["findPredictionWithMarket"]> extends never ? never : Awaited<ReturnType<ShareRepo["findPredictionWithMarket"]>> extends null | infer R ? (R extends { market: infer M } ? M : never) : never,
      } as Exclude<Awaited<ReturnType<ShareRepo["findPredictionWithMarket"]>>, null>;
    },
  };
}

/** Builds a tiny Express app with only the share router — for isolated HTTP tests. */
function makeApp(repo: ShareRepo, appBaseUrl = "https://preview.example.com"): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/predictions", createShareRouter({ repo, appBaseUrl }));
  // Minimal error handler so unexpected errors give a visible 500 body.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: { code: "internal_error", message: String(err) } });
  });
  return app;
}

const PRED_ID = "pred-00000000-0000-4000-a000-000000000001";
const BASE_URL = "https://preview.example.com";

// ---------------------------------------------------------------------------
// 1. formatAmount
// ---------------------------------------------------------------------------

describe("formatAmount", () => {
  it("converts stroops to XLM (10 XLM)", () => {
    expect(formatAmount("100000000")).toBe("10 XLM");
  });

  it("converts 1 XLM (10_000_000 stroops)", () => {
    expect(formatAmount("10000000")).toBe("1 XLM");
  });

  it("handles fractional XLM", () => {
    expect(formatAmount("5000000")).toBe("0.5 XLM");
  });

  it("returns raw + XLM when value is not a number", () => {
    expect(formatAmount("abc")).toBe("abc XLM");
  });

  it("handles zero", () => {
    expect(formatAmount("0")).toBe("0 XLM");
  });

  it("handles very large amount", () => {
    // 1,000,000 XLM
    expect(formatAmount("10000000000000")).toMatch(/XLM/);
  });
});

// ---------------------------------------------------------------------------
// 2. buildResultLabel
// ---------------------------------------------------------------------------

describe("buildResultLabel", () => {
  it("returns trophy label for 'won'", () => {
    expect(buildResultLabel("won")).toBe("🏆 Won");
  });

  it("returns cross label for 'lost'", () => {
    expect(buildResultLabel("lost")).toBe("❌ Lost");
  });

  it("returns crystal ball label for null (pending)", () => {
    expect(buildResultLabel(null)).toBe("🔮 Predicted on");
  });

  it("returns crystal ball label for unknown result strings", () => {
    expect(buildResultLabel("pending")).toBe("🔮 Predicted on");
    expect(buildResultLabel("")).toBe("🔮 Predicted on");
  });
});

// ---------------------------------------------------------------------------
// 3. buildStatusFragment
// ---------------------------------------------------------------------------

describe("buildStatusFragment", () => {
  it("shows resolved outcome for resolved market", () => {
    const fragment = buildStatusFragment("resolved", "yes", new Date("2025-06-01T00:00:00Z"));
    expect(fragment).toBe('resolved → "yes"');
  });

  it("handles disputed status", () => {
    expect(buildStatusFragment("disputed", null, new Date())).toBe("under dispute");
  });

  it("shows future resolution date for active market", () => {
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const fragment = buildStatusFragment("active", null, future);
    expect(fragment).toMatch(/^resolves /);
  });

  it("shows 'pending resolution' for past unresolved market", () => {
    const past = new Date(Date.now() - 1000);
    const fragment = buildStatusFragment("active", null, past);
    expect(fragment).toBe("pending resolution");
  });

  it("treats resolved with null winningOutcome as non-resolved (falls through)", () => {
    // no winningOutcome → should not render "resolved → ..." 
    const past = new Date(Date.now() - 1000);
    const fragment = buildStatusFragment("resolved", null, past);
    expect(fragment).toBe("pending resolution");
  });
});

// ---------------------------------------------------------------------------
// 4. getPredictionShareMeta (service)
// ---------------------------------------------------------------------------

describe("getPredictionShareMeta", () => {
  const pred = makePrediction();
  const market = makeMarket();

  it("returns all required OG fields", async () => {
    const repo = makeRepo({ prediction: pred, market });
    const meta = await getPredictionShareMeta(PRED_ID, BASE_URL, repo);

    expect(meta.ogUrl).toBe(`${BASE_URL}/predictions/${PRED_ID}`);
    expect(meta.ogTitle).toContain(market.question);
    expect(meta.ogDescription).toContain(pred.outcome);
    expect(meta.ogImage).toBe(`${BASE_URL}/og/default.png`);
    expect(meta.twitterCard).toBe("summary_large_image");
  });

  it("embeds structured prediction and market objects", async () => {
    const repo = makeRepo({ prediction: pred, market });
    const meta = await getPredictionShareMeta(PRED_ID, BASE_URL, repo);

    expect(meta.prediction.id).toBe(pred.id);
    expect(meta.prediction.outcome).toBe("yes");
    expect(meta.prediction.amount).toBe("100000000");
    expect(meta.prediction.result).toBeNull();
    expect(meta.market.id).toBe(market.id);
    expect(meta.market.question).toBe(market.question);
    expect(meta.market.status).toBe("active");
  });

  it("uses 'won' label in title when prediction result is 'won'", async () => {
    const wonPred = makePrediction({ result: "won" });
    const resolvedMarket = makeMarket({ status: "resolved", winningOutcome: "yes" });
    const meta = await getPredictionShareMeta(
      PRED_ID, BASE_URL,
      makeRepo({ prediction: wonPred, market: resolvedMarket }),
    );
    expect(meta.ogTitle).toContain("🏆 Won");
  });

  it("uses 'lost' label in title when prediction result is 'lost'", async () => {
    const lostPred = makePrediction({ result: "lost" });
    const resolvedMarket = makeMarket({ status: "resolved", winningOutcome: "no" });
    const meta = await getPredictionShareMeta(
      PRED_ID, BASE_URL,
      makeRepo({ prediction: lostPred, market: resolvedMarket }),
    );
    expect(meta.ogTitle).toContain("❌ Lost");
  });

  it("uses a custom metadata ogImage when present and HTTPS", async () => {
    const customImage = "https://cdn.example.com/market-og.png";
    const marketWithImg = makeMarket({ metadata: { ogImage: customImage } });
    const meta = await getPredictionShareMeta(
      PRED_ID, BASE_URL,
      makeRepo({ prediction: pred, market: marketWithImg }),
    );
    expect(meta.ogImage).toBe(customImage);
  });

  it("falls back to default image when metadata ogImage is HTTP (not HTTPS)", async () => {
    const marketWithImg = makeMarket({ metadata: { ogImage: "http://cdn.example.com/img.png" } });
    const meta = await getPredictionShareMeta(
      PRED_ID, BASE_URL,
      makeRepo({ prediction: pred, market: marketWithImg }),
    );
    expect(meta.ogImage).toBe(`${BASE_URL}/og/default.png`);
  });

  it("falls back to default image when metadata ogImage is not a string", async () => {
    const marketWithImg = makeMarket({ metadata: { ogImage: 42 } });
    const meta = await getPredictionShareMeta(
      PRED_ID, BASE_URL,
      makeRepo({ prediction: pred, market: marketWithImg }),
    );
    expect(meta.ogImage).toBe(`${BASE_URL}/og/default.png`);
  });

  it("throws ShareNotFoundError when prediction is not found", async () => {
    const repo = makeRepo({ prediction: null, market });
    await expect(getPredictionShareMeta("unknown-id", BASE_URL, repo)).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("throws ShareNotFoundError when market is missing for prediction", async () => {
    const repo = makeRepo({ prediction: pred, market: null });
    await expect(getPredictionShareMeta(PRED_ID, BASE_URL, repo)).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("returns ISO 8601 strings for dates", async () => {
    const repo = makeRepo({ prediction: pred, market });
    const meta = await getPredictionShareMeta(PRED_ID, BASE_URL, repo);
    expect(meta.prediction.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.market.resolutionTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// 5. HTTP handler — via createShareRouter (isolated mini-app)
// ---------------------------------------------------------------------------

describe("GET /api/predictions/:id/share — HTTP handler", () => {
  const pred = makePrediction();
  const market = makeMarket();

  it("returns 200 with data when prediction exists", async () => {
    const app = makeApp(makeRepo({ prediction: pred, market }));
    const res = await request(app).get(`/api/predictions/${PRED_ID}/share`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    const data: PredictionShareMeta = res.body.data;
    expect(data.ogUrl).toContain(PRED_ID);
    expect(data.twitterCard).toBe("summary_large_image");
    expect(data.prediction.id).toBe(PRED_ID);
    expect(data.market.question).toBe(market.question);
  });

  it("returns 404 when prediction is not found", async () => {
    const app = makeApp(makeRepo({ prediction: null, market }));
    const res = await request(app).get(`/api/predictions/does-not-exist/share`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("does NOT require an Authorization header (public endpoint)", async () => {
    const app = makeApp(makeRepo({ prediction: pred, market }));
    const res = await request(app)
      .get(`/api/predictions/${PRED_ID}/share`);
    // No Authorization header set — must still return 200.
    expect(res.status).toBe(200);
  });

  it("responds correctly when appBaseUrl is customised", async () => {
    const app = makeApp(makeRepo({ prediction: pred, market }), "https://custom.example.com");
    const res = await request(app).get(`/api/predictions/${PRED_ID}/share`);

    expect(res.status).toBe(200);
    expect(res.body.data.ogUrl).toContain("https://custom.example.com");
    expect(res.body.data.ogImage).toContain("https://custom.example.com");
  });

  it("includes description with outcome and amount", async () => {
    const app = makeApp(makeRepo({ prediction: pred, market }));
    const res = await request(app).get(`/api/predictions/${PRED_ID}/share`);

    expect(res.status).toBe(200);
    // description should mention the predicted outcome
    expect(res.body.data.ogDescription).toContain("yes");
    // and a formatted XLM amount
    expect(res.body.data.ogDescription).toContain("XLM");
  });

  it("reflects resolved outcome in description for a resolved market", async () => {
    const wonPred = makePrediction({ result: "won" });
    const resolvedMarket = makeMarket({ status: "resolved", winningOutcome: "yes" });
    const app = makeApp(makeRepo({ prediction: wonPred, market: resolvedMarket }));
    const res = await request(app).get(`/api/predictions/${PRED_ID}/share`);

    expect(res.status).toBe(200);
    expect(res.body.data.ogDescription).toMatch(/resolved/);
    expect(res.body.data.ogTitle).toContain("🏆 Won");
  });

  it("returns 404 when market linked to prediction is missing", async () => {
    const app = makeApp(makeRepo({ prediction: pred, market: null }));
    const res = await request(app).get(`/api/predictions/${PRED_ID}/share`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 6. ShareNotFoundError shape
// ---------------------------------------------------------------------------

describe("ShareNotFoundError", () => {
  it("has status 404 and code 'not_found'", () => {
    const err = new ShareNotFoundError("pred-1");
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("pred-1");
    expect(err).toBeInstanceOf(Error);
  });
});
