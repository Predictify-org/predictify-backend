/**
 * Central OpenAPI registry.
 *
 * All public-route schemas are registered here so the spec is generated
 * entirely from Zod definitions — never hand-edited.
 */

import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ── Reusable component schemas ───────────────────────────────────────────────

const ErrorBody = registry.register(
  "ErrorBody",
  z
    .object({
      error: z.object({ code: z.string(), requestId: z.string().optional() }),
    })
    .openapi("ErrorBody"),
);

const ValidationErrorBody = registry.register(
  "ValidationErrorBody",
  z
    .object({
      error: z.object({ code: z.string(), details: z.any().optional() }),
    })
    .openapi("ValidationErrorBody"),
);

// ── Bearerauth security scheme ───────────────────────────────────────────────

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// ── /health ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Liveness check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": { schema: z.object({ status: z.literal("ok") }) },
      },
    },
  },
});

// ── /api/auth ────────────────────────────────────────────────────────────────

const ChallengeRequest = z
  .object({ stellarAddress: z.string() })
  .openapi("ChallengeRequest");
const ChallengeResponse = z
  .object({ nonce: z.string(), expiresAt: z.string().datetime() })
  .openapi("ChallengeResponse");

registry.registerPath({
  method: "post",
  path: "/api/auth/challenge",
  tags: ["Auth"],
  summary: "Request a sign-in challenge nonce",
  request: {
    body: { content: { "application/json": { schema: ChallengeRequest } } },
  },
  responses: {
    201: {
      description: "Challenge issued",
      content: { "application/json": { schema: ChallengeResponse } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
  },
});

const VerifyRequest = z
  .object({
    stellarAddress: z.string(),
    nonce: z.string(),
    signature: z.string(),
  })
  .openapi("VerifyRequest");
const TokenPair = z
  .object({ accessToken: z.string(), refreshToken: z.string() })
  .openapi("TokenPair");

registry.registerPath({
  method: "post",
  path: "/api/auth/verify",
  tags: ["Auth"],
  summary: "Verify challenge signature and obtain JWT",
  request: {
    body: { content: { "application/json": { schema: VerifyRequest } } },
  },
  responses: {
    200: {
      description: "Tokens issued",
      content: { "application/json": { schema: TokenPair } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Invalid signature",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

const RefreshRequest = z
  .object({ refreshToken: z.string().min(1) })
  .openapi("RefreshRequest");

registry.registerPath({
  method: "post",
  path: "/api/auth/refresh",
  tags: ["Auth"],
  summary: "Rotate a refresh token",
  request: {
    body: { content: { "application/json": { schema: RefreshRequest } } },
  },
  responses: {
    200: {
      description: "New token pair",
      content: { "application/json": { schema: TokenPair } },
    },
    400: {
      description: "Missing token",
      content: { "application/json": { schema: ErrorBody } },
    },
    401: {
      description: "Invalid token",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Reuse detected — family revoked",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  tags: ["Auth"],
  summary: "Revoke the entire refresh-token family",
  request: {
    body: { content: { "application/json": { schema: RefreshRequest } } },
  },
  responses: {
    204: { description: "Logged out" },
    400: {
      description: "Missing token",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/markets ─────────────────────────────────────────────────────────────

const Market = z
  .object({
    id: z.string().uuid(),
    question: z.string(),
    status: z.string(),
    metadata: z.any().optional(),
    version: z.number().int(),
    createdAt: z.string().datetime(),
  })
  .openapi("Market");

registry.registerPath({
  method: "get",
  path: "/api/markets",
  tags: ["Markets"],
  summary: "List all markets",
  responses: {
    200: {
      description: "Array of markets",
      content: {
        "application/json": { schema: z.object({ data: z.array(Market) }) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/markets/{id}",
  tags: ["Markets"],
  summary: "Get a market by ID",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Market",
      content: { "application/json": { schema: z.object({ data: Market }) } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

const PatchMarketRequest = z
  .object({
    question: z.string().optional(),
    metadata: z.any().optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .openapi("PatchMarketRequest");

registry.registerPath({
  method: "patch",
  path: "/api/markets/{id}",
  tags: ["Markets"],
  summary: "Update a market (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: PatchMarketRequest } } },
  },
  responses: {
    200: {
      description: "Updated market",
      content: { "application/json": { schema: z.object({ data: Market }) } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Version conflict",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/markets/{id}/disputes ───────────────────────────────────────────────

const OpenDisputeRequest = z
  .object({
    reason: z.string().min(10).max(500),
    evidenceUri: z.string().url().nullable().optional(),
  })
  .openapi("OpenDisputeRequest");

const Dispute = z
  .object({
    id: z.string().uuid(),
    marketId: z.string(),
    reason: z.string(),
    status: z.string(),
  })
  .openapi("Dispute");

registry.registerPath({
  method: "post",
  path: "/api/markets/{id}/disputes",
  tags: ["Disputes"],
  summary: "Open a dispute on a market",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: OpenDisputeRequest } } },
  },
  responses: {
    201: {
      description: "Dispute created",
      content: { "application/json": { schema: z.object({ data: Dispute }) } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/markets/{id}/events ─────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/markets/{id}/events",
  tags: ["Markets"],
  summary: "SSE stream of market events",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Server-Sent Events stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/users ───────────────────────────────────────────────────────────────

const PredictionStatus = z.enum([
  "pending",
  "confirmed",
  "won",
  "lost",
  "claimed",
]);

const Prediction = z
  .object({
    id: z.string().uuid(),
    marketId: z.string(),
    status: PredictionStatus,
    createdAt: z.string().datetime(),
  })
  .openapi("Prediction");

registry.registerPath({
  method: "get",
  path: "/api/users/{address}/predictions",
  tags: ["Users"],
  summary: "List predictions for a Stellar address",
  request: {
    params: z.object({ address: z.string() }),
    query: z.object({
      status: PredictionStatus.optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
  },
  responses: {
    200: {
      description: "Paginated predictions",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(Prediction),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid address",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/predictions ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/predictions",
  tags: ["Predictions"],
  summary: "Get predictions for the authenticated user",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Predictions list",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(Prediction), user: z.any() }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/leaderboard ─────────────────────────────────────────────────────────

const LeaderboardEntry = z
  .object({
    rank: z.number().int(),
    stellarAddress: z.string(),
    score: z.number(),
  })
  .openapi("LeaderboardEntry");

registry.registerPath({
  method: "get",
  path: "/api/leaderboard",
  tags: ["Leaderboard"],
  summary: "Get global leaderboard",
  request: {
    query: z.object({
      limit: z.coerce.number().int().positive().max(100).default(50),
      offset: z.coerce.number().int().nonnegative().default(0),
      refresh: z.coerce.boolean().default(false),
    }),
  },
  responses: {
    200: {
      description: "Leaderboard entries",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(LeaderboardEntry),
            meta: z.object({
              limit: z.number(),
              offset: z.number(),
              count: z.number(),
              refresh: z.boolean(),
            }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/leaderboard/user/{stellarAddress}",
  tags: ["Leaderboard"],
  summary: "Get leaderboard entry for a specific user",
  request: { params: z.object({ stellarAddress: z.string() }) },
  responses: {
    200: {
      description: "Entry",
      content: {
        "application/json": { schema: z.object({ data: LeaderboardEntry }) },
      },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/admin/users ─────────────────────────────────────────────────────────

const AdminUserView = z
  .object({
    address: z.string(),
    predictions: z.array(Prediction),
    disputes: z.array(Dispute),
  })
  .openapi("AdminUserView");

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{address}",
  tags: ["Admin"],
  summary: "Get aggregated user view (admin only)",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ address: z.string() }) },
  responses: {
    200: {
      description: "User view",
      content: {
        "application/json": { schema: z.object({ data: AdminUserView }) },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

const ReconciliationSidePosition = z
  .object({
    stellarAddress: z.string(),
    outcome: z.string(),
    amount: z.string(),
  })
  .openapi("ReconciliationSidePosition");

const ReconciliationDiffEntry = z
  .object({
    key: z.object({ stellarAddress: z.string(), outcome: z.string() }),
    dbAmount: z.string(),
    onChainAmount: z.string().nullable(),
    difference: z.string().nullable(),
    status: z.enum(["match", "mismatch", "missing_on_chain", "missing_in_db"]),
  })
  .openapi("ReconciliationDiffEntry");

const MarketReconciliation = z
  .object({
    marketId: z.string(),
    correlationId: z.string(),
    generatedAt: z.string().datetime(),
    status: z.enum(["ok", "partial"]),
    dbSnapshot: z.object({
      positions: z.array(ReconciliationSidePosition),
      totalAmount: z.string(),
    }),
    onChainSnapshot: z.object({
      positions: z.array(ReconciliationSidePosition),
      totalAmount: z.string(),
      available: z.boolean(),
      source: z.string(),
      unavailableReason: z.string().nullable(),
    }),
    summary: z.object({
      totalKeys: z.number().int(),
      matches: z.number().int(),
      mismatches: z.number().int(),
      missingOnChain: z.number().int(),
      missingInDb: z.number().int(),
    }),
    diffs: z.array(ReconciliationDiffEntry),
  })
  .openapi("MarketReconciliation");

registry.registerPath({
  method: "get",
  path: "/api/admin/recon/markets/{id}",
  tags: ["Admin"],
  summary: "Inspect DB vs on-chain reconciliation for a market",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: {
      description: "Structured reconciliation diff",
      content: {
        "application/json": {
          schema: z.object({ data: MarketReconciliation }),
        },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    500: {
      description: "Internal error",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});
