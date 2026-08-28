import * as fs from "fs";
import * as path from "path";
import {
  validateStructure,
  validateRouteCoverage,
  validateArtifactDrift,
  validateRouteInvariants,
  checkOpenApi,
  normalizeLineEndings,
  EXPECTED_ROUTES,
  RouteEntry,
} from "../scripts/check-openapi";
import { getOpenApiSpec, resetOpenApiCache } from "../src/openapi/builder";

describe("OpenAPI Drift and Contract Invariant Checks", () => {
  let spec: ReturnType<typeof getOpenApiSpec>;

  beforeAll(() => {
    resetOpenApiCache();
    spec = getOpenApiSpec();
  });

  describe("normalizeLineEndings", () => {
    it("normalizes CRLF to LF", () => {
      const input = "line1\r\nline2\r\n";
      expect(normalizeLineEndings(input)).toBe("line1\nline2");
    });
  });

  describe("validateStructure", () => {
    it("passes for the generated specification", () => {
      const result = validateStructure(spec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects non-object or null specs", () => {
      expect(validateStructure(null).valid).toBe(false);
      expect(validateStructure(undefined).valid).toBe(false);
      expect(validateStructure("string").valid).toBe(false);
    });

    it("rejects invalid or missing OpenAPI version", () => {
      const badVersion = { ...spec, openapi: "2.0" };
      const res = validateStructure(badVersion);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("openapi version"))).toBe(true);
    });

    it("rejects missing info section or title/version", () => {
      const noInfo = { ...spec, info: null };
      expect(validateStructure(noInfo).valid).toBe(false);

      const noTitle = { ...spec, info: { version: "1.0.0" } };
      expect(validateStructure(noTitle).valid).toBe(false);
    });

    it("rejects empty or missing paths", () => {
      const noPaths = { ...spec, paths: {} };
      const res = validateStructure(noPaths);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("no paths"))).toBe(true);
    });
  });

  describe("validateRouteCoverage", () => {
    it("passes when spec matches expected routes exactly", () => {
      const res = validateRouteCoverage(spec, EXPECTED_ROUTES);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("detects missing routes from the spec", () => {
      const extendedExpected: RouteEntry[] = [
        ...EXPECTED_ROUTES,
        { method: "get", path: "/api/missing/route" },
      ];
      const res = validateRouteCoverage(spec, extendedExpected);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("MISSING") && e.includes("/api/missing/route"))).toBe(true);
    });

    it("detects extra undocumented routes in the spec", () => {
      const reducedExpected = EXPECTED_ROUTES.slice(1);
      const res = validateRouteCoverage(spec, reducedExpected);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("EXTRA") && e.includes(EXPECTED_ROUTES[0].path))).toBe(true);
    });
  });

  describe("validateArtifactDrift", () => {
    it("passes when checked-in openapi.yaml matches generated spec", () => {
      const res = validateArtifactDrift(spec);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("fails when artifact file does not exist", () => {
      const nonExistentPath = path.resolve(__dirname, "../nonexistent-openapi.yaml");
      const res = validateArtifactDrift(spec, nonExistentPath);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("not found"))).toBe(true);
    });

    it("fails when artifact file has stale content", () => {
      const tempPath = path.resolve(__dirname, "../scratch-stale-openapi.yaml");
      fs.writeFileSync(tempPath, "openapi: 3.1.0\ninfo:\n  title: Stale API\n", "utf-8");
      try {
        const res = validateArtifactDrift(spec, tempPath);
        expect(res.valid).toBe(false);
        expect(res.errors.some((e) => e.includes("stale"))).toBe(true);
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });
  });

  describe("validateRouteInvariants", () => {
    it("passes for all operations in the active OpenAPI specification", () => {
      const res = validateRouteInvariants(spec);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("fails if an operation is missing an operationId", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      delete mutatedSpec.paths["/health"].get.operationId;
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("operationId"))).toBe(true);
    });

    it("fails if duplicate operationIds are used", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      mutatedSpec.paths["/health"].get.operationId = "duplicateOpId";
      mutatedSpec.paths["/metrics"].get.operationId = "duplicateOpId";
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("duplicate operationId"))).toBe(true);
    });

    it("fails if an operation is missing tags", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      mutatedSpec.paths["/health"].get.tags = [];
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("missing tags"))).toBe(true);
    });

    it("fails if an operation is missing summary and description", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      delete mutatedSpec.paths["/health"].get.summary;
      delete mutatedSpec.paths["/health"].get.description;
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("missing summary"))).toBe(true);
    });

    it("fails if a protected route lacks 401/403 responses", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      const authOp = mutatedSpec.paths["/api/users/me"].get;
      delete authOp.responses["401"];
      delete authOp.responses["403"];
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("protected route must document an auth error"))).toBe(true);
    });

    it("fails if URL path parameters are not declared in parameters list", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      mutatedSpec.paths["/api/markets/{id}"].get.parameters = [];
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("path parameter '{id}'"))).toBe(true);
    });

    it("fails if a paginated route does not document a 400 validation error response", () => {
      const mutatedSpec = JSON.parse(JSON.stringify(spec));
      delete mutatedSpec.paths["/api/users"].get.responses["400"];
      const res = validateRouteInvariants(mutatedSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("paginated endpoint must document a 400"))).toBe(true);
    });
  });

  describe("checkOpenApi end-to-end", () => {
    it("returns success: true with zero errors on valid repository state", () => {
      const res = checkOpenApi(spec);
      expect(res.success).toBe(true);
      expect(res.errors).toHaveLength(0);
    });
  });
});
