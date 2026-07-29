import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { predictions, markets } from "../../db/schema";
import { logger } from "../../config/logger";
import { RouteErrorFactory } from "../../errors";

export interface PredictionShareMeta {
  ogUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterCard: "summary_large_image";
  prediction: {
    id: string;
    outcome: string;
    amount: string;
    result: string | null;
    createdAt: string;
  };
  market: {
    id: string;
    question: string;
    status: string;
    winningOutcome: string | null;
    resolutionTime: string;
  };
}

export interface ShareRepo {
  findPredictionWithMarket(
    predictionId: string,
  ): Promise<{ prediction: typeof predictions.$inferSelect; market: typeof markets.$inferSelect } | null>;
}

export class DrizzleShareRepo implements ShareRepo {
  async findPredictionWithMarket(predictionId: string) {
    const [prediction] = await db
      .select()
      .from(predictions)
      .where(eq(predictions.id, predictionId))
      .limit(1);

    if (!prediction) return null;

    const [market] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, prediction.marketId))
      .limit(1);

    if (!market) return null;

    return { prediction, market };
  }
}

export async function getPredictionShareMeta(
  predictionId: string,
  appBaseUrl: string,
  repo: ShareRepo = new DrizzleShareRepo(),
): Promise<PredictionShareMeta> {
  const row = await repo.findPredictionWithMarket(predictionId);

  if (!row) {
    throw new ShareNotFoundError(predictionId);
  }

  const { prediction, market } = row;

  const resultLabel = buildResultLabel(prediction.result);
  const outcomeLabel = prediction.outcome;
  const amountXLM = formatAmount(prediction.amount);

  const ogTitle = `${resultLabel} "${market.question}"`;

  const ogDescription =
    `Predicted "${outcomeLabel}" · ${amountXLM} · ` +
    buildStatusFragment(market.status, market.winningOutcome, market.resolutionTime);

  const metadataImage =
    market.metadata && typeof market.metadata === "object"
      ? (market.metadata as Record<string, unknown>).ogImage
      : undefined;

  const ogImage =
    typeof metadataImage === "string" && metadataImage.startsWith("https://")
      ? metadataImage
      : `${appBaseUrl}/og/default.png`;

  return {
    ogUrl: `${appBaseUrl}/predictions/${predictionId}`,
    ogTitle,
    ogDescription,
    ogImage,
    twitterCard: "summary_large_image",
    prediction: {
      id: prediction.id,
      outcome: prediction.outcome,
      amount: prediction.amount,
      result: prediction.result,
      createdAt: new Date(prediction.createdAt).toISOString(),
    },
    market: {
      id: market.id,
      question: market.question,
      status: market.status,
      winningOutcome: market.winningOutcome,
      resolutionTime: new Date(market.resolutionTime).toISOString(),
    },
  };
}

export function formatAmount(raw: string): string {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return `${raw} XLM`;
  const xlm = (n / 10_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 7,
  });
  return `${xlm} XLM`;
}

export function buildResultLabel(result: string | null): string {
  switch (result) {
    case "won":
      return "Won";
    case "lost":
      return "Lost";
    default:
      return "Predicted on";
  }
}

export function buildStatusFragment(
  status: string,
  winningOutcome: string | null,
  resolutionTime: string | Date,
): string {
  if (status === "resolved" && winningOutcome) {
    return `resolved → "${winningOutcome}"`;
  }
  if (status === "disputed") {
    return "under dispute";
  }
  const resolveDate = new Date(resolutionTime);
  const now = new Date();
  if (resolveDate > now) {
    return `resolves ${resolveDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return "pending resolution";
}

export class ShareNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";

  constructor(predictionId: string) {
    super(`Prediction "${predictionId}" not found`);
    this.name = "ShareNotFoundError";
  }
}

export interface ShareRouteDeps {
  repo?: ShareRepo;
  appBaseUrl?: string;
}

export function createShareRouter(deps: ShareRouteDeps = {}): Router {
  const router = Router({ mergeParams: true });

  const appBaseUrl =
    deps.appBaseUrl ??
    (process.env.APP_BASE_URL || "https://app.predictify.io");

  const repo = deps.repo ?? new DrizzleShareRepo();

  router.get("/:id/share", async (req, res, next) => {
    const { id } = req.params;
    const reqId = String((req as unknown as Record<string, unknown>).id ?? "anon");

    if (!id || typeof id !== "string") {
      throw RouteErrorFactory.badRequest("Prediction ID is required");
    }

    try {
      const meta = await getPredictionShareMeta(id, appBaseUrl, repo);
      logger.debug({ reqId, predictionId: id }, "prediction.share.fetched");
      return res.status(200).json({ data: meta });
    } catch (err) {
      if (err instanceof ShareNotFoundError) {
        throw RouteErrorFactory.notFound(err.message);
      }
      next(err);
      return;
    }
  });

  return router;
}
