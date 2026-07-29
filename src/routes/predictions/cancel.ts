import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { db } from '../../db';
import { predictions, users } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../config/logger';

const router = Router();

/**
 * POST /api/predictions/:id/cancel
 * Cancel an unresolved prediction and refund stake
 */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || 'unknown';
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // 1. Find the prediction
    const prediction = await db.query.predictions.findFirst({
      where: and(
        eq(predictions.id, parseInt(id, 10)),
        eq(predictions.userId, userId)
      ),
      with: {
        market: true
      }
    });

    if (!prediction) {
      return res.status(404).json({
        error: 'Prediction not found',
        message: 'No prediction found with this ID'
      });
    }

    // 2. Validate market status
    if (prediction.market.status === 'settled') {
      return res.status(400).json({
        error: 'Market already settled',
        message: 'Cannot cancel prediction on a settled market'
      });
    }

    if (prediction.market.status === 'cancelled') {
      return res.status(400).json({
        error: 'Market already cancelled',
        message: 'Cannot cancel prediction on a cancelled market'
      });
    }

    // 3. Validate prediction status
    if (prediction.status === 'cancelled') {
      return res.status(400).json({
        error: 'Already cancelled',
        message: 'This prediction has already been cancelled'
      });
    }

    // 4. Process refund (immediate balance update)
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User associated with this prediction not found'
      });
    }

    // Start transaction
    await db.transaction(async (tx) => {
      // Update prediction status
      await tx
        .update(predictions)
        .set({
          status: 'cancelled',
          cancelledAt: new Date()
        })
        .where(eq(predictions.id, prediction.id));

      // Refund stake to user's balance
      await tx
        .update(users)
        .set({
          balance: user.balance + prediction.stake
        })
        .where(eq(users.id, userId));
    });

    logger.info('Prediction cancelled and refunded', {
      correlationId,
      predictionId: prediction.id,
      userId: userId,
      stake: prediction.stake
    });

    return res.status(200).json({
      message: 'Prediction cancelled and stake refunded',
      prediction: {
        id: prediction.id,
        status: 'cancelled',
        cancelledAt: new Date(),
        refundAmount: prediction.stake
      }
    });

  } catch (error) {
    logger.error('Error cancelling prediction', {
      correlationId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to cancel prediction'
    });
  }
});

export default router;
