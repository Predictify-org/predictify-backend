import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../../middleware/requireAdmin";
import { db } from "../../db";
import { markets, marketAuditLog } from "../../db/schema";
import { RouteErrorFactory } from "../../errors";
import { logger } from "../../config/logger";
import { getCorrelationId } from "../../middleware/correlation";

const bodySchema = z.object({
  winningOutcome: z.string().min(1, "winningOutcome is required"),
});

export const forceResolveRouter = Router();

forceResolveRouter.use(requireAdmin);

forceResolveRouter.post("/:id", async (req, res, next) => {
  try {
    const correlationId = getCorrelationId() ?? "unknown";

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw RouteErrorFactory.validation("Invalid request body", {
        winningOutcome: parsed.error.flatten().fieldErrors.winningOutcome ?? [],
      });
    }

    const { winningOutcome } = parsed.data;
    const marketId = req.params.id;
    const adminAddress = req.adminAddress;

    if (!adminAddress) {
      throw RouteErrorFactory.unauthorized("Authentication required");
    }

    const [market] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);

    if (!market) {
      throw RouteErrorFactory.notFound("Market not found");
    }

    if (market.forceFinalized || market.status === "resolved") {
      throw RouteErrorFactory.conflict("Market already resolved");
    }

    if (new Date() < new Date(market.resolutionTime)) {
      throw RouteErrorFactory.validation(
        "Market has not yet reached its resolution deadline",
      );
    }

    await db.transaction(async (tx) => {
      const beforeState = {
        status: market.status,
        winningOutcome: market.winningOutcome,
        forceFinalized: market.forceFinalized,
        version: market.version,
      };

      await tx
        .update(markets)
        .set({
          status: "resolved",
          winningOutcome,
          forceFinalized: true,
          version: market.version + 1,
        })
        .where(eq(markets.id, marketId));

      await tx.insert(marketAuditLog).values({
        marketId,
        adminAddress,
        action: "force_resolve",
        beforeState,
        afterState: {
          status: "resolved",
          winningOutcome,
          forceFinalized: true,
          version: market.version + 1,
        },
      });
    });

    logger.info(
      { marketId, winningOutcome, adminAddress, correlationId },
      "admin_force_resolve: market resolved",
    );

    res.status(200).json({
      data: {
        marketId,
        winningOutcome,
        forceResolved: true,
      },
    });
  } catch (e: unknown) {
    next(e);
  }
});
