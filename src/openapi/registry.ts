import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { recommendationsQuerySchema } from "../validators/markets";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ── Reusable component schemas ───────────────────────────────────────────────

/**
 * Shared header schema for endpoints that accept an Idempotency-Key.
 * Detects duplicate submissions so the client can safely retry on network errors.
 */
const IdempotencyKeyHeader = z.object({
  "Idempotency-Key": z.string().min(1).max(255).openapi({
    description: "Unique idempotency key for safe retries. See RFC 7231 §6.3.2.",
  }),
});

export const ErrorBody = registry.register(
  "ErrorBody",
  z
    .object({
      error: z.object({ code: z.string(), requestId: z.string().optional() }),
    })
    .openapi("ErrorBody"),
);

export const ValidationErrorBody = registry.register(
  "ValidationErrorBody",
  z
    .object({
      error: z.object({ code: z.string(), details: z.any().optional() }),
    })
    .openapi("ValidationErrorBody"),
);

// ── Bearer auth security scheme ──────────────────────────────────────────────

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// ── /health ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/health",
  operationId: "healthCheck",
  tags: ["Health"],
  summary: "Liveness check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok") }),
        },
      },
    },
  },
});

// ── /healthz/dependencies ────────────────────────────────────────────────────

const DependencyHealth = z
  .object({
    status: z.enum(["ok", "degraded", "down"]),
    correlationId: z.string(),
    checkedAt: z.string().datetime(),
    dependencies: z.record(
      z.object({
        status: z.enum(["ok", "degraded", "down"]),
        latencyMs: z.number().optional(),
        error: z.string().optional(),
      }),
    ),
  })
  .openapi("DependencyHealth");

registry.registerPath({
  method: "get",
  path: "/healthz/dependencies",
  operationId: "healthDependencies",
  tags: ["Health"],
  summary: "External dependency health probes",
  responses: {
    200: {
      description: "All dependencies healthy",
      content: { "application/json": { schema: DependencyHealth } },
    },
    207: { description: "Some dependencies degraded" },
    503: { description: "One or more dependencies down" },
  },
});

// ── /api/users/health ────────────────────────────────────────────────────

const UsersHealthResponse = z
  .object({
    status: z.enum(["ok", "down"]),
    correlationId: z.string(),
    checkedAt: z.string().datetime(),
    dependencies: z.object({
      database: z.object({
        status: z.enum(["ok", "down"]),
        latencyMs: z.number(),
        error: z.string().optional(),
      }),
    }),
  })
  .openapi("UsersHealthResponse");

registry.registerPath({
  method: "get",
  path: "/api/users/health",
  operationId: "usersHealth",
  tags: ["Health"],
  summary: "User-facing dependency health probe",
  responses: {
    200: {
      description: "User service dependencies are healthy",
      content: { "application/json": { schema: UsersHealthResponse } },
    },
    503: {
      description: "User service dependency probe failed",
      content: { "application/json": { schema: UsersHealthResponse } },
    },
  },
});

// ── /metrics ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/metrics",
  operationId: "getMetrics",
  tags: ["Monitoring"],
  summary: "Prometheus metrics endpoint",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Prometheus text format metrics",
      content: { "text/plain": { schema: z.string() } },
    },
    401: {
      description: "Unauthorized (if METRICS_AUTH_TOKEN is set)",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /.well-known/jwks.json ───────────────────────────────────────────────────

const JwkKey = z
  .object({
    kid: z.string(),
    alg: z.literal("HS256"),
    kty: z.literal("oct"),
    use: z.literal("sig"),
  })
  .openapi("JwkKey");

const JwksResponse = z
  .object({
    keys: z.array(JwkKey),
  })
  .openapi("JwksResponse");

registry.registerPath({
  method: "get",
  path: "/.well-known/jwks.json",
  operationId: "getJwks",
  tags: ["JWKS"],
  summary: "JSON Web Key Set endpoint",
  description:
    "Returns the JSON Web Key Set containing metadata for all available JWT signing keys. " +
    "Follows RFC 7517 (JWK) and RFC 7513 (JWKS) where applicable, adapted for HMAC-based signing (HS256). " +
    "The actual secret values are never exposed - only key metadata is returned.",
  responses: {
    200: {
      description: "JWKS response with key metadata",
      content: { "application/json": { schema: JwksResponse } },
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
  operationId: "authChallenge",
  tags: ["Auth"],
  summary: "Request a sign-in challenge nonce",
  request: {
    headers: IdempotencyKeyHeader,
    body: {
      content: {
        "application/json": {
          schema: ChallengeRequest,
          examples: {
            challengeRequest: {
              value: {
                stellarAddress: "GABC1234567890DEFGHIJKLMNOPQRSTUVWX",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Challenge issued",
      content: {
        "application/json": {
          schema: ChallengeResponse,
          examples: {
            challengeIssued: {
              value: {
                nonce: "challenge-nonce-001",
                expiresAt: "2026-07-25T12:00:00.000Z",
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    409: {
      description: "Idempotency key conflict",
      content: { "application/json": { schema: ErrorBody } },
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
  operationId: "authVerify",
  tags: ["Auth"],
  summary: "Verify challenge signature and obtain JWT",
  request: {
    headers: IdempotencyKeyHeader,
    body: {
      content: {
        "application/json": {
          schema: VerifyRequest,
          examples: {
            verifyRequest: {
              value: {
                stellarAddress: "GABC1234567890DEFGHIJKLMNOPQRSTUVWX",
                nonce: "challenge-nonce-001",
                signature: "ed25519-signature-hex",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tokens issued",
      content: {
        "application/json": {
          schema: TokenPair,
          examples: {
            tokensIssued: {
              value: {
                accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnb29nbGUtdXNlcjEifQ.signature",
                refreshToken: "refresh-token-001",
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Invalid signature",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Idempotency key conflict",
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
  operationId: "authRefresh",
  tags: ["Auth"],
  summary: "Rotate a refresh token",
  request: {
    headers: IdempotencyKeyHeader,
    body: {
      content: {
        "application/json": {
          schema: RefreshRequest,
          examples: {
            refreshTokenRequest: {
              value: {
                refreshToken: "refresh-token-001",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "New token pair",
      content: {
        "application/json": {
          schema: TokenPair,
          examples: {
            refreshedTokens: {
              value: {
                accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnb29nbGUtdXNlcjEifQ.signature",
                refreshToken: "refresh-token-002",
              },
            },
          },
        },
      },
    },
    400: {
      description: "Missing token",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Idempotency key conflict",
      content: { "application/json": { schema: ErrorBody } },
    },
    401: {
      description: "Invalid token",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Reuse detected — family revoked",
      description: "Reuse detected \u2014 family revoked",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  operationId: "authLogout",
  tags: ["Auth"],
  summary: "Revoke the entire refresh-token family",
  request: {
    headers: IdempotencyKeyHeader,
    body: {
      content: {
        "application/json": {
          schema: RefreshRequest,
          examples: {
            logoutRequest: {
              value: {
                refreshToken: "refresh-token-001",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    204: { description: "Logged out" },
    400: {
      description: "Missing token",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Idempotency key conflict",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/wallet/logout",
  operationId: "authWalletLogout",
  tags: ["Auth"],
  summary: "Revoke the entire refresh-token family for wallet logout",
  request: {
    headers: IdempotencyKeyHeader,
    body: {
      content: {
        "application/json": {
          schema: RefreshRequest,
          examples: {
            walletLogoutRequest: {
              value: {
                refreshToken: "refresh-token-001",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    204: { description: "Wallet logged out" },
    400: {
      description: "Missing token",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Idempotency key conflict",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── GET /api/auth/health ────────────────────────────────────────────────────

const AuthHealthResponse = z
  .object({
    status: z.enum(["ok", "down"]),
    correlationId: z.string(),
    checkedAt: z.string().datetime(),
    dependencies: z.object({
      database: z.object({
        status: z.enum(["ok", "down"]),
        latencyMs: z.number(),
        error: z.string().optional(),
      }),
    }),
  })
  .openapi("AuthHealthResponse");

registry.registerPath({
  method: "get",
  path: "/api/auth/health",
  operationId: "authHealth",
  tags: ["Health"],
  summary: "Health probe for /api/auth dependencies",
  description:
    "Probes the Postgres database used by auth operations (challenge store, " +
    "refresh-token store). No authentication required.",
  responses: {
    200: {
      description: "Auth service dependencies are healthy",
      content: { "application/json": { schema: AuthHealthResponse } },
    },
    503: {
      description: "Database probe failed",
      content: { "application/json": { schema: AuthHealthResponse } },
    },
  },
});

// ── /api/health/version ──────────────────────────────────────────────────────

const HealthVersionResponse = z
  .object({
    version: z.string(),
    commitSha: z.string(),
    correlationId: z.string(),
    checkedAt: z.string().datetime(),
  })
  .openapi("HealthVersionResponse");

registry.registerPath({
  method: "get",
  path: "/api/health/version",
  operationId: "healthVersion",
  tags: ["Health"],
  summary: "Application version and build info",
  description:
    "Returns the application version (from package.json) and the current Git " +
    "commit SHA (from GIT_COMMIT_SHA or VERCEL_GIT_COMMIT_SHA env vars, " +
    "falling back to 'unknown'). No authentication required.",
  responses: {
    200: {
      description: "Version information",
      content: { "application/json": { schema: HealthVersionResponse } },
    },
  },
});

// ── /api/markets ─────────────────────────────────────────────────────────────

const Market = z
  .object({
    id: z.string(),
    question: z.string(),
    status: z.string(),
    metadata: z.any().optional(),
    version: z.number().int(),
    createdAt: z.string().datetime(),
  })
  .openapi("Market");

const MarketSearchResult = z
  .object({
    data: z.array(Market),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    page: z.number().int(),
    fallback: z.boolean(),
    pagination: z.object({
      limit: z.number().int(),
      offset: z.number().int(),
      page: z.number().int(),
      total: z.number().int(),
      fallback: z.boolean(),
    }),
    meta: z.object({
      limit: z.number().int(),
      offset: z.number().int(),
      page: z.number().int(),
      total: z.number().int(),
      fallback: z.boolean(),
    }),
  })
  .openapi("MarketSearchResult");

registry.registerPath({
  method: "get",
  path: "/api/markets/recommendations",
  operationId: "getMarketRecommendations",
  tags: ["Markets"],
  summary: "Get personalized market recommendations",
  security: [{ bearerAuth: [] }],
  request: {
    query: recommendationsQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of recommended markets",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(Market), nextCursor: z.string().nullable() }),
          examples: {
            recommendedMarkets: {
              value: {
                data: [
                  {
                    id: "market-003",
                    question: "Will Bitcoin close above $100k in 2026?",
                    status: "active",
                    metadata: {
                      category: "crypto",
                      resolutionSource: "official",
                    },
                    version: 1,
                    createdAt: "2026-03-01T09:00:00.000Z",
                  },
                ],
                nextCursor: null,
              },
            },
          },
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            unauthorized: {
              value: {
                error: {
                  code: "unauthorized",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/recommendations",
  operationId: "getRecommendations",
  tags: ["Markets"],
  summary: "Get personalized market recommendations",
  security: [{ bearerAuth: [] }],
  request: {
    query: recommendationsQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of recommended markets",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(Market), nextCursor: z.string().nullable() }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorBody,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/markets",
  operationId: "listMarkets",
  tags: ["Markets"],
  summary: "List all markets with cursor pagination",
  description:
    "Returns a cursor-paginated list of markets. Supports strong ETag / conditional GET: " +
    "send the ETag back as If-None-Match on subsequent requests; if the page is unchanged " +
    "the server responds 304 Not Modified (no body).",
  request: {
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when the page is unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Array of markets",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({ data: z.array(Market) }),
          examples: {
            default: {
              value: {
                data: [
                  {
                    id: "market-001",
                    question: "Will the US win the 2026 FIFA World Cup?",
                    status: "active",
                    metadata: {
                      category: "sports",
                      resolutionSource: "official",
                    },
                    version: 1,
                    createdAt: "2026-01-10T12:00:00.000Z",
                  },
                  {
                    id: "market-002",
                    question: "Will Stellar launch a new protocol upgrade in 2026?",
                    status: "active",
                    metadata: {
                      category: "technology",
                      resolutionSource: "community",
                    },
                    version: 2,
                    createdAt: "2026-02-14T07:30:00.000Z",
                  },
                ],
              },
            },
          },
        },
      },
    },
    304: {
      description: "Not Modified — page unchanged since the ETag in If-None-Match.",
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/markets/search",
  operationId: "searchMarkets",
  tags: ["Markets"],
  summary: "Full-text search across markets",
  description:
    "Full-text search with fuzzy trigram fallback. Supports strong ETag / conditional GET: " +
    "send the ETag back as If-None-Match; if results are unchanged the server responds 304 Not Modified.",
  request: {
    query: z.object({
      q: z.string().min(1),
      limit: z.coerce.number().int().positive().default(20).optional(),
      offset: z.coerce.number().int().nonnegative().default(0).optional(),
      page: z.coerce.number().int().positive().optional(),
    }),
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when results are unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: MarketSearchResult,
          examples: {
            searchResults: {
              value: {
                data: [
                  {
                    id: "market-001",
                    question: "Will the US win the 2026 FIFA World Cup?",
                    status: "active",
                    metadata: {
                      category: "sports",
                      resolutionSource: "official",
                    },
                    version: 1,
                    createdAt: "2026-01-10T12:00:00.000Z",
                  },
                ],
                total: 1,
                limit: 20,
                offset: 0,
                page: 1,
                fallback: false,
                pagination: {
                  limit: 20,
                  offset: 0,
                  page: 1,
                  total: 1,
                  fallback: false,
                },
                meta: {
                  limit: 20,
                  offset: 0,
                  page: 1,
                  total: 1,
                  fallback: false,
                },
              },
            },
          },
        },
      },
    },
    304: {
      description: "Not Modified — search results unchanged since the ETag in If-None-Match.",
    },
    400: {
      description: "Missing query parameter",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            missingQuery: {
              value: {
                error: {
                  code: "validation_error",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/markets/tags",
  operationId: "getMarketTags",
  tags: ["Markets"],
  summary: "Get market tags with counts",
  responses: {
    200: {
      description: "Market tags with counts",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                tag: z.string(),
                count: z.number(),
              }),
            ),
          }),
          examples: {
            tagCounts: {
              value: {
                data: [
                  { tag: "sports", count: 42 },
                  { tag: "crypto", count: 17 },
                  { tag: "technology", count: 9 },
                ],
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/markets/{id}",
  operationId: "getMarketById",
  tags: ["Markets"],
  summary: "Get a market by ID",
  description:
    "Returns a single market by ID. Supports strong ETag / conditional GET: " +
    "send the ETag back as If-None-Match; if unchanged the server responds 304 Not Modified.",
  request: {
    params: z.object({ id: z.string() }),
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when the market is unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Market",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({ data: Market }),
          examples: {
            default: {
              value: {
                data: {
                  id: "market-001",
                  question: "Will the US win the 2026 FIFA World Cup?",
                  status: "active",
                  metadata: {
                    category: "sports",
                    resolutionSource: "official",
                  },
                  version: 1,
                  createdAt: "2026-01-10T12:00:00.000Z",
                },
              },
            },
          },
        },
      },
    },
    304: {
      description: "Not Modified — market unchanged since the ETag in If-None-Match.",
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

const FeaturedMarket = z
  .object({
    id: z.string(),
    question: z.string(),
    status: z.string(),
    resolutionOutcome: z.string().nullable().optional(),
    resolutionTime: z.string().datetime(),
    winningOutcome: z.string().nullable().optional(),
    metadata: z.any().nullable().optional(),
    featuredAt: z.string().datetime().nullable(),
    featuredBy: z.string().nullable(),
  })
  .openapi("FeaturedMarket");

const FeatureMarketResponse = z
  .object({
    marketId: z.string(),
    featured: z.boolean(),
    featuredAt: z.string().datetime().nullable(),
    featuredBy: z.string().nullable(),
    changed: z.boolean(),
  })
  .openapi("FeatureMarketResponse");

registry.registerPath({
  method: "patch",
  path: "/api/markets/{id}",
  operationId: "updateMarket",
  tags: ["Markets"],
  summary: "Update a market (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: PatchMarketRequest,
          examples: {
            updateQuestion: {
              value: {
                question: "Will the US win the 2026 FIFA World Cup Final?",
                metadata: { category: "sports" },
                expectedVersion: 1,
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated market",
      content: {
        "application/json": {
          schema: z.object({ data: Market }),
          examples: {
            updatedMarket: {
              value: {
                data: {
                  id: "market-001",
                  question: "Will the US win the 2026 FIFA World Cup Final?",
                  status: "active",
                  metadata: { category: "sports" },
                  version: 2,
                  createdAt: "2026-01-10T12:00:00.000Z",
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ValidationErrorBody,
          examples: {
            invalidBody: {
              value: {
                error: {
                  code: "validation_error",
                  details: [
                    {
                      path: ["expectedVersion"],
                      message: "expectedVersion is required",
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    403: {
      description: "Forbidden — caller is not an administrator",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Not found",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            notFound: {
              value: {
                error: {
                  code: "not_found",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
    409: {
      description: "Version conflict",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            versionConflict: {
              value: {
                error: {
                  code: "conflict",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
  },
});

// ── /api/markets/{id}/comments ───────────────────────────────────────────────

const MarketComment = z
  .object({
    id: z.string().uuid(),
    marketId: z.string(),
    authorId: z.string().uuid().nullable(),
    authorAddress: z.string().nullable(),
    body: z.string(),
    moderationFlagged: z.boolean(),
    moderationReason: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("MarketComment");

registry.registerPath({
  method: "get",
  path: "/api/markets/{id}/comments",
  operationId: "getMarketComments",
  tags: ["Markets", "Comments"],
  summary: "List comments for a market with cursor pagination",
  description:
    "Returns a cursor-paginated list of comments for the given market. The resolved `X-Correlation-Id` is echoed back in the response header.",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().positive().optional().default(20),
      cursor: z.string().optional(),
    }),
    headers: z.object({
      "x-correlation-id": z.string().optional().openapi({
        description:
          "Client-supplied correlation ID. Alphanumeric, hyphens, and underscores only (max 128 chars). A UUID v4 is generated when absent.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Paginated comments list",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(MarketComment),
            nextCursor: z.string().nullable(),
          }),
        },
      },
      headers: z.object({
        "x-correlation-id": z.string().openapi({
          description: "Resolved correlation ID, echoed back to the caller.",
        }),
      }),
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
  },
});

// ── /api/comments (root) ─────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/comments",
  operationId: "listComments",
  tags: ["Comments"],
  summary: "List comments (root endpoint)",
  description:
    "Returns a paginated list of comments. The resolved `X-Correlation-Id` is echoed back in the response header.",
  request: {
    query: z.object({
      limit: z.coerce.number().int().positive().max(100).optional(),
      cursor: z.string().optional(),
    }),
    headers: z.object({
      "x-correlation-id": z.string().optional().openapi({
        description:
          "Client-supplied correlation ID. Alphanumeric, hyphens, and underscores only (max 128 chars). A UUID v4 is generated when absent.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Paginated comments list",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(MarketComment),
            nextCursor: z.string().nullable(),
            message: z.string(),
          }),
        },
      },
      headers: z.object({
        "x-correlation-id": z.string().openapi({
          description: "Resolved correlation ID, echoed back to the caller.",
        }),
      }),
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
  },
});

const CreateCommentRequest = z
  .object({
    marketId: z.string().min(1).openapi({ description: "Target market ID" }),
    body: z
      .string()
      .min(1)
      .max(2000)
      .openapi({ description: "Comment body (max 2 000 chars)" }),
    authorAddress: z
      .string()
      .optional()
      .openapi({ description: "Stellar address of the author" }),
    outboundUrl: z
      .string()
      .url()
      .optional()
      .openapi({
        description:
          "Optional webhook URL that receives a POST with the comment payload. X-Correlation-Id is forwarded automatically.",
      }),
  })
  .openapi("CreateCommentRequest");

const CreateCommentResponse = z
  .object({
    data: z.object({
      id: z.string(),
      marketId: z.string(),
      body: z.string(),
      authorAddress: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
    message: z.string(),
  })
  .openapi("CreateCommentResponse");

registry.registerPath({
  method: "post",
  path: "/api/comments",
  operationId: "createComment",
  tags: ["Comments"],
  summary: "Create a comment",
  description:
    "Creates a new comment. When `outboundUrl` is provided the service posts the comment payload to that URL, forwarding `X-Correlation-Id` so the receiving system can correlate the call.",
  request: {
    headers: z.object({
      "x-correlation-id": z.string().optional().openapi({
        description:
          "Client-supplied correlation ID propagated to the outbound webhook call.",
      }),
    }),
    body: {
      content: { "application/json": { schema: CreateCommentRequest } },
    },
  },
  responses: {
    201: {
      description: "Comment created",
      content: {
        "application/json": { schema: CreateCommentResponse },
      },
      headers: z.object({
        "x-correlation-id": z.string().openapi({
          description: "Resolved correlation ID, echoed back to the caller.",
        }),
      }),
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
  },
});

// ── /api/markets/{id}/disputes ───────────────────────────────────────────────
// ── /api/markets/{id}/prediction-count ───────────────────────────────────────

const PredictionCountResponse = z
  .object({
    data: z.object({
      marketId: z.string(),
      count: z.number().int().nonnegative(),
      computedAt: z.string().datetime(),
      cached: z.boolean(),
    }),
  })
  .openapi("PredictionCountResponse");

registry.registerPath({
  method: "get",
  path: "/api/markets/{id}/prediction-count",
  operationId: "getMarketPredictionCount",
  tags: ["Markets"],
  summary: "Get total prediction count for a market",
  description:
    "Returns the total number of predictions placed on the given market. " +
    "Results are cached in Redis for 60 seconds. The `cached` field " +
    "indicates whether the value came from the cache.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Prediction count",
      content: {
        "application/json": {
          schema: PredictionCountResponse,
          examples: {
            predictionCount: {
              value: {
                data: {
                  marketId: "market-001",
                  count: 128,
                  computedAt: "2026-06-27T12:00:00.000Z",
                  cached: true,
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ValidationErrorBody,
          examples: {
            invalidId: {
              value: {
                error: {
                  code: "validation_error",
                  details: [{ path: ["id"], message: "Market ID is required" }],
                },
              },
            },
          },
        },
      },
    },
    404: {
      description: "Market not found",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            notFound: {
              value: {
                error: {
                  code: "not_found",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
  },
});

const ClaimRequest = z
  .object({ marketId: z.string().min(1) })
  .strict()
  .openapi("ClaimRequest");

const ClaimResponse = z
  .object({
    data: z.object({
      predictionId: z.string(),
      result: z.string().nullable(),
      claimTxHash: z.string().nullable(),
      claimedAt: z.string().datetime().nullable(),
    }),
  })
  .openapi("ClaimResponse");

registry.registerPath({
  method: "post",
  path: "/api/predictions/claim",
  operationId: "claimPrediction",
  tags: ["Predictions"],
  summary: "Claim winnings after market resolution",
  description:
    "Builds and submits a Soroban claim transaction for the authenticated user's " +
    "winning prediction. Idempotent via Idempotency-Key header and internal guard.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: ClaimRequest } } },
  },
  responses: {
    200: {
      description: "Claim successful (or previously claimed)",
      content: { "application/json": { schema: ClaimResponse } },
    },
    400: {
      description: "Market not resolved, prediction not winning, or validation error",
      content: { "application/json": { schema: ErrorBody } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBody } } },
    404: {
      description: "Market or prediction not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    500: {
      description: "Soroban transaction submission failed",
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
  operationId: "getLeaderboard",
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
    400: {
      description: "Invalid pagination parameters",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/leaderboard/user/{stellarAddress}",
  operationId: "getLeaderboardUser",
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

// ── /api/rate-limit/status ──────────────────────────────────────────────────────

const AnonRateLimitStatus = z
  .object({
    data: z.object({
      type: z.literal("anonymous"),
      clientIp: z.string(),
      limit: z.number().int(),
      used: z.number().int(),
      remaining: z.number().int(),
      windowMs: z.number().int(),
      resetAt: z.string().datetime(),
    }),
  })
  .openapi("AnonRateLimitStatus");

const AuthRateLimitStatus = z
  .object({
    data: z.object({
      type: z.literal("authenticated"),
      limit: z.number().int(),
      windowMs: z.number().int(),
      bypasses: z.literal(true),
    }),
  })
  .openapi("AuthRateLimitStatus");

registry.registerPath({
  method: "get",
  path: "/api/rate-limit/status",
  operationId: "getRateLimitStatus",
  tags: ["Rate Limiting"],
  summary: "Get the current anonymous rate-limit status for the caller",
  responses: {
    200: {
      description: "Rate-limit status (type differs for anonymous vs authenticated callers)",
      content: {
        "application/json": {
          schema: z.union([AnonRateLimitStatus, AuthRateLimitStatus]),
        },
      },
    },
  },
});

const RateLimitAuditEntry = z
  .object({
    id: z.string().uuid(),
    action: z.literal("rate_limit.blocked"),
    walletAddress: z.string().nullable(),
    ip: z.string(),
    correlationId: z.string(),
    rateLimitContext: z.unknown().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("RateLimitAuditEntry");

registry.registerPath({
  method: "get",
  path: "/api/rate-limit",
  operationId: "listRateLimitEvents",
  tags: ["Rate Limiting"],
  summary: "List rate-limit audit events (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated rate-limit audit log",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(RateLimitAuditEntry),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/markets/featured ────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/markets/featured",
  operationId: "getFeaturedMarkets",
  tags: ["Markets"],
  summary: "List currently featured markets for the home page",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(20).optional(),
    }),
  },
  responses: {
    200: {
      description: "Featured markets ordered by most recently featured first",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(FeaturedMarket) }),
          examples: {
            featuredMarkets: {
              value: {
                data: [
                  {
                    id: "market-001",
                    question: "Will the US win the 2026 FIFA World Cup?",
                    status: "active",
                    resolutionOutcome: null,
                    resolutionTime: "2026-07-19T00:00:00.000Z",
                    winningOutcome: null,
                    metadata: { category: "sports" },
                    featuredAt: "2026-06-20T08:00:00.000Z",
                    featuredBy: "GADMIN1234567890DEFGHIJKLMNOPQRSTUV",
                  },
                ],
              },
            },
          },
        },
      },
    },
    400: {
      description: "Invalid query parameters",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            invalidLimit: {
              value: {
                error: {
                  code: "validation_error",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
  },
});

// ── /api/admin/markets/{id}/feature ──────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/admin/markets/{id}/feature",
  operationId: "featureAdminMarket",
  tags: ["Admin"],
  summary: "Feature a market on the home page (admin only, idempotent)",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Market featured (or already featured — `changed` indicates mutation)",
      content: {
        "application/json": {
          schema: z.object({ data: FeatureMarketResponse }),
        },
      },
    },
    400: {
      description: "Validation error or market is archived",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Market not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

const ForceResolveResponse = z
  .object({
    marketId: z.string(),
    winningOutcome: z.string(),
    forceResolved: z.literal(true),
  })
  .openapi("ForceResolveResponse");

registry.registerPath({
  method: "post",
  path: "/api/admin/force-resolve/{id}",
  operationId: "forceResolveAdmin",
  tags: ["Admin"],
  summary: "Force-resolve a stuck market (admin only, idempotent)",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            winningOutcome: z.string().min(1).openapi({
              description: "The outcome to set as the winner",
              example: "yes",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Market force-resolved successfully",
      content: {
        "application/json": {
          schema: z.object({ data: ForceResolveResponse }),
        },
      },
    },
    400: {
      description: "Validation error — missing or invalid winningOutcome",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or invalid admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Market not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Market already resolved or force-finalized",
      content: { "application/json": { schema: ErrorBody } },
    },
    422: {
      description: "Market has not yet reached its resolution deadline",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/admin/markets/{id}/feature",
  operationId: "unfeatureAdminMarket",
  tags: ["Admin"],
  summary: "Unfeature a market from the home page (admin only, idempotent)",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Market unfeatured (or already unfeatured — `changed` indicates mutation)",
      content: {
        "application/json": {
          schema: z.object({ data: FeatureMarketResponse }),
        },
      },
    },
    400: {
      description: "Validation error or market is archived",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Market not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

const FeatureFlag = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    description: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .openapi("FeatureFlag");

const FeatureFlagListResponse = z
  .object({ data: z.array(FeatureFlag) })
  .openapi("FeatureFlagListResponse");

const FeatureFlagResponse = z
  .object({ data: FeatureFlag })
  .openapi("FeatureFlagResponse");

const CreateFeatureFlagRequest = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    description: z.string().max(280).nullable().optional(),
  })
  .openapi("CreateFeatureFlagRequest");

const UpdateFeatureFlagRequest = z
  .object({
    enabled: z.boolean().optional(),
    description: z.string().max(280).nullable().optional(),
  })
  .openapi("UpdateFeatureFlagRequest");

registry.registerPath({
  method: "get",
  path: "/api/admin/feature-flags",
  operationId: "listAdminFeatureFlags",
  tags: ["Admin"],
  summary: "List configured feature flags",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "List of feature flags",
      content: {
        "application/json": { schema: FeatureFlagListResponse },
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

registry.registerPath({
  method: "post",
  path: "/api/admin/feature-flags",
  operationId: "createAdminFeatureFlag",
  tags: ["Admin"],
  summary: "Create a new feature flag",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateFeatureFlagRequest } } },
  },
  responses: {
    201: {
      description: "Feature flag created",
      content: {
        "application/json": { schema: FeatureFlagResponse },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Feature flag already exists",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/feature-flags/{key}",
  operationId: "getAdminFeatureFlag",
  tags: ["Admin"],
  summary: "Get a configured feature flag",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ key: z.string().min(1).max(64) }) },
  responses: {
    200: {
      description: "Feature flag details",
      content: {
        "application/json": { schema: FeatureFlagResponse },
      },
    },
    400: {
      description: "Invalid feature flag key",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Feature flag not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/admin/feature-flags/{key}",
  operationId: "updateAdminFeatureFlag",
  tags: ["Admin"],
  summary: "Update a feature flag",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ key: z.string().min(1).max(64) }),
    body: { content: { "application/json": { schema: UpdateFeatureFlagRequest } } },
  },
  responses: {
    200: {
      description: "Feature flag updated",
      content: {
        "application/json": { schema: FeatureFlagResponse },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Feature flag not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/admin/feature-flags/{key}",
  operationId: "deleteAdminFeatureFlag",
  tags: ["Admin"],
  summary: "Delete a feature flag",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ key: z.string().min(1).max(64) }) },
  responses: {
    204: { description: "Feature flag deleted" },
    400: {
      description: "Invalid feature flag key",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Feature flag not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/notifications ──────────────────────────────────────────────────────

const NotificationChannel = z
  .enum(["email", "webhook"])
  .openapi("NotificationChannel");
const NotificationCategory = z
  .enum(["market_resolved", "claim_ready", "dispute_opened"])
  .openapi("NotificationCategory");
const NotificationPreference = z
  .object({
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: z.boolean(),
  })
  .openapi("NotificationPreference");
const NotificationPreferencesResponse = z
  .object({ data: z.object({ preferences: z.array(NotificationPreference) }) })
  .openapi("NotificationPreferencesResponse");
const PatchNotificationPreferencesRequest = z
  .object({ preferences: z.array(NotificationPreference).min(1) })
  .openapi("PatchNotificationPreferencesRequest");

const NotificationId = z.string().uuid().openapi("NotificationId");

const MarkNotificationsReadRequest = z
  .object({
    notificationIds: z.array(NotificationId).optional(),
    markAllAsRead: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => (data.notificationIds?.length ?? 0) > 0 || data.markAllAsRead === true,
    {
      message: "Either notificationIds (non-empty array) or markAllAsRead=true is required",
      path: ["notificationIds"],
    },
  )
  .openapi("MarkNotificationsReadRequest");

const MarkNotificationsReadResponse = z
  .object({
    data: z.object({
      updatedCount: z.number().int().nonnegative(),
    }),
  })
  .openapi("MarkNotificationsReadResponse");

registry.registerPath({
  method: "get",
  path: "/api/notifications/preferences",
  operationId: "getNotificationPreferences",
  tags: ["Notifications"],
  summary: "Get the authenticated user\u2019s notification preferences",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Notification preferences",
      content: {
        "application/json": { schema: NotificationPreferencesResponse },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/notifications/preferences",
  operationId: "patchNotificationPreferences",
  tags: ["Notifications"],
  summary: "Update notification preferences for the authenticated user",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: PatchNotificationPreferencesRequest },
      },
    },
  },
  responses: {
    200: {
      description: "Updated notification preferences",
      content: {
        "application/json": { schema: NotificationPreferencesResponse },
      },
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

registry.registerPath({
  method: "post",
  path: "/api/notifications/mark-read",
  operationId: "markNotificationsRead",
  tags: ["Notifications"],
  summary: "Mark notifications as read for the authenticated user",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: MarkNotificationsReadRequest },
      },
    },
  },
  responses: {
    200: {
      description: "Notifications marked as read",
      content: {
        "application/json": { schema: MarkNotificationsReadResponse },
      },
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

const BroadcastNotificationRequest = z
  .object({
    title: z.string().min(1).max(255).openapi({ example: "Maintenance Announcement" }),
    body: z.string().min(1).max(2000).openapi({ example: "Scheduled maintenance will occur at 02:00 UTC." }),
    type: z.string().min(1).max(64).optional().openapi({ example: "system_broadcast" }),
    data: z.record(z.unknown()).optional().openapi({ example: { severity: "info" } }),
  })
  .openapi("BroadcastNotificationRequest");

const BroadcastNotificationResponse = z
  .object({
    data: z.object({
      recipientCount: z.number().int().nonnegative(),
      notificationCount: z.number().int().nonnegative(),
    }),
  })
  .openapi("BroadcastNotificationResponse");

registry.registerPath({
  method: "post",
  path: "/api/admin/notifications/broadcast",
  operationId: "adminBroadcastNotification",
  tags: ["Admin", "Notifications"],
  summary: "Broadcast notification to all users (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: BroadcastNotificationRequest },
      },
    },
  },
  responses: {
    201: {
      description: "Notification successfully broadcast to users",
      content: {
        "application/json": { schema: BroadcastNotificationResponse },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — caller is not an admin",
      content: { "application/json": { schema: ErrorBody } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
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

const CurrentUserProfile = z
  .object({
    stellarAddress: z.string(),
    createdAt: z.string().datetime(),
    totals: z.object({
      prediction_count: z.number().int(),
      claim_count: z.number().int(),
    }),
  })
  .openapi("CurrentUserProfile");

const UserProfile = z
  .object({
    id: z.string().uuid(),
    stellarAddress: z.string(),
    joinedAt: z.string().datetime(),
    predictions: z.array(Prediction),
    totals: z.object({
      prediction_count: z.number().int(),
      claim_count: z.number().int(),
    }),
  })
  .openapi("UserProfile");

const FollowResult = z
  .object({
    follower: z.string(),
    followee: z.string(),
    followedAt: z.string().datetime(),
  })
  .openapi("FollowResult");

registry.registerPath({
  method: "get",
  path: "/api/users",
  operationId: "listUsers",
  tags: ["Users"],
  summary: "List all users (cursor-paginated)",
  description:
    "Returns a cursor-paginated list of registered users sorted newest-first " +
    "(DESC createdAt, DESC id).  Pass the opaque `nextCursor` value from one " +
    "response as the `cursor` query parameter of the next request to advance " +
    "through pages.  A null `nextCursor` indicates the last page. " +
    "Supports strong ETag / conditional GET: send the ETag back as If-None-Match " +
    "on subsequent requests; if the page is unchanged the server responds 304 Not Modified (no body).",
  request: {
    query: z.object({
      cursor: z.string().optional().openapi({
        description: "Opaque cursor token from the previous page's nextCursor field.",
        example: "djF8MjZ8MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafGFiY2Qtd...",
      }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .openapi({ description: "Page size (1–100, default 20)." }),
    }),
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when the page is unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of users",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z
                .object({
                  id: z.string().uuid(),
                  stellarAddress: z.string(),
                  createdAt: z.string().datetime(),
                })
                .openapi("UserListRow"),
            ),
            nextCursor: z.string().nullable().openapi({
              description: "Cursor for the next page, or null on the last page.",
            }),
          }),
        },
      },
    },
    304: {
      description: "Not Modified — page unchanged since the ETag in If-None-Match.",
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/me",
  operationId: "getCurrentUser",
  tags: ["Users"],
  summary: "Get the authenticated user\u2019s profile",
  description:
    "Returns the authenticated user's profile. Supports strong ETag / conditional GET: " +
    "send the ETag back as If-None-Match on subsequent requests; if the profile is unchanged " +
    "the server responds 304 Not Modified (no body).",
  security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when content is unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Current user profile",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({ data: CurrentUserProfile }),
          examples: {
            currentUser: {
              value: {
                data: {
                  stellarAddress: "GABC1234567890DEFGHIJKLMNOPQRSTUVWX",
                  createdAt: "2026-06-27T12:00:00.000Z",
                  totals: {
                    prediction_count: 2,
                    claim_count: 0,
                  },
                },
              },
            },
          },
        },
      },
    },
    304: {
      description: "Not Modified — profile unchanged since the ETag in If-None-Match.",
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            unauthorized: {
              value: {
                error: {
                  code: "UNAUTHORIZED",
                  requestId: "req_xyz789",
                },
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/{address}/predictions",
  operationId: "getUserPredictions",
  tags: ["Users"],
  summary: "List predictions for a Stellar address",
  description:
    "Returns a cursor-paginated list of predictions. Supports strong ETag / conditional GET: " +
    "send the ETag back as If-None-Match; if the page is unchanged the server responds 304 Not Modified (no body).",
  request: {
    params: z.object({ address: z.string() }),
    query: z.object({
      status: PredictionStatus.optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when the page is unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Paginated predictions",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(Prediction),
            nextCursor: z.string().nullable(),
          }),
          examples: {
            samplePage: {
              value: {
                data: [
                  {
                    id: "11111111-1111-1111-1111-111111111111",
                    marketId: "market-abc-123",
                    status: "confirmed",
                    createdAt: "2026-06-27T12:00:00.000Z",
                  },
                ],
                nextCursor: "djF8MjR8...",
              },
            },
          },
        },
      },
    },
    304: {
      description: "Not Modified — predictions page unchanged since the ETag in If-None-Match.",
    },
    400: {
      description: "Invalid address",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            invalidAddress: {
              value: {
                error: {
                  code: "invalid_address",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
    404: {
      description: "User not found",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            notFound: {
              value: {
                error: {
                  code: "not_found",
                  requestId: "req_abc123",
                },
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/{stellarAddress}/profile",
  operationId: "getUserProfile",
  tags: ["Users"],
  summary: "Get a user\u2019s public profile",
  description:
    "Returns a public user profile. Supports strong ETag / conditional GET: " +
    "send the ETag back as If-None-Match; if the profile is unchanged the server responds 304 Not Modified (no body).",
  request: {
    params: z.object({ stellarAddress: z.string() }),
    headers: z.object({
      "If-None-Match": z.string().optional().openapi({
        description: "ETag from a previous 200 response. Triggers 304 when the profile is unchanged.",
      }),
    }),
  },
  responses: {
    200: {
      description: "User profile",
      headers: {
        ETag: {
          description: "Strong ETag (SHA-256) of the response body.",
          schema: { type: "string" },
        },
        "Cache-Control": {
          description: "Always no-cache so clients revalidate before reuse.",
          schema: { type: "string", example: "no-cache" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({ data: UserProfile }),
          examples: {
            publicProfile: {
              value: {
                data: {
                  id: "22222222-2222-2222-2222-222222222222",
                  stellarAddress: "GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUV",
                  joinedAt: "2025-01-01T12:00:00.000Z",
                  predictions: [
                    {
                      id: "33333333-3333-3333-3333-333333333333",
                      marketId: "market-def-456",
                      status: "won",
                      createdAt: "2026-06-27T12:00:00.000Z",
                    },
                  ],
                  totals: {
                    prediction_count: 1,
                    claim_count: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: "Invalid Stellar address",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            invalidAddress: {
              value: {
                error: {
                  code: "validation_error",
                  requestId: "req_xyz789",
                },
              },
            },
          },
        },
      },
    },
    404: {
      description: "User not found",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            notFound: {
              value: {
                error: {
                  code: "not_found",
                  requestId: "req_xyz789",
                },
              },
            },
          },
        },
      },
    },
  },
});

// ── /api/predictions ──────────────────────────────────────────────────────────

/**
 * PredictionRow — the shape returned by GET /api/predictions.
 * Includes the joined market question and resolution time for display.
 */
const PredictionRow = z
  .object({
    id: z.string().uuid(),
    marketId: z.string(),
    question: z.string(),
    outcome: z.string(),
    amount: z.string(),
    txHash: z.string(),
    status: PredictionStatus,
    result: z.string().nullable(),
    createdAt: z.string().datetime(),
    resolutionTime: z.string().datetime(),
  })
  .openapi("PredictionRow");

const PredictionsListResponse = z
  .object({
    items: z.array(PredictionRow),
    /** Opaque cursor for the next page, or null if this is the last page. */
    next_cursor: z.string().nullable(),
    /** Optional total count for clients that need it. */
    total: z.number().int().nonnegative().optional(),
  })
  .openapi("PredictionsListResponse");

/**
 * GET /api/predictions
 *
 * Returns a cursor-paginated list of predictions belonging to the
 * authenticated user.
 *
 * Keyset pagination on (createdAt DESC, id DESC) — stable and efficient
 * even as new rows are inserted between page loads.
 *
 * Filters: marketId, status, outcome (all optional).
 * Pagination: cursor + limit (default 20, max 100).
 */
registry.registerPath({
  method: "get",
  path: "/api/predictions",
  operationId: "listPredictions",
  tags: ["Predictions"],
  summary: "List the authenticated user\u2019s predictions",
  description:
    "Returns a cursor-paginated list of predictions placed by the caller. " +
    "Sort order is `createdAt DESC, id DESC`. " +
    "Pass the returned `next_cursor` as `?cursor=` to fetch the next page. " +
    "`next_cursor` is `null` when no further pages exist.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      /** Filter to a specific market. */
      marketId: z.string().min(1).max(128).optional(),
      /** Filter by prediction lifecycle status. */
      status: PredictionStatus.optional(),
      /** Filter by chosen outcome value (e.g. "yes" / "no"). */
      outcome: z.string().min(1).max(64).optional(),
      /** Opaque cursor from the previous page’s `next_cursor`. */
      cursor: z.string().optional(),
      /** Page size — default 20, max 100. */
      limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of predictions",
      content: {
        "application/json": {
          schema: PredictionsListResponse,
          examples: {
            authenticatedPredictionsPage: {
              value: {
                items: [
                  {
                    id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
                    marketId: "market_123",
                    question: "Will Bitcoin hit 100k in 2026?",
                    outcome: "yes",
                    amount: "50.0000000",
                    txHash: "8c253240be423ef8109d94101e40a02bc8f297b819f0ff4f4c20b8e906059e66",
                    status: "won",
                    result: "yes",
                    createdAt: "2026-05-01T12:00:00.000Z",
                    resolutionTime: "2026-06-01T12:00:00.000Z",
                  },
                ],
                next_cursor: "cursor_abc123",
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error — invalid query parameters",
      content: {
        "application/json": {
          schema: ValidationErrorBody,
          examples: {
            invalidLimit: {
              value: {
                error: {
                  code: "VALIDATION_ERROR",
                  details: "Limit must be between 1 and 100",
                },
              },
            },
          },
        },
      },
    },
    401: {
      description: "Unauthorized — missing or invalid JWT",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            unauthorized: {
              value: {
                error: {
                  code: "UNAUTHORIZED",
                  requestId: "req_xyz789",
                },
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/users/{addr}/follow",
  operationId: "followUser",
  tags: ["Social"],
  summary: "Follow a user",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ addr: z.string() }) },
  responses: {
    200: {
      description: "Follow relationship created",
      content: {
        "application/json": {
          schema: z.object({ data: FollowResult }),
          examples: {
            followCreated: {
              value: {
                data: {
                  follower: "GABC1234567890DEFGHIJKLMNOPQRSTUVWX",
                  followee: "GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUV",
                  followedAt: "2026-06-27T12:00:00.000Z",
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ValidationErrorBody,
          examples: {
            validationError: {
              value: {
                error: {
                  code: "VALIDATION_ERROR",
                  details: "Invalid stellar address",
                },
              },
            },
          },
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            unauthorized: {
              value: {
                error: {
                  code: "UNAUTHORIZED",
                  requestId: "req_xyz789",
                },
              },
            },
          },
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/users/{addr}/follow",
  operationId: "unfollowUser",
  tags: ["Social"],
  summary: "Unfollow a user",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ addr: z.string() }) },
  responses: {
    200: {
      description: "Follow relationship removed",
      content: {
        "application/json": {
          schema: z.object({ data: FollowResult }),
          examples: {
            followRemoved: {
              value: {
                data: {
                  follower: "GABC1234567890DEFGHIJKLMNOPQRSTUVWX",
                  followee: "GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUV",
                  followedAt: "2026-06-27T12:00:00.000Z",
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ValidationErrorBody,
          examples: {
            validationError: {
              value: {
                error: {
                  code: "VALIDATION_ERROR",
                  details: "Invalid stellar address",
                },
              },
            },
          },
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            unauthorized: {
              value: {
                error: {
                  code: "UNAUTHORIZED",
                  requestId: "req_xyz789",
                },
              },
            },
          },
        },
      },
    },
  },
});

const AdminUserView = z
  .object({
    user: z
      .object({
        id: z.string(),
        stellarAddress: z.string(),
        createdAt: z.string().datetime(),
      })
      .nullable(),
    predictions: z.array(
      z.object({
        id: z.string(),
        marketId: z.string(),
        outcome: z.string(),
        amount: z.string(),
        createdAt: z.string().datetime(),
      }),
    ),
    claims: z.array(
      z.object({
        id: z.string(),
        marketId: z.string(),
        amount: z.string(),
        status: z.string(),
        createdAt: z.string().datetime(),
      }),
    ),
    disputes: z.array(
      z.object({
        id: z.string(),
        marketId: z.string(),
        reason: z.string(),
        status: z.string(),
        createdAt: z.string().datetime(),
      }),
    ),
    totals: z.object({
      predictions: z.number().int(),
      claims: z.number().int(),
      disputes: z.number().int(),
    }),
  })
  .openapi("AdminUserView");

const AdminRouteItem = z
  .object({
    id: z.string(),
    method: z.enum(["DELETE", "GET", "PATCH", "POST"]),
    path: z.string(),
    summary: z.string(),
  })
  .openapi("AdminRouteItem");

const AdminRouteListResponse = z
  .object({
    items: z.array(AdminRouteItem),
    next_cursor: z.string().nullable(),
    total: z.number().int(),
  })
  .openapi("AdminRouteListResponse");

registry.registerPath({
  method: "get",
  path: "/api/admin",
  operationId: "listAdminEndpoints",
  tags: ["Admin"],
  summary: "List available admin endpoints",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().positive().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated admin endpoint catalog",
      content: {
        "application/json": {
          schema: AdminRouteListResponse,
        },
      },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{address}",
  operationId: "getAdminUser",
  tags: ["Admin"],
  summary: "Get aggregated user data for admin support",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ address: z.string() }) },
  responses: {
    200: {
      description: "Admin user view",
      content: { "application/json": { schema: z.object({ data: AdminUserView }) } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/admin/users/{address}/impersonate ──────────────────────────────────

/**
 * 503 envelope for the impersonate endpoint. `retryAfterMs` reports the time
 * remaining before the circuit breaker will allow a recovery probe; the same
 * value is echoed, in seconds, in the `Retry-After` response header.
 */
const CircuitOpenErrorBody = z
  .object({
    error: z.object({
      code: z.literal("service_unavailable"),
      message: z.string(),
      retryAfterMs: z.number().int().nonnegative(),
      requestId: z.string(),
    }),
  })
  .openapi("CircuitOpenErrorBody");

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{address}/impersonate",
  operationId: "impersonateUser",
  tags: ["Admin"],
  summary: "Generate an impersonation JWT for a user (admin only)",
  description:
    "Admin-only endpoint that creates an audit-logged JWT allowing the caller " +
    "to act as the target user. The generated token carries a `user` role " +
    "assertion.\n\n" +
    "Downstream work (audit-log writes and token signing) is wrapped in a " +
    "per-endpoint circuit breaker. After repeated downstream failures the " +
    "breaker opens and the endpoint fast-fails with 503 without attempting " +
    "any downstream call, until a recovery probe succeeds.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ address: z.string() }) },
  responses: {
    200: {
      description: "Impersonation token",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ token: z.string() }) }),
        },
      },
    },
    400: {
      description: "Validation error — address is blank or whitespace-only",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Forbidden — missing, invalid, or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
    503: {
      description:
        "Circuit breaker is open — downstream dependencies are unhealthy and " +
        "no downstream call was attempted. Retry after `retryAfterMs`.",
      content: { "application/json": { schema: CircuitOpenErrorBody } },
    },
  },
});

// ── /api/admin/audit ────────────────────────────────────────────────────────

const AuditEntry = z
  .object({
    id: z.string().uuid(),
    action: z.string(),
    actor: z.string().optional(),
    targetAddress: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .openapi("AuditEntry");

registry.registerPath({
  method: "get",
  path: "/api/admin/audit",
  operationId: "getAdminAuditLog",
  tags: ["Admin"],
  summary: "List audit log entries (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      action: z.string().optional(),
      actor: z.string().optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated audit log",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(AuditEntry),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorBody } },
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

registry.registerPath({
  method: "get",
  path: "/api/admin/audit/export",
  operationId: "exportAdminAuditLog",
  tags: ["Admin"],
  summary: "Export audit log as NDJSON",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      action: z.string().optional(),
      actor: z.string().optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      description: "Audit log export stream in NDJSON format",
      content: {
        "application/x-ndjson": { schema: z.string() },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
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

// ── /api/audit/counts ───────────────────────────────────────────────────────

const AuditActionCount = z
  .object({
    action: z.string(),
    count: z.number().int(),
  })
  .openapi("AuditActionCount");

const AuditCountsSummary = z
  .object({
    totalCount: z.number().int(),
    byAction: z.array(AuditActionCount),
  })
  .openapi("AuditCountsSummary");

registry.registerPath({
  method: "get",
  path: "/api/audit/counts",
  operationId: "getAuditCounts",
  tags: ["Admin"],
  summary: "Per-action audit log counts summary for dashboards (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      description: "Audit log counts summary",
      content: {
        "application/json": {
          schema: z.object({ data: AuditCountsSummary }),
        },
      },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorBody } },
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

// ── /api/admin/plugins ─────────────────────────────────────────────────────

const PluginView = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    config: z.any(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("PluginView");

const CreatePluginRequest = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .openapi("CreatePluginRequest");

const UpdatePluginRequest = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .openapi("UpdatePluginRequest");

const DeletePluginResult = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .openapi("DeletePluginResult");

// GET /api/admin/plugins
registry.registerPath({
  method: "get",
  path: "/api/admin/plugins",
  operationId: "listAdminPlugins",
  tags: ["Admin"],
  summary: "List all plugins (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      enabled: z.enum(["true", "false"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of plugins",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(PluginView),
            total: z.number().int(),
          }),
        },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// POST /api/admin/plugins
registry.registerPath({
  method: "post",
  path: "/api/admin/plugins",
  operationId: "createAdminPlugin",
  tags: ["Admin"],
  summary: "Create a new plugin (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreatePluginRequest } },
    },
  },
  responses: {
    201: {
      description: "Plugin created",
      content: {
        "application/json": { schema: z.object({ data: PluginView }) },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Plugin name already exists",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// GET /api/admin/plugins/{id}
registry.registerPath({
  method: "get",
  path: "/api/admin/plugins/{id}",
  operationId: "getAdminPlugin",
  tags: ["Admin"],
  summary: "Get a single plugin by ID (admin only)",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Plugin details",
      content: {
        "application/json": { schema: z.object({ data: PluginView }) },
      },
    },
    400: {
      description: "Invalid ID",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Plugin not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// PATCH /api/admin/plugins/{id}
registry.registerPath({
  method: "patch",
  path: "/api/admin/plugins/{id}",
  operationId: "updateAdminPlugin",
  tags: ["Admin"],
  summary: "Update a plugin (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: UpdatePluginRequest } },
    },
  },
  responses: {
    200: {
      description: "Plugin updated",
      content: {
        "application/json": { schema: z.object({ data: PluginView }) },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Plugin not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// DELETE /api/admin/plugins/{id}
registry.registerPath({
  method: "delete",
  path: "/api/admin/plugins/{id}",
  operationId: "deleteAdminPlugin",
  tags: ["Admin"],
  summary: "Delete a plugin (admin only)",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Plugin deleted",
      content: {
        "application/json": { schema: z.object({ data: DeletePluginResult }) },
      },
    },
    400: {
      description: "Invalid ID",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Plugin not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/admin/rate-limit/inspect/:address ─────────────────────────────────

const AdminRateLimitInspect = z
  .object({
    address: z.string().describe("Target Stellar address"),
    limit: z.number().int().describe("Configured request cap in the window"),
    used: z.number().int().describe("Requests currently active in the window"),
    remaining: z.number().int().describe("Requests remaining in the current window"),
    windowMs: z.number().int().describe("Sliding-window length in milliseconds"),
    resetAt: z.string().datetime().describe("ISO-8601 timestamp when the window resets"),
  })
  .openapi("AdminRateLimitInspect");

registry.registerPath({
  method: "get",
  path: "/api/admin/rate-limit/inspect/{address}",
  operationId: "inspectAdminRateLimit",
  tags: ["Admin"],
  summary: "Inspect current rate-limit state for an address (admin only)",
  description:
    "Returns the current sliding-window rate-limit usage for a target Stellar address. " +
    "Admin-only and read-only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Current rate-limit state for the requested address",
      content: { "application/json": { schema: z.object({ data: AdminRateLimitInspect }) } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/admin/health/detail ─────────────────────────────────────────────────

const CheckStatus = z
  .enum(["ok", "degraded", "error"])
  .openapi("CheckStatus");

const DbPoolStats = z
  .object({
    total: z.number().int().describe("Total connections in pool"),
    idle: z.number().int().describe("Idle (available) connections"),
    waiting: z.number().int().describe("Clients waiting for a connection"),
  })
  .openapi("DbPoolStats");

const DbPoolCheck = z
  .object({
    status: CheckStatus,
    latencyMs: z.number().int(),
    stats: DbPoolStats,
    error: z.string().optional(),
  })
  .openapi("DbPoolCheck");

const IndexerCheck = z
  .object({
    status: CheckStatus,
    latencyMs: z.number().int(),
    lastIndexedLedger: z.number().int().nullable(),
    chainTip: z.number().int().nullable(),
    lagLedgers: z.number().int().nullable(),
    error: z.string().optional(),
  })
  .openapi("IndexerCheck");

const RpcCheck = z
  .object({
    status: CheckStatus,
    latencyMs: z.number().int(),
    latestLedger: z.number().int().nullable(),
    error: z.string().optional(),
  })
  .openapi("RpcCheck");

const AdminHealthDetail = z
  .object({
    dbPool: DbPoolCheck,
    indexer: IndexerCheck,
    rpc: RpcCheck,
    checkedAt: z.string().datetime(),
  })
  .openapi("AdminHealthDetail");

registry.registerPath({
  method: "get",
  path: "/api/admin/health/detail",
  operationId: "getAdminHealthDetail",
  tags: ["Admin"],
  summary: "Detailed runtime health (admin only)",
  description:
    "Returns DB pool stats, indexer cursor/lag, and Soroban RPC status. " +
    "Returns 207 when any sub-check is degraded or errored.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "All checks healthy",
      content: { "application/json": { schema: AdminHealthDetail } },
    },
    207: {
      description: "One or more checks degraded or errored",
      content: { "application/json": { schema: AdminHealthDetail } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/admin/recon ─────────────────────────────────────────────────────────

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

const ReconciliationSummary = z
  .object({
    totalKeys: z.number().int(),
    matches: z.number().int(),
    mismatches: z.number().int(),
    missingOnChain: z.number().int(),
    missingInDb: z.number().int(),
  })
  .openapi("ReconciliationSummary");

const MarketReconciliationResult = z
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
    summary: ReconciliationSummary,
    diffs: z.array(ReconciliationDiffEntry),
  })
  .openapi("MarketReconciliationResult");

registry.registerPath({
  method: "get",
  path: "/api/admin/recon/markets/{id}",
  operationId: "adminReconcileMarket",
  tags: ["Admin"],
  summary: "On-demand market reconciliation (admin only)",
  description:
    "Compares confirmed on-chain positions against the database snapshot for a " +
    "single market and returns a structured diff. " +
    "Every call is audit-logged as `admin.reconciliation.market.inspect`. " +
    "Returns `status: \"partial\"` when the on-chain adapter is not yet wired.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().min(1).max(255).describe("Market ID") }),
  },
  responses: {
    200: {
      description: "Reconciliation result",
      content: {
        "application/json": {
          schema: z.object({ data: MarketReconciliationResult }),
        },
      },
    },
    400: {
      description: "Validation error — invalid market ID",
      content: { "application/json": { schema: ValidationErrorBody } },
    },
    403: {
      description: "Forbidden — missing or non-admin JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "Market not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

// ── /api/webhooks ─────────────────────────────────────────────────────────────

const DeliveryStatus = z
  .enum(["pending", "delivered", "failed"])
  .openapi("DeliveryStatus", {
    description: "Current delivery state of a webhook attempt",
  });

const WebhookDelivery = z
  .object({
    id: z.string().uuid().describe("Unique delivery ID"),
    eventId: z.string().describe("Opaque event identifier supplied by the emitting service"),
    eventType: z.string().describe('Event type string, e.g. "market.resolved" or "dispute.opened"'),
    targetUrl: z.string().url().describe("The subscriber endpoint the delivery is sent to"),
    payloadBase64: z.string().describe("Base64-encoded signed request body"),
    signature: z.string().describe("HMAC-SHA256 signature over the payload, sent as a request header"),
    headers: z
      .record(z.string())
      .nullable()
      .describe("Extra HTTP headers sent with the delivery (may be null)"),
    status: DeliveryStatus,
    attempts: z.number().int().nonnegative().describe("Number of delivery attempts made so far"),
    maxAttempts: z.number().int().positive().describe("Maximum attempts before the delivery is dead-lettered"),
    lastError: z.string().nullable().describe("Error message from the most recent failed attempt, or null"),
    nextAttemptAt: z
      .string()
      .datetime()
      .nullable()
      .describe("ISO 8601 timestamp of the next scheduled retry, or null when terminal"),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp when this delivery record was created"),
    updatedAt: z.string().datetime().describe("ISO 8601 timestamp of the most recent status change"),
  })
  .openapi("WebhookDelivery");

const DlqRow = z
  .object({
    id: z.string().uuid().describe("DLQ row ID (distinct from the original delivery ID)"),
    originalId: z.string().uuid().describe("ID of the original live delivery that was dead-lettered"),
    eventId: z.string().describe("Opaque event identifier from the original delivery"),
    eventType: z.string().describe("Event type string from the original delivery"),
    targetUrl: z.string().url().describe("Subscriber endpoint that failed to receive the delivery"),
    payloadBase64: z.string().describe("Base64-encoded signed request body, identical to the original delivery"),
    signature: z.string().describe("HMAC-SHA256 signature from the original delivery"),
    headers: z
      .record(z.string())
      .nullable()
      .describe("Extra HTTP headers from the original delivery (may be null)"),
    attempts: z.number().int().nonnegative().describe("Total number of delivery attempts before dead-lettering"),
    maxAttempts: z.number().int().positive().describe("Configured maximum attempts for the original delivery"),
    lastError: z.string().describe("Error message from the final failed attempt"),
    failedAt: z.string().datetime().describe("ISO 8601 timestamp when the delivery was moved to the DLQ"),
    replayedAt: z
      .string()
      .datetime()
      .nullable()
      .describe("ISO 8601 timestamp of the replay request, or null if not yet replayed"),
    replayDeliveryId: z
      .string()
      .uuid()
      .nullable()
      .describe("ID of the fresh live delivery created by replay, or null if not yet replayed"),
  })
  .openapi("DlqRow");

registry.registerPath({
  method: "get",
  path: "/api/webhooks",
  operationId: "listWebhookDeliveries",
  tags: ["Webhooks"],
  summary: "List live webhook deliveries (admin only)",
  description:
    "Returns a cursor-paginated list of live webhook delivery records ordered newest-first " +
    "(by `createdAt` DESC, then `id` DESC as a stable tie-breaker). Only deliveries that have " +
    "not yet been dead-lettered are returned here; exhausted deliveries appear in the DLQ at " +
    "`GET /api/admin/webhooks/dlq`. Requires an admin JWT (`role: \"admin\"`).",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated page of live webhook deliveries",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(WebhookDelivery),
            nextCursor: z.string().nullable(),
          }),
          examples: {
            webhookDeliveriesPage: {
              summary: "First page of live deliveries with one pending and one delivered record",
              value: {
                data: [
                  {
                    id: "d1a2b3c4-0001-4000-8000-000000000001",
                    eventId: "evt-market-resolved-001",
                    eventType: "market.resolved",
                    targetUrl: "https://example.com/hooks/predictify",
                    payloadBase64:
                      "eyJldmVudCI6Im1hcmtldC5yZXNvbHZlZCIsImlkIjoiZDFhMmIzYzQtMDAwMS00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIn0=",
                    signature: "sha256=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                    headers: null,
                    status: "delivered",
                    attempts: 1,
                    maxAttempts: 5,
                    lastError: null,
                    nextAttemptAt: null,
                    createdAt: "2026-07-25T12:00:00.000Z",
                    updatedAt: "2026-07-25T12:00:05.000Z",
                  },
                  {
                    id: "d1a2b3c4-0002-4000-8000-000000000002",
                    eventId: "evt-dispute-opened-001",
                    eventType: "dispute.opened",
                    targetUrl: "https://example.com/hooks/predictify",
                    payloadBase64: "eyJldmVudCI6ImRpc3B1dGUub3BlbmVkIn0=",
                    signature: "sha256=fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
                    headers: null,
                    status: "pending",
                    attempts: 0,
                    maxAttempts: 5,
                    lastError: null,
                    nextAttemptAt: "2026-07-25T11:00:30.000Z",
                    createdAt: "2026-07-25T11:00:00.000Z",
                    updatedAt: "2026-07-25T11:00:00.000Z",
                  },
                ],
                nextCursor:
                  "eyJzb3J0VmFsdWUiOiIyMDI2LTA3LTI1VDExOjAwOjAwLjAwMFoiLCJpZCI6ImQxYTJiM2M0LTAwMDItNDAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9",
              },
            },
            emptyPage: {
              summary: "Empty page when no live deliveries exist",
              value: { data: [], nextCursor: null },
            },
          },
        },
      },
    },
    400: {
      description: "Invalid query parameters",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            invalidLimit: {
              summary: "Non-numeric limit value",
              value: {
                error: {
                  code: "validation_error",
                  message: "limit must be a positive integer",
                  requestId: "req-abc-123",
                },
              },
            },
          },
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Caller is not an admin",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/webhooks/dlq",
  operationId: "listWebhookDlq",
  tags: ["Webhooks"],
  summary: "List dead-lettered webhook deliveries (admin only)",
  description:
    "Returns a cursor-paginated list of dead-lettered webhook deliveries ordered by `failedAt` DESC. " +
    "A delivery appears here after exhausting all retry attempts. Use " +
    "`POST /api/admin/webhooks/dlq/{id}/replay` to re-enqueue an individual entry. " +
    "Requires an admin JWT (`role: \"admin\"`).",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated page of DLQ entries",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(DlqRow),
            nextCursor: z.string().nullable(),
          }),
          examples: {
            dlqPage: {
              summary: "First DLQ page containing one unreplayed and one already-replayed entry",
              value: {
                data: [
                  {
                    id: "dddd1111-aaaa-4000-8000-000000000001",
                    originalId: "d1a2b3c4-0001-4000-8000-000000000001",
                    eventId: "evt-market-resolved-002",
                    eventType: "market.resolved",
                    targetUrl: "https://example.com/hooks/predictify",
                    payloadBase64: "eyJldmVudCI6Im1hcmtldC5yZXNvbHZlZCJ9",
                    signature: "sha256=1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
                    headers: null,
                    attempts: 5,
                    maxAttempts: 5,
                    lastError: "HTTP 503: Service Unavailable",
                    failedAt: "2026-07-25T10:00:00.000Z",
                    replayedAt: null,
                    replayDeliveryId: null,
                  },
                  {
                    id: "dddd2222-bbbb-4000-8000-000000000002",
                    originalId: "d1a2b3c4-0003-4000-8000-000000000003",
                    eventId: "evt-dispute-opened-002",
                    eventType: "dispute.opened",
                    targetUrl: "https://example.com/hooks/predictify",
                    payloadBase64: "eyJldmVudCI6ImRpc3B1dGUub3BlbmVkIn0=",
                    signature: "sha256=ffffeeeeddddccccbbbbaaaa00009999888877776666555544443333222211110000",
                    headers: null,
                    attempts: 3,
                    maxAttempts: 3,
                    lastError: "connect ECONNREFUSED 192.0.2.1:443",
                    failedAt: "2026-07-25T09:00:00.000Z",
                    replayedAt: "2026-07-25T09:30:00.000Z",
                    replayDeliveryId: "eeee3333-cccc-4000-8000-000000000004",
                  },
                ],
                nextCursor: null,
              },
            },
            emptyDlq: {
              summary: "No dead-lettered deliveries",
              value: { data: [], nextCursor: null },
            },
          },
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Caller is not an admin",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/webhooks/dlq/{id}/replay",
  operationId: "replayWebhookDlq",
  tags: ["Webhooks"],
  summary: "Replay a dead-lettered webhook delivery (admin only)",
  description:
    "Re-enqueues a dead-lettered delivery as a fresh live delivery with `attempts = 0`. " +
    "The original payload bytes and signature are preserved verbatim so the subscriber " +
    "receives an identical signed request. Requires an admin JWT (`role: \"admin\"`).",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid().describe("UUID of the DLQ row to replay") }),
  },
  responses: {
    202: {
      description: "Replay accepted — a fresh live delivery has been enqueued",
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              deliveryId: z.string().uuid().describe("ID of the newly-created live delivery"),
              status: DeliveryStatus,
              attempts: z.number().int().nonnegative().describe("Always 0 for a freshly replayed delivery"),
            }),
          }),
          examples: {
            replayAccepted: {
              summary: "Successful replay — new delivery created",
              value: {
                data: {
                  deliveryId: "ffff4444-dddd-4000-8000-000000000005",
                  status: "pending",
                  attempts: 0,
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: "Malformed UUID in path",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            badId: {
              summary: "Non-UUID id parameter",
              value: {
                error: {
                  code: "bad_request",
                  message: "Invalid ID format",
                  requestId: "req-xyz-789",
                },
              },
            },
          },
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Caller is not an admin",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "DLQ row not found",
      content: {
        "application/json": {
          schema: ErrorBody,
          examples: {
            notFound: {
              summary: "No DLQ row with the given id",
              value: {
                error: {
                  code: "not_found",
                  message: "DLQ row not found",
                  requestId: "req-xyz-790",
                },
              },
            },
          },
        },
      },
    },
    409: {
      description: "DLQ row already replayed",
      content: {
        "application/json": {
          schema: z.object({
            error: z.object({ type: z.literal("already_replayed") }),
            replayDeliveryId: z.string().uuid().nullable(),
          }),
          examples: {
            alreadyReplayed: {
              summary: "This DLQ row was already replayed — idempotency guard triggered",
              value: {
                error: { type: "already_replayed" },
                replayDeliveryId: "ffff4444-dddd-4000-8000-000000000005",
              },
            },
          },
        },
      },
    },
  },
});

// ── /api/referrals ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/referrals",
  operationId: "createReferral",
  tags: ["Referrals"],
  summary: "Create a referral code",
  description: "Creates a new referral code for the authenticated user.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            campaignId: z.string().optional(),
          }),
          examples: {
            success: {
              summary: "Create referral request",
              value: {
                campaignId: "FWC26",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Referral created",
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              referralCode: z.string(),
              message: z.string(),
            }),
          }),
          examples: {
            success: {
              summary: "Referral code created successfully",
              value: {
                data: {
                  referralCode: "REF-ABC-123",
                  message: "Referral created successfully",
                },
              },
            },
          },
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/referrals",
  operationId: "listReferrals",
  tags: ["Referrals"],
  summary: "List user referrals",
  description: "Lists all referrals made by the authenticated user.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "List of referrals",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.string(),
                referredUser: z.string(),
                status: z.enum(["pending", "completed"]),
                createdAt: z.string().datetime(),
              })
            ),
          }),
          examples: {
            success: {
              summary: "Referral list",
              value: {
                data: [
                  {
                    id: "ref-001",
                    referredUser: "GD2...",
                    status: "completed",
                    createdAt: "2026-07-28T12:00:00Z",
                  },
                ],
              },
            },
          },
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});
