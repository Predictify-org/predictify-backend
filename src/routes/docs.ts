import { Router } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

/**
 * Minimal OpenAPI 3.0 spec for Predictify.
 * In production this would be generated from route schemas;
 * kept inline here so the /docs page is self-contained.
 */
const swaggerDocument: Record<string, unknown> = {
  openapi: "3.0.3",
  info: {
    title: "Predictify API",
    version: "0.0.1",
    description:
      "Backend API for Predictify — a Stellar/Soroban prediction-markets dApp",
  },
  servers: [{ url: "/api" }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: { "200": { description: "OK" } },
      },
    },
    "/markets": {
      get: {
        summary: "List markets",
        responses: { "200": { description: "Array of markets" } },
      },
    },
    "/users": {
      get: {
        summary: "List users",
        responses: { "200": { description: "Array of users" } },
      },
    },
  },
};

/**
 * Builds a router that serves Swagger UI at the mount point.
 *
 * A *scoped* helmet middleware is applied **only** to this router so that
 * Swagger UI's inline scripts load without CSP violations, while the rest
 * of the application retains the strict global CSP set in src/index.ts.
 *
 * See docs/security.md for the rationale behind this exception.
 */
export function createDocsRouter(): Router {
  const router = Router();

  // ── Scoped, relaxed CSP for Swagger UI only ──────────────────────────
  // Swagger UI renders via inline <script> tags and loads assets from CDNs.
  // We must allow 'unsafe-inline' for scripts/styles and the CDN origins.
  router.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https://validator.swagger.io"],
          // Allow Swagger UI to fetch the spec and try-it-out requests
          connectSrc: ["'self'"],
        },
      },
      // Cross-Origin-Embedder-Policy can block swagger assets
      crossOriginEmbedderPolicy: false,
    }),
  );

  router.use("/", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  return router;
}
