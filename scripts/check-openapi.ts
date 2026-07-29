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
  { method: "get", path: "/api/admin/feature-flags" },
  { method: "post", path: "/api/admin/feature-flags" },
  { method: "get", path: "/api/admin/feature-flags/{key}" },
  { method: "patch", path: "/api/admin/feature-flags/{key}" },
  { method: "delete", path: "/api/admin/feature-flags/{key}" },
  { method: "post", path: "/api/admin/markets/{id}/feature" },
  { method: "delete", path: "/api/admin/markets/{id}/feature" },
  { method: "post", path: "/api/admin/force-resolve/{id}" },
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

  if (exitCode === 0) {
    console.log(`OK: all ${EXPECTED_ROUTES.length} routes documented correctly`);
  }

  return exitCode;
}

process.exit(main());
