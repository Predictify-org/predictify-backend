import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

let _cached: ReturnType<OpenApiGeneratorV3["generateDocument"]> | null = null;

export function getOpenApiSpec() {
  if (_cached) return _cached;

  _cached = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Predictify API",
      version: "0.0.1",
      description:
        "Backend API for Predictify \u2014 a Stellar/Soroban prediction-markets dApp",
    },
    servers: [{ url: "/" }],
  });

  return _cached;
}

export function resetOpenApiCache() {
  _cached = null;
}
