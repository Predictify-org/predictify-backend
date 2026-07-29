/**
 * @module pluginService
 *
 * Owns plugin CRUD for the admin dashboard.
 *
 * Responsibilities:
 *  - List all plugins with optional status filter
 *  - Create a new plugin with unique name enforcement
 *  - Read a single plugin by ID
 *  - Partially update plugin fields (name, description, enabled, config)
 *  - Delete a plugin by ID
 *
 * All mutations are audited through the standard audit service.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { plugins } from "../db/schema";
import type { Plugin } from "../db/schema";
import { createAuditLog } from "./auditService";
import { logger } from "../config/logger";

// ─── PostgreSQL error codes ──────────────────────────────────────────────────

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Checks if an error is a PostgreSQL unique-constraint violation.
 * Drizzle wraps the original pg driver error inside a nested object.
 */
function isUniqueViolation(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === PG_UNIQUE_VIOLATION
  );
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class PluginNotFoundError extends Error {
  constructor(id: string) {
    super(`Plugin not found: ${id}`);
    this.name = "PluginNotFoundError";
  }
}

export class PluginNameConflictError extends Error {
  constructor(name: string) {
    super(`Plugin with name "${name}" already exists`);
    this.name = "PluginNameConflictError";
  }
}

// ─── DTO types ──────────────────────────────────────────────────────────────

export interface PluginView {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePluginInput {
  name: string;
  description?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdatePluginInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ListPluginsFilters {
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface PluginListResult {
  data: PluginView[];
  total: number;
  limit: number;
  offset: number;
}

function toPluginView(p: Plugin): PluginView {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    enabled: p.enabled,
    config: p.config,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
    updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : String(p.updatedAt),
  };
}

// ─── Repository contract ────────────────────────────────────────────────────

export interface PluginRepository {
  list(filters: ListPluginsFilters): Promise<PluginListResult>;
  getById(id: string): Promise<Plugin | null>;
  create(input: CreatePluginInput): Promise<Plugin>;
  update(id: string, input: UpdatePluginInput): Promise<Plugin>;
  delete(id: string): Promise<string | null>;
}

// ─── Repository implementation (Drizzle) ────────────────────────────────────

export class DrizzlePluginRepository implements PluginRepository {
  constructor(private readonly database: typeof db = db) {}

  async list(filters: ListPluginsFilters): Promise<PluginListResult> {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const conditions = [];
    if (filters.enabled !== undefined) {
      conditions.push(eq(plugins.enabled, filters.enabled));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      this.database
        .select()
        .from(plugins)
        .where(where)
        .orderBy(plugins.createdAt)
        .limit(limit)
        .offset(offset),
      this.database
        .select({ count: sql<number>`count(*)` })
        .from(plugins)
        .where(where),
    ]);

    return {
      data: rows.map(toPluginView),
      total: Number(countRows[0]?.count ?? 0),
      limit,
      offset,
    };
  }

  async getById(id: string): Promise<Plugin | null> {
    const rows = await this.database
      .select()
      .from(plugins)
      .where(eq(plugins.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(input: CreatePluginInput): Promise<Plugin> {
    const rows = await this.database
      .insert(plugins)
      .values({
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled ?? true,
        config: input.config ?? {},
      })
      .returning();
    return rows[0]!;
  }

  async update(id: string, input: UpdatePluginInput): Promise<Plugin> {
    const now = new Date();
    const updateData: Record<string, unknown> = { updatedAt: now };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.enabled !== undefined) updateData.enabled = input.enabled;
    if (input.config !== undefined) updateData.config = input.config;

    const rows = await this.database
      .update(plugins)
      .set(updateData)
      .where(eq(plugins.id, id))
      .returning();

    if (rows.length === 0) {
      throw new PluginNotFoundError(id);
    }
    return rows[0]!;
  }

  async delete(id: string): Promise<string | null> {
    const rows = await this.database
      .delete(plugins)
      .where(eq(plugins.id, id))
      .returning({ id: plugins.id, name: plugins.name });

    return rows[0]?.name ?? null;
  }
}

// ─── Audit context ──────────────────────────────────────────────────────────

export interface PluginAuditContext {
  adminAddress: string;
  ip: string;
  correlationId?: string;
}

async function audit(
  action: string,
  pluginId: string,
  pluginName: string,
  ctx: PluginAuditContext,
): Promise<void> {
  await createAuditLog({
    action,
    walletAddress: ctx.adminAddress,
    ip: ctx.ip,
    correlationId: ctx.correlationId,
  });

  logger.info(
    {
      correlationId: ctx.correlationId,
      pluginId,
      pluginName,
      adminAddress: ctx.adminAddress,
      action,
    },
    action,
  );
}

// ─── Public service API ─────────────────────────────────────────────────────

export async function listPlugins(
  filters: ListPluginsFilters,
  repo: PluginRepository = new DrizzlePluginRepository(),
): Promise<PluginListResult> {
  return repo.list(filters);
}

export async function getPlugin(
  id: string,
  repo: PluginRepository = new DrizzlePluginRepository(),
): Promise<PluginView | null> {
  const plugin = await repo.getById(id);
  return plugin ? toPluginView(plugin) : null;
}

export async function createPlugin(
  input: CreatePluginInput,
  ctx: PluginAuditContext,
  repo: PluginRepository = new DrizzlePluginRepository(),
): Promise<PluginView> {
  try {
    const plugin = await repo.create(input);
    await audit("admin.plugin.create", plugin.id, plugin.name, ctx);
    return toPluginView(plugin);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PluginNameConflictError(input.name);
    }
    throw e;
  }
}

export async function updatePlugin(
  id: string,
  input: UpdatePluginInput,
  ctx: PluginAuditContext,
  repo: PluginRepository = new DrizzlePluginRepository(),
): Promise<PluginView> {
  try {
    const plugin = await repo.update(id, input);
    await audit("admin.plugin.update", plugin.id, plugin.name, ctx);
    return toPluginView(plugin);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PluginNameConflictError(input.name ?? "(unknown)");
    }
    throw e;
  }
}

export async function deletePlugin(
  id: string,
  ctx: PluginAuditContext,
  repo: PluginRepository = new DrizzlePluginRepository(),
): Promise<{ id: string; name: string }> {
  const name = await repo.delete(id);
  if (!name) {
    throw new PluginNotFoundError(id);
  }
  await audit("admin.plugin.delete", id, name, ctx);
  return { id, name };
}
