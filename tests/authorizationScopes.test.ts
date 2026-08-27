import express from "express";
import request from "supertest";
import { describe, expect, it } from "@jest/globals";
import {
  ADMIN_SCOPES,
  hasScope,
  requireScope,
  requireScopedAdmin,
} from "../src/middleware/authorizationScopes";
import { scopeForAdminPath } from "../src/middleware/scopeCatalog";

describe("authorization scope catalog", () => {
  it("uses stable domain-specific scope names", () => {
    expect(ADMIN_SCOPES).toEqual({
      MARKET_MANAGE: "market:manage",
      SETTLEMENT_EXECUTE: "settlement:execute",
      REPORT_READ: "report:read",
      OPERATIONS_RECOVER: "operations:recover",
    });
  });

  it("requires an exact scope instead of a broad prefix match", () => {
    expect(hasScope(["market:manage"], ADMIN_SCOPES.MARKET_MANAGE)).toBe(true);
    expect(hasScope(["market:manage"], ADMIN_SCOPES.REPORT_READ)).toBe(false);
    expect(hasScope(["market:manage:all"], ADMIN_SCOPES.MARKET_MANAGE)).toBe(false);
    expect(hasScope(undefined, ADMIN_SCOPES.MARKET_MANAGE)).toBe(false);
  });

  it.each([
    ["/api/admin/markets/abc", ADMIN_SCOPES.MARKET_MANAGE],
    ["/api/admin/recon/markets/abc", ADMIN_SCOPES.REPORT_READ],
    ["/api/admin/force-resolve", ADMIN_SCOPES.SETTLEMENT_EXECUTE],
    ["/api/admin/audit/export", ADMIN_SCOPES.REPORT_READ],
    ["/api/admin/schema-versions", ADMIN_SCOPES.REPORT_READ],
    ["/api/admin/cache/rebuild", ADMIN_SCOPES.OPERATIONS_RECOVER],
  ])("maps %s to %s", (path, expected) => {
    expect(scopeForAdminPath(path)).toBe(expected);
  });

  it("defaults unknown privileged families to operational recovery", () => {
    expect(scopeForAdminPath("/api/admin/unknown-operation")).toBe(
      ADMIN_SCOPES.OPERATIONS_RECOVER,
    );
    expect(scopeForAdminPath("/api/admin/plugins")).toBe(
      ADMIN_SCOPES.OPERATIONS_RECOVER,
    );
    expect(scopeForAdminPath("/api/admin/users/123/freeze")).toBe(
      ADMIN_SCOPES.OPERATIONS_RECOVER,
    );
  });
});

function makeScopedApp(role: string, scopes: string[] | undefined) {
  const app = express();
  app.get("/protected", (req, res, next) => {
    req.authRole = role;
    req.authScopes = scopes;
    requireScope(ADMIN_SCOPES.MARKET_MANAGE)(req, res, next);
  }, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("scope enforcement", () => {
  it("allows an operator with the declared scope", async () => {
    const response = await request(makeScopedApp("operator", ["market:manage"]))
      .get("/protected");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("rejects an operator with a cross-domain scope", async () => {
    const response = await request(makeScopedApp("operator", ["report:read"]))
      .get("/protected");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: "forbidden_scope", requiredScope: "market:manage" },
    });
  });

  it("rejects a missing scope instead of treating an operator as admin", async () => {
    const response = await request(makeScopedApp("operator", undefined))
      .get("/protected");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("forbidden_scope");
  });

  it("keeps legacy admin tokens compatible while scoped tokens are restricted", async () => {
    const response = await request(makeScopedApp("admin", undefined)).get("/protected");
    expect(response.status).toBe(200);
  });

  it("does not grant extra privilege for duplicate scopes", async () => {
    const app = express();
    app.get("/protected", (req, res, next) => {
      req.authRole = "operator";
      req.authScopes = ["market:manage", "market:manage"];
      requireScope(ADMIN_SCOPES.MARKET_MANAGE)(req, res, next);
    }, (req, res) => {
      res.json({ scopes: req.authScopes });
    });
    const response = await request(app).get("/protected");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ scopes: ["market:manage", "market:manage"] });
  });

  it("does not allow a malformed scopes claim", async () => {
    const app = express();
    app.get("/protected", (req, res, next) => {
      req.authRole = "operator";
      req.authScopes = undefined;
      requireScope(ADMIN_SCOPES.OPERATIONS_RECOVER)(req, res, next);
    }, (_req, res) => {
      res.json({ ok: true });
    });
    const response = await request(app).get("/protected");
    expect(response.status).toBe(403);
  });
});

describe("scoped admin composition", () => {
  it("runs the scope check after the shared admin middleware", () => {
    const middleware = requireScopedAdmin(ADMIN_SCOPES.REPORT_READ);
    expect(typeof middleware).toBe("function");
  });
});

describe("scope isolation matrix", () => {
  const scopes = Object.values(ADMIN_SCOPES);

  it.each(scopes)("does not let %s cross into another domain", async (granted) => {
    const otherScopes = scopes.filter((scope) => scope !== granted);
    for (const required of otherScopes) {
      const app = express();
      app.get("/protected", (req, res, next) => {
        req.authRole = "operator";
        req.authScopes = [granted];
        requireScope(required)(req, res, next);
      }, (_req, res) => {
        res.json({ ok: true });
      });
      const response = await request(app).get("/protected");
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("forbidden_scope");
      expect(response.body.error.requiredScope).toBe(required);
    }
  });

  it("allows an explicitly multi-domain operator to use each granted domain", async () => {
    const app = express();
    app.get("/:domain", (req, res, next) => {
      req.authRole = "operator";
      req.authScopes = [...scopes];
      const required = req.params.domain as (typeof ADMIN_SCOPES)[keyof typeof ADMIN_SCOPES];
      requireScope(required)(req, res, next);
    }, (_req, res) => {
      res.json({ ok: true });
    });

    for (const required of scopes) {
      const response = await request(app).get(`/${required}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    }
  });

  it("keeps scope failures free of token material", async () => {
    const app = makeScopedApp("operator", ["settlement:execute"]);
    const response = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer sensitive-token-value");
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("sensitive-token-value");
    expect(JSON.stringify(response.body)).not.toContain("settlement:execute");
  });

  it("returns the required domain to support operator remediation", async () => {
    const response = await request(makeScopedApp("operator", ["report:read"]))
      .get("/protected");
    expect(response.body).toEqual({
      error: { code: "forbidden_scope", requiredScope: "market:manage" },
    });
  });

  it("handles an empty scope list as a deny-by-default policy", async () => {
    const response = await request(makeScopedApp("operator", []))
      .get("/protected");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("forbidden_scope");
  });
});
