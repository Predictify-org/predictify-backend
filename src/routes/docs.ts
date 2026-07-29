import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { getOpenApiSpec } from "../openapi/builder";

export function createDocsRouter(): Router {
  const router = Router();

  router.get("/openapi.json", (_req, res) => {
    res.json(getOpenApiSpec());
  });

  router.use("/", swaggerUi.serve, swaggerUi.setup(getOpenApiSpec()));

  return router;
}
