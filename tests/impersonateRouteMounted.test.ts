/**
 * impersonateRouteMounted.test.ts
 *
 * Guards the wiring of POST /api/admin/users/:address/impersonate into the
 * composed application.
 *
 * The impersonate router existed and was fully unit-tested, but was never
 * mounted in src/index.ts — so the endpoint returned 404 in the real app and
 * the circuit breaker protecting it was unreachable. Suite-local Express apps
 * (as used by the other impersonate tests) cannot catch that class of bug, so
 * these tests exercise `createApp()` itself.
 *
 * Mocks below stand in for external infrastructure so `createApp()` can be
 * built without a live Postgres/Redis. `src/routes/users` is additionally
 * stubbed because it currently throws at import time on main (a botched merge
 * left orphaned code referencing an unimported `z`), which would otherwise
 * prevent this suite from loading for reasons unrelated to the route wiring.
 */

jest.mock("../src/db/client", () => ({ db: {} }));
jest.mock("../src/queue", () => ({
  redisConnection: { on: jest.fn() },
  webhookQueue: { add: jest.fn() },
  backupVerificationQueue: { add: jest.fn() },
  reconciliationQueue: { add: jest.fn() },
  marketResolutionQueue: { add: jest.fn() },
}));
jest.mock("../src/routes/users", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Router } = require("express");
  return { usersRouter: Router() };
});

import request from "supertest";
import { createApp } from "../src/index";

const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";
const IMPERSONATE_PATH = `/api/admin/users/${USER_ADDRESS}/impersonate`;

describe("POST /api/admin/users/:address/impersonate — mounted in createApp", () => {
  it("is routed by the composed app (403 from the admin guard, not 404)", async () => {
    const res = await request(createApp()).post(IMPERSONATE_PATH).send({});

    // A 404 here would mean the router is not mounted at all. Reaching the
    // admin guard proves the route is wired up.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(403);
  });

  it("does not answer sibling /api/admin/users routes", async () => {
    // The impersonate router is mounted on the shared /api/admin/users prefix
    // ahead of the user-read and notes routers. Its rate limit and admin guard
    // are attached to its own route only, so a request for a sibling path must
    // pass through untouched to be handled by a later mount — in particular it
    // must not be answered by the impersonate handler.
    const res = await request(createApp())
      .post(`/api/admin/users/${USER_ADDRESS}/notes`)
      .send({});

    expect(res.status).not.toBe(404);
  });
});
