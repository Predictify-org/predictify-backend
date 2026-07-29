import request from 'supertest';
import app from '../../../src/app';
import { db } from '../../../src/db';
import { users, markets, predictions } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';

describe('POST /api/predictions/:id/cancel', () => {
  let token: string;
  let userId: number;
  let marketId: number;
  let predictionId: number;

  beforeEach(async () => {
    // Create test user
    const [user] = await db.insert(users).values({
      email: 'test@example.com',
      balance: 1000,
      password: 'hashed'
    }).returning();
    userId = user.id;

    // Create test market
    const [market] = await db.insert(markets).values({
      question: 'Will it rain?',
      status: 'open'
    }).returning();
    marketId = market.id;

    // Create test prediction
    const [prediction] = await db.insert(predictions).values({
      userId: userId,
      marketId: marketId,
      outcome: 'yes',
      stake: 100,
      status: 'pending'
    }).returning();
    predictionId = prediction.id;

    token = 'test-token'; // Replace with actual token generation
  });

  it('should cancel prediction and refund stake', async () => {
    const response = await request(app)
      .post(`/api/predictions/${predictionId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.message).toBe('Prediction cancelled and stake refunded');
    expect(response.body.prediction.status).toBe('cancelled');
    expect(response.body.prediction.refundAmount).toBe(100);
  });

  it('should return 404 for non-existent prediction', async () => {
    await request(app)
      .post('/api/predictions/99999/cancel')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('should return 400 if market is settled', async () => {
    await db.update(markets)
      .set({ status: 'settled' })
      .where(eq(markets.id, marketId));

    await request(app)
      .post(`/api/predictions/${predictionId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('should return 400 if prediction already cancelled', async () => {
    await db.update(predictions)
      .set({ status: 'cancelled' })
      .where(eq(predictions.id, predictionId));

    await request(app)
      .post(`/api/predictions/${predictionId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('should return 401 without authentication', async () => {
    await request(app)
      .post(`/api/predictions/${predictionId}/cancel`)
      .expect(401);
  });
});