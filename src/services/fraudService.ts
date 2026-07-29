/**
 * fraudService.ts — Address-graph fraud-signal detector for GrantFox.
 *
 * Responsibilities
 * ────────────────
 *   1. Pull recent predictions (+ joined users) from the database.
 *   2. Build an undirected graph between Stellar addresses whose edges
 *      represent suspicious overlap:
 *        • SHARED_FUNDING_SOURCE — two addresses funded by the same wallet
 *        • SHARED_TX_HASH        — distinct addresses appearing on the same
 *                                  on-chain transaction (highly unusual)
 *        • REPEATED_PATTERN      — two addresses repeatedly placing the
 *                                  same (market, outcome, amount) bet inside
 *                                  a short time window — likely sybil
 *   3. Run a weighted Union-Find / DSU to collapse connected components.
 *   4. Persist any component of size ≥ MIN_CLUSTER_SIZE as `fraud_flags`
 *      rows (one per address in the cluster), idempotently. Each row
 *      carries the human-readable `reason` and the structured `evidence`.
 *   5. Expose `listFlags` for the admin review endpoint.
 *
 * Boundaries
 * ──────────
 *   • Pure functions (`buildGraph`, `UnionFind`, `clusterize`) have **no**
 *     I/O and are fully unit-tested.
 *   • All DB access funnels through the `FraudRepo` interface so the
 *     worker / route / tests can inject in-memory fakes.
 *   • Inputs from the admin route are validated by Zod at the HTTP
 *     boundary (see src/routes/admin/fraud.ts).
 *
 * Logging
 * ───────
 *   Every public entry point emits structured logs with the active
 *   `correlationId` (from AsyncLocalStorage) so the run can be traced
 *   across the worker → service → repo boundary.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { fraudFlags, predictions, users } from "../db/schema";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

// ──────────────────────────────────────────────────────────────────────────────
// Constants & types
// ──────────────────────────────────────────────────────────────────────────────

/** Minimum component size that warrants flagging. Singletons are ignored. */
export const MIN_CLUSTER_SIZE = 2;

/** Default lookback when the worker is called without an explicit window. */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

/** Default max patterns to consider per scan — guards memory on huge runs. */
export const DEFAULT_MAX_PREDICTIONS = 10_000;

/** Repeated-pattern time bucket: bets within this many ms collide. */
export const PATTERN_BUCKET_MS = 5 * 60 * 1000; // 5 minutes

export type EdgeReason =
  | "SHARED_FUNDING_SOURCE"
  | "SHARED_TX_HASH"
  | "REPEATED_PATTERN";

export interface PredictionRow {
  predictionId: string;
  userId: string;
  stellarAddress: string;
  marketId: string;
  outcome: string;
  amount: string;
  txHash: string;
  fundingSource: string | null;
  createdAt: Date;
}

export interface GraphEdge {
  a: string; // stellar address (lexicographically smaller)
  b: string; // stellar address (lexicographically larger)
  reason: EdgeReason;
  /** Extra context, e.g. the shared funder or the matching pattern key. */
  detail: string;
}

export interface AddressGraph {
  /** Distinct stellar addresses seen in the input. */
  nodes: Set<string>;
  /** Deduplicated edges (same (a, b, reason, detail) collapsed). */
  edges: GraphEdge[];
}

export interface Cluster {
  /** Stable deterministic id derived from the sorted member addresses. */
  key: string;
  /** Member addresses, sorted ascending. */
  members: string[];
  /** Edges that participated in forming this cluster. */
  edges: GraphEdge[];
  /** Aggregate severity score — sum of edge weights. */
  score: number;
}

export interface FlagWriteInput {
  clusterKey: string;
  stellarAddress: string;
  userId: string;
  reason: string;
  score: number;
  evidence: Record<string, unknown>;
  correlationId?: string | null;
}

export interface FraudFlagDTO {
  id: string;
  clusterKey: string;
  userId: string;
  stellarAddress: string;
  reason: string;
  evidence: unknown;
  score: number;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListFlagsFilters {
  status?: "open" | "dismissed" | "confirmed";
  limit?: number;
}

export interface FraudRepo {
  loadRecentPredictions(opts: {
    since: Date;
    limit: number;
  }): Promise<PredictionRow[]>;
  upsertFlags(rows: FlagWriteInput[]): Promise<number>;
  listFlags(filters: ListFlagsFilters): Promise<FraudFlagDTO[]>;
}

// Edge weights — feed into both the cluster `score` and the per-row score.
const EDGE_WEIGHT: Record<EdgeReason, number> = {
  SHARED_FUNDING_SOURCE: 5,
  SHARED_TX_HASH: 8,
  REPEATED_PATTERN: 3,
};

// ──────────────────────────────────────────────────────────────────────────────
// Pure: Union-Find / Disjoint-Set Union
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Classic union-find with path compression + union-by-rank. O(α(n)) per op.
 * `find()` returns the representative; `union()` returns true iff the call
 * actually merged two previously-disjoint sets (useful for edge counters).
 */
export class UnionFind<T = string> {
  private parent = new Map<T, T>();
  private rank = new Map<T, number>();

  add(x: T): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: T): T {
    this.add(x);
    let root = x;
    // climb to the root
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as T;
    }
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as T;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: T, b: T): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
    return true;
  }

  /** Returns components as Map<root, members[]>. */
  components(): Map<T, T[]> {
    const out = new Map<T, T[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const bucket = out.get(root);
      if (bucket) bucket.push(node);
      else out.set(root, [node]);
    }
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure: graph builder
// ──────────────────────────────────────────────────────────────────────────────

function orderedPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/** Stable cluster key — sorted member addresses joined by `|`. */
export function makeClusterKey(members: string[]): string {
  return [...members].sort().join("|");
}

/**
 * Build an undirected suspicion graph from a flat list of predictions.
 *
 * The function is **pure** — no DB, no logging, no clock — which makes it
 * trivial to unit-test deterministically.
 */
export function buildGraph(rows: PredictionRow[]): AddressGraph {
  const nodes = new Set<string>();
  const edgeMap = new Map<string, GraphEdge>(); // key → edge (dedup)

  // Bucket helpers
  const byFunder = new Map<string, Set<string>>();
  const byTxHash = new Map<string, Set<string>>();
  const byPattern = new Map<string, Set<string>>();

  for (const r of rows) {
    if (!r.stellarAddress) continue;
    nodes.add(r.stellarAddress);

    if (r.fundingSource) {
      const set = byFunder.get(r.fundingSource) ?? new Set<string>();
      set.add(r.stellarAddress);
      byFunder.set(r.fundingSource, set);
    }

    if (r.txHash && r.txHash.length > 0) {
      const set = byTxHash.get(r.txHash) ?? new Set<string>();
      set.add(r.stellarAddress);
      byTxHash.set(r.txHash, set);
    }

    // Repeated pattern key: same market, outcome, amount, time-bucket
    const bucket = Math.floor(r.createdAt.getTime() / PATTERN_BUCKET_MS);
    const patternKey = `${r.marketId}|${r.outcome}|${r.amount}|${bucket}`;
    const pSet = byPattern.get(patternKey) ?? new Set<string>();
    pSet.add(r.stellarAddress);
    byPattern.set(patternKey, pSet);
  }

  const addEdge = (
    a: string,
    b: string,
    reason: EdgeReason,
    detail: string,
  ): void => {
    if (a === b) return;
    const [x, y] = orderedPair(a, b);
    const key = `${reason}::${detail}::${x}::${y}`;
    if (edgeMap.has(key)) return;
    edgeMap.set(key, { a: x, b: y, reason, detail });
  };

  // Funder edges
  for (const [funder, addrs] of byFunder) {
    if (addrs.size < 2) continue;
    const list = [...addrs];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addEdge(list[i], list[j], "SHARED_FUNDING_SOURCE", funder);
      }
    }
  }

  // Shared tx_hash edges
  for (const [tx, addrs] of byTxHash) {
    if (addrs.size < 2) continue;
    const list = [...addrs];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addEdge(list[i], list[j], "SHARED_TX_HASH", tx);
      }
    }
  }

  // Repeated pattern edges
  for (const [pat, addrs] of byPattern) {
    if (addrs.size < 2) continue;
    const list = [...addrs];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addEdge(list[i], list[j], "REPEATED_PATTERN", pat);
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

/**
 * Collapse the graph into clusters using union-find.
 * Singleton components (size < MIN_CLUSTER_SIZE) are excluded.
 */
export function clusterize(graph: AddressGraph): Cluster[] {
  const uf = new UnionFind<string>();
  for (const n of graph.nodes) uf.add(n);
  for (const e of graph.edges) uf.union(e.a, e.b);

  // Group edges per root so each cluster carries its own evidence
  const edgesPerRoot = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const root = uf.find(e.a);
    const bucket = edgesPerRoot.get(root) ?? [];
    bucket.push(e);
    edgesPerRoot.set(root, bucket);
  }

  const out: Cluster[] = [];
  for (const [root, members] of uf.components()) {
    if (members.length < MIN_CLUSTER_SIZE) continue;
    const sorted = [...members].sort();
    const edges = edgesPerRoot.get(root) ?? [];
    const score = edges.reduce((s, e) => s + EDGE_WEIGHT[e.reason], 0);
    out.push({
      key: makeClusterKey(sorted),
      members: sorted,
      edges,
      score,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Orchestration — scan + persist
// ──────────────────────────────────────────────────────────────────────────────

export interface RunScanOptions {
  lookbackMs?: number;
  maxPredictions?: number;
  /** Override "now" — used by tests. */
  now?: () => Date;
  correlationId?: string | null;
}

export interface RunScanResult {
  scanned: number;
  edges: number;
  clusters: number;
  flagsWritten: number;
  correlationId: string | null;
}

/**
 * End-to-end: load → build graph → cluster → persist.
 * Idempotent thanks to the `(cluster_key, user_id)` unique index.
 */
export async function runFraudScan(
  repo: FraudRepo,
  opts: RunScanOptions = {},
): Promise<RunScanResult> {
  const now = (opts.now ?? (() => new Date()))();
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const limit = opts.maxPredictions ?? DEFAULT_MAX_PREDICTIONS;
  const correlationId = opts.correlationId ?? getRequestId() ?? null;

  if (!Number.isFinite(lookbackMs) || lookbackMs <= 0) {
    throw new Error("lookbackMs must be a positive finite number");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("maxPredictions must be a positive integer");
  }

  const since = new Date(now.getTime() - lookbackMs);

  logger.info(
    { correlationId, since: since.toISOString(), limit },
    "fraud_scan: start",
  );

  const rows = await repo.loadRecentPredictions({ since, limit });
  const graph = buildGraph(rows);
  const clusters = clusterize(graph);

  // Build address → userId map (last-write wins; addresses are 1:1 with users
  // in this codebase, so this is safe).
  const addrToUser = new Map<string, string>();
  for (const r of rows) {
    if (r.stellarAddress) addrToUser.set(r.stellarAddress, r.userId);
  }

  const flagRows: FlagWriteInput[] = [];
  for (const c of clusters) {
    const reasonsByEdge = c.edges.reduce<Record<string, number>>((acc, e) => {
      acc[e.reason] = (acc[e.reason] ?? 0) + 1;
      return acc;
    }, {});
    const reasonCode =
      Object.entries(reasonsByEdge).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      "ADDRESS_CLUSTER";

    const evidence = {
      clusterSize: c.members.length,
      members: c.members,
      edges: c.edges,
      edgeReasonCounts: reasonsByEdge,
    };

    for (const addr of c.members) {
      const userId = addrToUser.get(addr);
      if (!userId) {
        // Address present in graph but missing user mapping — skip safely.
        logger.warn(
          { correlationId, addr, clusterKey: c.key },
          "fraud_scan: skipping address with no user mapping",
        );
        continue;
      }
      flagRows.push({
        clusterKey: c.key,
        stellarAddress: addr,
        userId,
        reason: reasonCode,
        score: c.score,
        evidence,
        correlationId,
      });
    }
  }

  const written = flagRows.length > 0 ? await repo.upsertFlags(flagRows) : 0;

  const result: RunScanResult = {
    scanned: rows.length,
    edges: graph.edges.length,
    clusters: clusters.length,
    flagsWritten: written,
    correlationId,
  };
  logger.info({ ...result }, "fraud_scan: complete");
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Drizzle-backed repository (production wiring)
// ──────────────────────────────────────────────────────────────────────────────

export class DrizzleFraudRepo implements FraudRepo {
  // Use `any` to remain compatible with the codebase's drizzle helper typing
  // (other services here do the same — see DrizzleMarketResolutionRepo).
  constructor(private readonly db = defaultDb) {}

  async loadRecentPredictions(opts: {
    since: Date;
    limit: number;
  }): Promise<PredictionRow[]> {
    const rows = await this.db
      .select({
        predictionId: predictions.id,
        userId: predictions.userId,
        stellarAddress: users.stellarAddress,
        marketId: predictions.marketId,
        outcome: predictions.outcome,
        amount: predictions.amount,
        txHash: predictions.txHash,
        fundingSource: predictions.fundingSource,
        createdAt: predictions.createdAt,
      })
      .from(predictions)
      .innerJoin(users, eq(users.id, predictions.userId))
      .where(gte(predictions.createdAt, opts.since))
      .orderBy(desc(predictions.createdAt))
      .limit(opts.limit);
    return rows as PredictionRow[];
  }

  async upsertFlags(rows: FlagWriteInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    // ON CONFLICT (cluster_key, user_id) DO UPDATE — keep latest evidence
    // and score, never decrement reviewer state.
    const values = rows.map((r) => ({
      clusterKey: r.clusterKey,
      userId: r.userId,
      stellarAddress: r.stellarAddress,
      reason: r.reason,
      score: r.score,
      evidence: r.evidence,
      correlationId: r.correlationId ?? null,
    }));
    const result = await this.db
      .insert(fraudFlags)
      .values(values)
      .onConflictDoUpdate({
        target: [fraudFlags.clusterKey, fraudFlags.userId],
        set: {
          reason: sql`excluded.reason`,
          score: sql`excluded.score`,
          evidence: sql`excluded.evidence`,
          correlationId: sql`excluded.correlation_id`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: fraudFlags.id });
    return Array.isArray(result) ? result.length : rows.length;
  }

  async listFlags(filters: ListFlagsFilters): Promise<FraudFlagDTO[]> {
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
    const conds = [];
    if (filters.status) conds.push(eq(fraudFlags.status, filters.status));
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await this.db
      .select()
      .from(fraudFlags)
      .where(where)
      .orderBy(desc(fraudFlags.createdAt))
      .limit(limit);
    return rows as FraudFlagDTO[];
  }
}

/** Convenience: list flags for the admin endpoint. */
export async function listFraudFlags(
  filters: ListFlagsFilters,
  repo: FraudRepo = new DrizzleFraudRepo(),
): Promise<FraudFlagDTO[]> {
  return repo.listFlags(filters);
}
