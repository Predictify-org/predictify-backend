import { Router } from "express";
import {
  listMarkets,
  listUpcomingMarkets,
  getMarketById,
  updateMarket,
  createMarket,
  VersionConflictError,
  MarketAlreadyExistsError,
} from "../../services/marketService";
import { searchMarkets } from "../../repositories/marketRepository";
import { requireAdmin, AuthenticatedRequest } from "../../middleware/auth";
import { rateLimitAnon } from "../../middleware/rateLimitAnon";
import { accessLog } from "../../middleware/accessLog";
import { marketsCors } from "../../middleware/cors";
import { listFeaturedMarkets } from "../../services/marketFeatureService";
import { logger } from "../../config/logger";
import { RouteErrorFactory } from "../../errors";
import { conditionalGet } from "../../middleware/etag";
import { marketsMetricsMiddleware } from "../../metrics/marketsMetrics";
import { recommendationsRouter } from "./recommendations";
import { trendingRouter } from "./trending";
import { tagsRouter } from "./tags";
import { predictionCountRouter } from "./prediction-count";
import { watchersRouter } from "./watchers";
import { marketAuditRouter } from "../marketAudit";
import { disputesRouter } from "../disputes";
import { predictionsRouter } from "../predictions";
import { requestTimeout } from "../../middleware/timeout";
import {
  listMarketsQuerySchema,
  searchMarketsQuerySchema,
  featuredMarketsQuerySchema,
  upcomingMarketsQuerySchema,
  marketParamsSchema,
  patchMarketBodySchema,
  createMarketBodySchema,
} from "../../validators/markets";

export const marketsRouter = Router();

// Enforce CORS allowlist early so unapproved origins are rejected
// before any processing (preflight responses cached via Access-Control-Max-Age).
marketsRouter.use(marketsCors());
marketsRouter.use(accessLog);
marketsRouter.use(marketsMetricsMiddleware);
marketsRouter.use(rateLimitAnon);
marketsRouter.use(requestTimeout(10000));
marketsRouter.use("/tags", tagsRouter);
marketsRouter.use("/recommendations", recommendationsRouter);
marketsRouter.use("/trending", trendingRouter);
marketsRouter.use("/:id/recommendations", recommendationsRouter);
marketsRouter.use("/:id/prediction-count", predictionCountRouter);
marketsRouter.use("/:id/watchers", watchersRouter);
marketsRouter.use("/:id/audit", marketAuditRouter);
marketsRouter.use("/:id/disputes", disputesRouter);
marketsRouter.use("/", predictionsRouter);

marketsRouter.get("/search", async (req, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  try {
    const parsed = searchMarketsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { q, limit, offset: queryOffset, page: queryPage } = parsed.data;

    const offset =
      queryOffset !== undefined
        ? queryOffset
        : queryPage && queryPage > 1
          ? (queryPage - 1) * limit
          : 0;
    const page = queryPage ?? Math.floor(offset / limit) + 1;

    logger.info(
      { reqId, correlationId: reqId, query: q, limit, offset },
      "markets_search_executed",
    );

    const result = await searchMarkets({ query: q, limit, offset });

    const payload = {
      data: result.data,
      total: result.total,
      limit,
      offset,
      page,
      fallback: result.fallback,
      pagination: {
        limit,
        offset,
        page,
        total: result.total,
        fallback: result.fallback,
      },
      meta: {
        limit,
        offset,
        page,
        total: result.total,
        fallback: result.fallback,
      },
    };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    return res.status(200).json(payload);
  } catch (err) {
    logger.error({ reqId, correlationId: reqId, err }, "markets_search_failed");
    return next(err);
  }
});

marketsRouter.get("/", async (req, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  try {
    const parsed = listMarketsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { limit, cursor, status, category, tag, sort, order } = parsed.data;

    logger.debug(
      { reqId, correlationId: reqId, limit, hasCursor: !!cursor, status, category, tag, sort, order },
      "markets_list_fetching",
    );

    const page = await listMarkets({ limit, cursor });
    const payload = { data: page.data, nextCursor: page.nextCursor };

    const etagHandled = conditionalGet(payload, req, res);
    if (etagHandled) {
      return;
    }

    logger.info(
      { reqId, correlationId: reqId, count: page.data.length, hasNext: !!page.nextCursor },
      "markets_list_success",
    );
    return res.status(200).json(payload);
  } catch (e) {
    logger.error(
      { reqId, correlationId: reqId, err: e },
      "markets_list_failed",
    );
    return next(e);
  }
});

marketsRouter.get("/featured", async (req, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  try {
    const parsed = featuredMarketsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { limit } = parsed.data;
    const data = await listFeaturedMarkets(limit);
    const payload = { data };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    return res.json(payload);
  } catch (e) {
    logger.error({ reqId, correlationId: reqId, err: e }, "markets_featured_failed");
    return next(e);
  }
});

marketsRouter.get("/upcoming", async (req, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  try {
    const parsed = upcomingMarketsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { limit } = parsed.data;
    const data = await listUpcomingMarkets({ limit });
    const payload = { data };

    if (conditionalGet(payload, req, res)) {
      return;
    }

    logger.info(
      { reqId, correlationId: reqId, count: data.length },
      "markets_upcoming_listed",
    );
    return res.json(payload);
  } catch (err) {
    logger.error(
      { reqId, correlationId: reqId, err },
      "markets_upcoming_failed",
    );
    return next(err);
  }
});

marketsRouter.get("/:id", async (req, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");

  try {
    const parsedParams = marketParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      throw parsedParams.error;
    }

    const { id: marketId } = parsedParams.data;

    logger.debug(
      { reqId, correlationId: reqId, marketId },
      "markets_get_fetching",
    );
    const market = await getMarketById(marketId);

    if (!market) {
      throw RouteErrorFactory.notFound(`Market with ID ${marketId} not found`);
    }

    logger.info(
      { reqId, correlationId: reqId, marketId },
      "markets_get_success",
    );

    const responsePayload = { data: market };
    if (conditionalGet(responsePayload, req, res)) {
      return;
    }

    return res.json(responsePayload);
  } catch (e) {
    logger.error(
      { reqId, correlationId: reqId, marketId: req.params.id, err: e },
      "markets_get_failed",
    );
    return next(e);
  }
});

marketsRouter.patch("/:id", requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  const adminAddress = req.user?.stellarAddress;

  try {
    const parsedParams = marketParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      throw parsedParams.error;
    }

    const { id: marketId } = parsedParams.data;

    const parsedBody = patchMarketBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw parsedBody.error;
    }

    const { question, metadata, expectedVersion } = parsedBody.data;

    const patch: { question?: string; metadata?: Record<string, unknown> } = {};
    if (question !== undefined) patch.question = question;
    if (metadata !== undefined) patch.metadata = metadata;

    logger.info(
      {
        reqId,
        correlationId: reqId,
        marketId,
        patch,
        expectedVersion,
        adminAddress,
      },
      "markets_patch_attempt",
    );

    const updated = await updateMarket(marketId, patch, expectedVersion);

    logger.info(
      {
        reqId,
        correlationId: reqId,
        marketId,
        adminAddress,
        newVersion: updated.version,
      },
      "markets_patch_success",
    );
    return res.status(200).json({ data: updated });
  } catch (e) {
    if (e instanceof VersionConflictError) {
      logger.warn({ reqId, correlationId: reqId, marketId: req.params.id, adminAddress }, "markets_patch_version_conflict");
      throw RouteErrorFactory.conflict("Market has been modified by another request. Please refresh and try again.");
    }

    if ((e as { status?: number })?.status === 404) {
      logger.warn({ reqId, correlationId: reqId, marketId: req.params.id, adminAddress }, "markets_patch_not_found");
      throw RouteErrorFactory.notFound(`Market with ID ${req.params.id} not found`);
    }

    logger.error(
      { reqId, correlationId: reqId, marketId: req.params.id, adminAddress, err: e },
      "markets_patch_failed",
    );
    return next(e);
  }
});

/**
 * POST /api/markets — Create an off-chain market shell
 *
 * Admin-only endpoint. Creates a new market with canonical question, metadata, and resolution time.
 * Markets are keyed by the on-chain ID supplied by the contract deployer.
 * On creation, markets are assigned indexedLedger=0 and archived=false.
 *
 * Returns 201 with the created market.
 * Returns 409 with error.code="market_exists" if the market ID is already in use.
 * Returns 403 with error.code="forbidden" if the user is not an authorized admin.
 */
marketsRouter.post("/", requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  const adminAddress = req.user?.stellarAddress;

  try {
    const parsedBody = createMarketBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw parsedBody.error;
    }

    const { id, question, resolutionTime, metadata } = parsedBody.data;

    logger.info(
      {
        reqId,
        correlationId: reqId,
        marketId: id,
        adminAddress,
      },
      "markets_create_attempt",
    );

    const created = await createMarket({
      id,
      question,
      resolutionTime,
      metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
      adminAddress,
    });

    logger.info(
      {
        reqId,
        correlationId: reqId,
        marketId: id,
        adminAddress,
        version: created.version,
        indexedLedger: created.indexedLedger,
      },
      "markets_create_success",
    );

    return res.status(201).json({ data: created });
  } catch (e) {
    if (e instanceof MarketAlreadyExistsError) {
      logger.warn(
        { reqId, correlationId: reqId, marketId: req.body?.id, adminAddress },
        "markets_create_conflict",
      );
      return res.status(409).json({ error: { code: "market_exists" } });
    }

    logger.error(
      { reqId, correlationId: reqId, marketId: req.body?.id, adminAddress, err: e },
      "markets_create_failed",
    );
    return next(e);
  }
});
