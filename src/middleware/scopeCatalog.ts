/** Least-privilege domains used by privileged admin and operator workflows. */
export const ADMIN_SCOPES = {
  MARKET_MANAGE: "market:manage",
  SETTLEMENT_EXECUTE: "settlement:execute",
  REPORT_READ: "report:read",
  OPERATIONS_RECOVER: "operations:recover",
} as const;

export type AdminScope = (typeof ADMIN_SCOPES)[keyof typeof ADMIN_SCOPES];

/**
 * Maps the mounted privileged route families to their least-privilege scope.
 * This central fallback protects legacy routers that still use requireAdmin;
 * route modules can use requireScopedAdmin when they need a visible
 * declaration next to the route definition.
 */
export function scopeForAdminPath(path: string): AdminScope {
  if (/\/(?:recon|audit|reports?|schema-versions|rate-limit)(?:\/|$)/.test(path)) {
    return ADMIN_SCOPES.REPORT_READ;
  }
  if (/\/(?:settle|force-resolve)(?:\/|$)/.test(path)) {
    return ADMIN_SCOPES.SETTLEMENT_EXECUTE;
  }
  if (/\/markets(?:\/|$)/.test(path)) return ADMIN_SCOPES.MARKET_MANAGE;
  return ADMIN_SCOPES.OPERATIONS_RECOVER;
}
