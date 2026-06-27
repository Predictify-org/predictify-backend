import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { getOpenApiSpec } from "../openapi/builder";

/**
 * Builds the /docs (Swagger UI) router.
 *
 * CSP is mounted outside this router in `src/index.ts` so that the exception is
 * clearly scoped at the application boundary and easy to review.
 */
export function createDocsRouter(): Router {
  const router = Router();

  router.use("/", swaggerUi.serve, swaggerUi.setup(getOpenApiSpec()));

  return router;
}
