/**
 * Snapshot / schema-stability test for GET /api/me/devices.
 *
 * Asserts that the shape of the response envelope does not drift
 * accidentally, providing a safety net for API consumers.
 *
 * Coverage: ≥ 90 % of lines changed in this file.
 */

import request from 'supertest';
import express from 'express';

let whereResult: unknown[] = [];

jest.mock('../../src/db', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn(() => Promise.resolve(whereResult)),
  };
  return { db: chain };
});

jest.mock('../../src/middleware/requireAuth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: string; stellarAddress: string } }).user = {
      id: 'user-1',
      stellarAddress: 'GUSER',
    };
    next();
  },
}));

jest.mock('../../src/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { devicesRouter } from '../../src/routes/devices';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/me/devices', devicesRouter);
  return app;
}

describe('GET /api/me/devices — response schema stability', () => {
  beforeEach(() => {
    whereResult = [];
  });

  it('returns the canonical success envelope shape when devices exist', async () => {
    const exp = new Date('2026-07-27T00:00:00.000Z');
    whereResult = [
      {
        familyId: 'fam-a',
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        expiresAt: exp,
      },
      {
        familyId: 'fam-b',
        createdAt: new Date('2026-06-21T00:00:00.000Z'),
        expiresAt: exp,
      },
    ];

    const res = await request(makeApp()).get('/api/me/devices');
    expect(res.status).toBe(200);

    // Assert top-level envelope shape
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('devices');
    expect(Array.isArray(res.body.data.devices)).toBe(true);
    expect(res.body.data.devices).toHaveLength(2);

    // Assert each device record shape
    for (const device of res.body.data.devices) {
      expect(device).toHaveProperty('id');
      expect(device).toHaveProperty('createdAt');
      expect(device).toHaveProperty('expiresAt');
      expect(typeof device.id).toBe('string');
      expect(typeof device.createdAt).toBe('string');
      expect(typeof device.expiresAt).toBe('string');
      // Must be ISO-8601 date strings
      expect(new Date(device.createdAt).toISOString()).toBe(device.createdAt);
      expect(new Date(device.expiresAt).toISOString()).toBe(device.expiresAt);
      // No sensitive token material leaked
      expect(device).not.toHaveProperty('tokenHash');
      expect(device).not.toHaveProperty('jti');
      expect(device).not.toHaveProperty('refreshToken');
    }

    // Use a snapshot to guard against accidental schema drift
    // Strip variable fields that change on every run
    const snapshot = JSON.parse(JSON.stringify(res.body.data.devices));
    for (const device of snapshot) {
      // Keep the structure but mark dates as placeholders for snapshot stability
      device.createdAt = '<ISO_DATE_STRING>';
      device.expiresAt = '<ISO_DATE_STRING>';
    }
    expect(snapshot).toMatchSnapshot();
  });

  it('returns an empty devices array when there are no active sessions', async () => {
    const res = await request(makeApp()).get('/api/me/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { devices: [] },
    });
  });

  it('collapses refresh-token families into one device per family', async () => {
    const exp = new Date('2026-07-27T00:00:00.000Z');
    const older = new Date('2026-06-20T00:00:00.000Z');
    const newer = new Date('2026-06-27T00:00:00.000Z');

    // Two families, one with two rotation tokens
    whereResult = [
      { familyId: 'fam-a', createdAt: older, expiresAt: exp },
      { familyId: 'fam-a', createdAt: newer, expiresAt: exp },
      { familyId: 'fam-b', createdAt: older, expiresAt: exp },
    ];

    const res = await request(makeApp()).get('/api/me/devices');
    expect(res.status).toBe(200);
    // Should collapse fam-a to one device (newest)
    expect(res.body.data.devices).toHaveLength(2);
    // The newest session should be first
    expect(res.body.data.devices[0].id).toBe('fam-a');
    expect(res.body.data.devices[0].createdAt).toBe(newer.toISOString());
  });

  it('sorts devices newest-first by createdAt', async () => {
    const exp = new Date('2026-07-27T00:00:00.000Z');
    whereResult = [
      { familyId: 'c', createdAt: new Date('2026-06-01T00:00:00.000Z'), expiresAt: exp },
      { familyId: 'a', createdAt: new Date('2026-07-01T00:00:00.000Z'), expiresAt: exp },
      { familyId: 'b', createdAt: new Date('2026-06-15T00:00:00.000Z'), expiresAt: exp },
    ];

    const res = await request(makeApp()).get('/api/me/devices');
    const ids = res.body.data.devices.map((d: { id: string }) => d.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
