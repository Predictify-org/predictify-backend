import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { resetOpenApiCache, getOpenApiSpec } from "../src/openapi/builder";

type Method = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

interface RouteEntry {
  method: Method;
  path: string;
}

const EXPECTED_ROUTES: RouteEntry[] = [
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

function key(route: RouteEntry): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

function main(): number {
  resetOpenApiCache();
  const spec = getOpenApiSpec();

  let exitCode = 0;

  // 1. Basic structural validation
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    console.error("FAIL: openapi version is missing or not 3.x");
    exitCode = 1;
  }

  if (!spec.info) {
    console.error("FAIL: info section is missing");
    exitCode = 1;
  }

  if (!spec.paths || Object.keys(spec.paths).length === 0) {
    console.error("FAIL: no paths defined");
    exitCode = 1;
  }

  // 2. Collect documented routes
  const documented = new Set<string>();

  for (const [pathStr, pathItem] of Object.entries(spec.paths ?? {})) {
    const methods = ["get", "post", "put", "patch", "delete"] as Method[];
    for (const method of methods) {
      const op = (pathItem as Record<string, unknown>)[method] as
        | Record<string, unknown>
        | undefined;
      if (op) {
        documented.add(key({ method, path: pathStr }));
      }
    }
  }

  // 3. Check for missing routes
  const expectedSet = new Set(EXPECTED_ROUTES.map(key));
  const missing: string[] = [];
  const extra: string[] = [];

  for (const route of EXPECTED_ROUTES) {
    if (!documented.has(key(route))) {
      missing.push(key(route));
    }
  }

  for (const doc of documented) {
    if (!expectedSet.has(doc)) {
      extra.push(doc);
    }
  }

  if (missing.length > 0) {
    console.error("FAIL: routes missing from OpenAPI spec:");
    for (const r of missing) {
      console.error(`  MISSING  ${r}`);
    }
    exitCode = 1;
  }

  if (extra.length > 0) {
    console.error("FAIL: undocumented routes found in spec (not in Express):");
    for (const r of extra) {
      console.error(`  EXTRA    ${r}`);
    }
    exitCode = 1;
  }

  // The checked-in YAML must be byte-for-byte reproducible from the registry.
  // This catches manual edits and stale generated artifacts before deployment.
  const generated = yaml.dump(spec, {
    indent: 2,
    lineWidth: 120,
    noRefs: false,
    sortKeys: false,
  });
  const artifactPath = path.resolve(__dirname, "..", "openapi.yaml");
  const checkedIn = fs.readFileSync(artifactPath, "utf8");
  if (generated !== checkedIn) {
    console.error("FAIL: openapi.yaml is stale; run npm run openapi:generate and commit the result");
    exitCode = 1;
  }

  // Representative contract invariants: paginated endpoints must describe
  // both cursor/limit inputs and a validation error, while protected routes
  // must carry the bearer security requirement.
  const paths = spec.paths as Record<string, Record<string, any>>;
  for (const route of ["/api/users", "/api/users/{address}/predictions"]) {
    const operation = paths[route]?.get;
    const parameterNames = new Set((operation?.parameters ?? []).map((p: any) => p.name));
    if (!parameterNames.has("cursor") || !parameterNames.has("limit") || !operation?.responses?.["400"]) {
      console.error(`FAIL: ${route} must document cursor, limit, and a 400 validation response`);
      exitCode = 1;
    }
  }
  for (const [route, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (operation.security && operation.security.length > 0 && !operation.responses?.["401"] && !operation.responses?.["403"]) {
        console.error(`FAIL: protected ${method.toUpperCase()} ${route} must document an auth error response`);
        exitCode = 1;
      }
    }
  }

  if (exitCode === 0) {
    console.log(`OK: routes, reproducible artifact, and representative contracts validated`);
  }

  return exitCode;
}

process.exit(main());
