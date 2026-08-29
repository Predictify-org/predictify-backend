import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { resetOpenApiCache, getOpenApiSpec } from "../src/openapi/builder";

export type Method = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export interface RouteEntry {
  method: Method;
  path: string;
}

export const EXPECTED_ROUTES: RouteEntry[] = [
  { method: "get", path: "/health" },
  { method: "get", path: "/healthz/dependencies" },
  { method: "get", path: "/metrics" },
  { method: "post", path: "/api/auth/challenge" },
  { method: "post", path: "/api/auth/verify" },
  { method: "post", path: "/api/auth/refresh" },
  { method: "post", path: "/api/auth/logout" },
  { method: "get", path: "/api/markets" },
  { method: "get", path: "/api/markets/search" },
  { method: "get", path: "/api/markets/{id}" },
  { method: "patch", path: "/api/markets/{id}" },
  { method: "get", path: "/api/leaderboard" },
  { method: "get", path: "/api/leaderboard/user/{stellarAddress}" },
  { method: "get", path: "/api/notifications/preferences" },
  { method: "patch", path: "/api/notifications/preferences" },
  { method: "get", path: "/api/users/me" },
  { method: "get", path: "/api/users/{address}/predictions" },
  { method: "get", path: "/api/users/{stellarAddress}/profile" },
  { method: "post", path: "/api/users/{addr}/follow" },
  { method: "delete", path: "/api/users/{addr}/follow" },
  { method: "get", path: "/api/admin/audit" },
  { method: "get", path: "/api/audit/counts" },
  { method: "get", path: "/api/admin/users/{address}" },
  { method: "post", path: "/api/admin/users/{address}/impersonate" },
  { method: "get", path: "/api/admin/feature-flags" },
  { method: "post", path: "/api/admin/feature-flags" },
  { method: "get", path: "/api/admin/feature-flags/{key}" },
  { method: "patch", path: "/api/admin/feature-flags/{key}" },
  { method: "delete", path: "/api/admin/feature-flags/{key}" },
  { method: "post", path: "/api/admin/markets/{id}/feature" },
  { method: "delete", path: "/api/admin/markets/{id}/feature" },
  { method: "post", path: "/api/admin/force-resolve/{id}" },
  { method: "get", path: "/api/users/health" },
  { method: "get", path: "/.well-known/jwks.json" },
  { method: "post", path: "/api/auth/wallet/logout" },
  { method: "get", path: "/api/auth/health" },
  { method: "get", path: "/api/health/version" },
  { method: "get", path: "/api/markets/recommendations" },
  { method: "get", path: "/api/recommendations" },
  { method: "get", path: "/api/markets/tags" },
  { method: "get", path: "/api/markets/{id}/comments" },
  { method: "get", path: "/api/comments" },
  { method: "post", path: "/api/comments" },
  { method: "get", path: "/api/markets/{id}/prediction-count" },
  { method: "post", path: "/api/predictions/claim" },
  { method: "get", path: "/api/rate-limit/status" },
  { method: "get", path: "/api/rate-limit" },
  { method: "get", path: "/api/markets/featured" },
  { method: "post", path: "/api/notifications/mark-read" },
  { method: "post", path: "/api/admin/notifications/broadcast" },
  { method: "get", path: "/api/users" },
  { method: "get", path: "/api/predictions" },
  { method: "get", path: "/api/admin" },
  { method: "get", path: "/api/admin/audit/export" },
  { method: "get", path: "/api/admin/plugins" },
  { method: "post", path: "/api/admin/plugins" },
  { method: "get", path: "/api/admin/plugins/{id}" },
  { method: "patch", path: "/api/admin/plugins/{id}" },
  { method: "delete", path: "/api/admin/plugins/{id}" },
  { method: "get", path: "/api/admin/rate-limit/inspect/{address}" },
  { method: "get", path: "/api/admin/health/detail" },
  { method: "get", path: "/api/admin/recon/markets/{id}" },
  { method: "get", path: "/api/webhooks" },
  { method: "get", path: "/api/admin/webhooks/dlq" },
  { method: "post", path: "/api/admin/webhooks/dlq/{id}/replay" },
  { method: "get", path: "/api/referrals" },
  { method: "post", path: "/api/referrals" },
];

export function routeKey(route: RouteEntry): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Normalizes line endings so comparisons are deterministic across operating systems.
 */
export function normalizeLineEndings(str: string): string {
  return str.replace(/\r\n/g, "\n").trim();
}

/**
 * Validates OpenAPI document top-level structure.
 */
export function validateStructure(spec: any): ValidationResult {
  const errors: string[] = [];

  if (!spec || typeof spec !== "object") {
    return { valid: false, errors: ["Spec is not an object or is empty"] };
  }

  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    errors.push("openapi version is missing or not 3.x (expected 3.1.0)");
  }

  if (!spec.info || typeof spec.info !== "object") {
    errors.push("info section is missing");
  } else {
    if (!spec.info.title) errors.push("info.title is missing");
    if (!spec.info.version) errors.push("info.version is missing");
  }

  if (!spec.paths || typeof spec.paths !== "object" || Object.keys(spec.paths).length === 0) {
    errors.push("no paths defined in spec");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates route coverage and detects missing or extra routes.
 */
export function validateRouteCoverage(
  spec: any,
  expectedRoutes: RouteEntry[] = EXPECTED_ROUTES,
): ValidationResult {
  const errors: string[] = [];
  const documented = new Set<string>();

  for (const [pathStr, pathItem] of Object.entries(spec?.paths ?? {})) {
    const methods = ["get", "post", "put", "patch", "delete", "head", "options"] as Method[];
    for (const method of methods) {
      const op = (pathItem as Record<string, unknown>)?.[method];
      if (op) {
        documented.add(routeKey({ method, path: pathStr }));
      }
    }
  }

  const expectedSet = new Set(expectedRoutes.map(routeKey));

  for (const route of expectedRoutes) {
    const k = routeKey(route);
    if (!documented.has(k)) {
      errors.push(`MISSING route from OpenAPI spec: ${k}`);
    }
  }

  for (const doc of documented) {
    if (!expectedSet.has(doc)) {
      errors.push(`EXTRA undocumented route found in OpenAPI spec: ${doc}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates that the checked-in openapi.yaml artifact matches the generated spec.
 */
export function validateArtifactDrift(
  spec: any,
  artifactPath = path.resolve(__dirname, "..", "openapi.yaml"),
): ValidationResult {
  const errors: string[] = [];

  if (!fs.existsSync(artifactPath)) {
    return {
      valid: false,
      errors: [`OpenAPI artifact file not found at ${artifactPath}`],
    };
  }

  const generated = yaml.dump(spec, {
    indent: 2,
    lineWidth: 120,
    noRefs: false,
    sortKeys: false,
  });

  const checkedIn = fs.readFileSync(artifactPath, "utf8");

  if (normalizeLineEndings(generated) !== normalizeLineEndings(checkedIn)) {
    errors.push(
      "openapi.yaml is stale or does not match generated registry spec; run `npm run openapi:generate` and commit the result",
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates per-route contract invariants across all operations in the spec.
 */
export function validateRouteInvariants(spec: any): ValidationResult {
  const errors: string[] = [];
  const paths = (spec?.paths ?? {}) as Record<string, Record<string, any>>;
  const operationIds = new Set<string>();
  const methods = ["get", "post", "put", "patch", "delete"] as const;

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    const pathParamsInUrl = Array.from(pathStr.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);

    for (const method of methods) {
      const op = pathItem[method];
      if (!op) continue;

      const opKey = `${method.toUpperCase()} ${pathStr}`;

      // 1. Operation ID presence & uniqueness
      if (!op.operationId || typeof op.operationId !== "string" || op.operationId.trim() === "") {
        errors.push(`${opKey}: missing or invalid operationId`);
      } else {
        if (operationIds.has(op.operationId)) {
          errors.push(`${opKey}: duplicate operationId "${op.operationId}"`);
        }
        operationIds.add(op.operationId);
      }

      // 2. Tags
      if (!op.tags || !Array.isArray(op.tags) || op.tags.length === 0) {
        errors.push(`${opKey}: missing tags array`);
      }

      // 3. Summary or Description
      if (!op.summary && !op.description) {
        errors.push(`${opKey}: missing summary and description`);
      }

      // 4. Response definitions
      if (!op.responses || typeof op.responses !== "object" || Object.keys(op.responses).length === 0) {
        errors.push(`${opKey}: no responses defined`);
      } else {
        const statusCodes = Object.keys(op.responses);
        const hasSuccess = statusCodes.some((code) => code.startsWith("2") || code === "304");
        if (!hasSuccess) {
          errors.push(`${opKey}: missing 2xx or 304 success response definition`);
        }

        // Security requirement check: protected routes must document 401 or 403
        if (op.security && Array.isArray(op.security) && op.security.length > 0) {
          const hasAuthError = statusCodes.includes("401") || statusCodes.includes("403");
          if (!hasAuthError) {
            errors.push(`${opKey}: protected route must document an auth error response (401/403)`);
          }
        }
      }

      // 5. Path parameter parity
      if (pathParamsInUrl.length > 0) {
        const declaredParams = (op.parameters ?? [])
          .filter((p: any) => p.in === "path")
          .map((p: any) => p.name);

        for (const paramName of pathParamsInUrl) {
          if (!declaredParams.includes(paramName)) {
            errors.push(
              `${opKey}: path parameter '{${paramName}}' in URL is missing from operation parameters`,
            );
          }
        }
      }

      // 6. Paginated route contract invariants
      const paramNames = new Set((op.parameters ?? []).map((p: any) => p.name));
      const isPaginated = paramNames.has("cursor") || paramNames.has("limit");
      if (isPaginated) {
        if (!op.responses?.["400"]) {
          errors.push(`${opKey}: paginated endpoint must document a 400 validation error response`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Runs all OpenAPI drift and invariant checks.
 */
export function checkOpenApi(
  spec = getOpenApiSpec(),
  expectedRoutes: RouteEntry[] = EXPECTED_ROUTES,
  artifactPath = path.resolve(__dirname, "..", "openapi.yaml"),
): { success: boolean; errors: string[] } {
  const allErrors: string[] = [];

  const structResult = validateStructure(spec);
  if (!structResult.valid) {
    allErrors.push(...structResult.errors.map((e) => `[STRUCTURE] ${e}`));
  }

  const coverageResult = validateRouteCoverage(spec, expectedRoutes);
  if (!coverageResult.valid) {
    allErrors.push(...coverageResult.errors.map((e) => `[ROUTE DRIFT] ${e}`));
  }

  const artifactResult = validateArtifactDrift(spec, artifactPath);
  if (!artifactResult.valid) {
    allErrors.push(...artifactResult.errors.map((e) => `[ARTIFACT DRIFT] ${e}`));
  }

  const invariantResult = validateRouteInvariants(spec);
  if (!invariantResult.valid) {
    allErrors.push(...invariantResult.errors.map((e) => `[INVARIANT] ${e}`));
  }

  return {
    success: allErrors.length === 0,
    errors: allErrors,
  };
}

export function main(): number {
  resetOpenApiCache();
  const spec = getOpenApiSpec();
  const { success, errors } = checkOpenApi(spec);

  if (!success) {
    console.error(`FAIL: OpenAPI drift checks failed with ${errors.length} issue(s):`);
    for (const err of errors) {
      console.error(`  ${err}`);
    }
    return 1;
  }

  console.log("OK: All routes, reproducible OpenAPI artifact, and contract invariants validated successfully.");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
