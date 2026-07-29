/**
 * anomalyDetector.ts — signup-rate anomaly detector ("signup flood" alarm).
 *
 * Responsibilities
 * ────────────────
 *   1. Aggregate `users.created_at` into fixed-width time buckets.
 *   2. Learn a **robust** baseline (median + median-absolute-deviation) from
 *      the historical part of the window.
 *   3. Score every bucket in the recent evaluation window against that
 *      baseline and surface the ones that look like a flood.
 *
 * Why robust statistics?
 * ──────────────────────
 *   A mean/standard-deviation baseline is destroyed by the very thing we are
 *   trying to detect: a single large flood inflates the mean *and* the stddev,
 *   so the next flood scores as "normal". Median and MAD have a 50 % breakdown
 *   point, so a burst has to consume half the baseline before it hides itself.
 *   The modified z-score (Iglewicz & Hoaglin) is `0.6745 · (x − median) / MAD`.
 *
 * A single statistic is not enough on its own, so a bucket must clear an
 * **absolute floor** (`minCount`) before any relative rule can fire. That is
 * what stops "1 signup vs. a baseline of 0" from paging someone at 3 a.m.
 *
 * Boundaries
 * ──────────
 *   • The scoring core (`densifyBuckets`, `computeBaseline`, `modifiedZScore`,
 *     `detectAnomalies`) is **pure** — no DB, no clock, no logging — and is
 *     fully unit-tested.
 *   • All DB access funnels through the `SignupAnomalyRepo` interface, so the
 *     worker / route / tests can inject in-memory fakes.
 *   • Every caller-supplied option is validated by Zod
 *     (`signupAnomalyOptionsSchema`) inside `runSignupAnomalyScan`, with tight
 *     bounds, so no caller — including a future HTTP route that forwards query
 *     parameters — can turn this into an unbounded scan. Routes should re-use
 *     the exported schema to return the standard error envelope on 400.
 *
 * Logging
 * ───────
 *   Every scan emits structured logs carrying the active `correlationId`
 *   (explicit → AsyncLocalStorage → null) so a run can be traced across the
 *   worker → service → repo boundary.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb } from "../db";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import {
  signupAnomaliesDetectedTotal,
  signupAnomalyScansTotal,
  signupAnomalyTopScore,
} from "../metrics/registry";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

/** Width of a single rate bucket. */
export const DEFAULT_BUCKET_MS = 5 * 60 * 1000; // 5 minutes

/** How far back the *baseline* is learned from (ends where evaluation begins). */
export const DEFAULT_BASELINE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** The recent slice of time whose buckets get scored. */
export const DEFAULT_EVALUATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Modified z-score above which a bucket is considered anomalous. */
export const DEFAULT_Z_THRESHOLD = 3.5;

/** `count / baselineMedian` above which a bucket is considered anomalous. */
export const DEFAULT_RATIO_THRESHOLD = 4;

/** Absolute floor — quiet systems must not alert on single-digit noise. */
export const DEFAULT_MIN_COUNT = 10;

/** Baseline buckets required before relative rules are trusted. */
export const DEFAULT_MIN_BASELINE_BUCKETS = 6;

/** Consistency constant for the modified z-score (Iglewicz & Hoaglin). */
const MAD_SCALE = 0.6745;

/** Scale factor used when MAD collapses to 0 and we fall back to mean-abs-dev. */
const MEAN_AD_SCALE = 1.253314;

/**
 * Scores are capped so the report stays JSON-safe (`Infinity` serialises to
 * `null`) and so dashboards get a bounded axis.
 */
export const MAX_SCORE = 1000;

/** Hard ceiling on buckets per scan — bounds memory and query cost. */
export const MAX_BUCKETS_PER_SCAN = 5000;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/** One fixed-width slice of the signup timeline. */
export interface SignupBucket {
  /** Inclusive start of the bucket, aligned to a multiple of `bucketMs`. */
  start: Date;
  /** Signups whose `created_at` falls in `[start, start + bucketMs)`. */
  count: number;
}

/** Which rule (or rules) fired for a bucket. */
export type AnomalyTrigger =
  /** Modified z-score cleared `zThreshold`. */
  | "MODIFIED_Z_SCORE"
  /** Count is a large multiple of the baseline median. */
  | "RATIO_TO_BASELINE"
  /** Not enough baseline history yet — absolute floor alone fired. */
  | "COLD_START_BURST";

export type AnomalySeverity = "warning" | "critical";

export interface SignupAnomaly {
  /** ISO-8601 start of the offending bucket. */
  bucketStart: string;
  /** ISO-8601 exclusive end of the offending bucket. */
  bucketEnd: string;
  /** Signups observed in the bucket. */
  count: number;
  /** Baseline median — what we expected to see. */
  expected: number;
  /** `count / max(expected, 1)`, rounded to 2 dp. */
  ratio: number;
  /** Modified z-score, capped at `MAX_SCORE` and rounded to 2 dp. */
  score: number;
  severity: AnomalySeverity;
  /** Every rule that fired, in a stable order. */
  triggers: AnomalyTrigger[];
}

/** Robust dispersion summary of the baseline buckets. */
export interface Baseline {
  /** Median signups per bucket. */
  median: number;
  /** Median absolute deviation from the median. */
  mad: number;
  /** Mean absolute deviation — fallback when MAD collapses to 0. */
  meanAbsDev: number;
  /** Number of baseline buckets that fed the statistics. */
  sampleSize: number;
}

export interface SignupAnomalyReport {
  window: {
    /** Start of the whole scan window (baseline + evaluation). */
    since: string;
    /** Exclusive end of the scan window. */
    until: string;
    /** Start of the evaluation slice. */
    evaluationSince: string;
    bucketMs: number;
  };
  baseline: Baseline;
  /** Buckets scored in the evaluation window. */
  evaluated: number;
  /** Signups observed across the evaluation window. */
  totalSignups: number;
  /** Busiest evaluation bucket, or `null` when the window is empty. */
  peak: { bucketStart: string; count: number } | null;
  /** Anomalous buckets, most severe first. */
  anomalies: SignupAnomaly[];
  /** Highest score seen in the evaluation window (0 when nothing scored). */
  topScore: number;
  correlationId: string | null;
}

/** Data access contract — implemented by Drizzle in prod, fakes in tests. */
export interface SignupAnomalyRepo {
  /**
   * Return signup counts per bucket for `[since, until)`.
   *
   * Implementations may return a **sparse** series (empty buckets omitted);
   * `runSignupAnomalyScan` densifies before scoring.
   */
  loadSignupBuckets(opts: {
    since: Date;
    until: Date;
    bucketMs: number;
  }): Promise<SignupBucket[]>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Options + validation (the boundary)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Tunables for a scan. Every field is optional; bounds are deliberately tight
 * so an untrusted caller cannot turn this into a full-table scan.
 */
export const signupAnomalyOptionsSchema = z
  .object({
    bucketMs: z
      .number()
      .int()
      .min(60_000, { message: "bucketMs must be at least 60000 (1 minute)" })
      .max(3_600_000, { message: "bucketMs must be at most 3600000 (1 hour)" }),
    baselineWindowMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60 * 1000, {
        message: "baselineWindowMs must be at most 7 days",
      }),
    evaluationWindowMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1000, {
        message: "evaluationWindowMs must be at most 24 hours",
      }),
    zThreshold: z.number().min(1).max(100),
    ratioThreshold: z.number().min(1).max(1000),
    minCount: z.number().int().min(1).max(1_000_000),
    minBaselineBuckets: z.number().int().min(1).max(1000),
  })
  .partial()
  .strict()
  .superRefine((opts, ctx) => {
    const bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;
    const baselineWindowMs = opts.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS;
    const evaluationWindowMs =
      opts.evaluationWindowMs ?? DEFAULT_EVALUATION_WINDOW_MS;

    if (evaluationWindowMs < bucketMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evaluationWindowMs"],
        message: "evaluationWindowMs must be greater than or equal to bucketMs",
      });
    }
    if (baselineWindowMs < bucketMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baselineWindowMs"],
        message: "baselineWindowMs must be greater than or equal to bucketMs",
      });
    }
    if ((baselineWindowMs + evaluationWindowMs) / bucketMs > MAX_BUCKETS_PER_SCAN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bucketMs"],
        message:
          `window is too granular: at most ${MAX_BUCKETS_PER_SCAN} buckets ` +
          `per scan (increase bucketMs or shrink the windows)`,
      });
    }
  });

/** Caller-supplied tunables, as validated by {@link signupAnomalyOptionsSchema}. */
export type SignupAnomalyOptions = z.infer<typeof signupAnomalyOptionsSchema>;

/** Fully-resolved detector configuration (defaults applied). */
export interface DetectorConfig {
  bucketMs: number;
  baselineWindowMs: number;
  evaluationWindowMs: number;
  zThreshold: number;
  ratioThreshold: number;
  minCount: number;
  minBaselineBuckets: number;
}

/** Apply defaults to a (already validated) options bag. */
export function resolveConfig(opts: SignupAnomalyOptions = {}): DetectorConfig {
  return {
    bucketMs: opts.bucketMs ?? DEFAULT_BUCKET_MS,
    baselineWindowMs: opts.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS,
    evaluationWindowMs: opts.evaluationWindowMs ?? DEFAULT_EVALUATION_WINDOW_MS,
    zThreshold: opts.zThreshold ?? DEFAULT_Z_THRESHOLD,
    ratioThreshold: opts.ratioThreshold ?? DEFAULT_RATIO_THRESHOLD,
    minCount: opts.minCount ?? DEFAULT_MIN_COUNT,
    minBaselineBuckets: opts.minBaselineBuckets ?? DEFAULT_MIN_BASELINE_BUCKETS,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure: statistics
// ──────────────────────────────────────────────────────────────────────────────

/** Median of a numeric list. Returns 0 for an empty list. Does not mutate. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Robust baseline statistics for a series of bucket counts.
 *
 * Both MAD and mean-absolute-deviation are computed because MAD collapses to
 * zero on very flat series (e.g. a run of identical counts), which would make
 * every z-score infinite.
 */
export function computeBaseline(counts: number[]): Baseline {
  if (counts.length === 0) {
    return { median: 0, mad: 0, meanAbsDev: 0, sampleSize: 0 };
  }
  const med = median(counts);
  const deviations = counts.map((c) => Math.abs(c - med));
  const meanAbsDev =
    deviations.reduce((sum, d) => sum + d, 0) / deviations.length;
  return {
    median: med,
    mad: median(deviations),
    meanAbsDev,
    sampleSize: counts.length,
  };
}

/**
 * Smallest spread we are willing to believe, in MAD units.
 *
 * Signups are arrivals, so bucket counts are approximately Poisson: a stream
 * averaging λ per bucket has σ ≈ √λ purely from chance. Without this floor an
 * unusually flat baseline (say a run of exactly 12s) reports MAD = 0, and a
 * bucket of 13 would score as maximally surprising. Floor the observed spread
 * at the noise a Poisson process would produce anyway.
 */
function poissonSpreadFloor(medianCount: number): number {
  return MAD_SCALE * Math.sqrt(Math.max(medianCount, 0));
}

/**
 * Modified z-score of `value` against `baseline`, capped at {@link MAX_SCORE}.
 *
 * Only *upward* deviations matter for a flood detector, so values at or below
 * the median score 0 rather than going negative.
 */
export function modifiedZScore(value: number, baseline: Baseline): number {
  if (baseline.sampleSize === 0) return 0;
  const delta = value - baseline.median;
  if (delta <= 0) return 0;

  // Preferred: MAD. Fallback: mean absolute deviation (rescaled to be
  // comparable to MAD). Either way, never below the Poisson noise floor.
  const observed =
    baseline.mad > 0
      ? baseline.mad
      : baseline.meanAbsDev > 0
        ? baseline.meanAbsDev * MEAN_AD_SCALE
        : 0;
  const spread = Math.max(observed, poissonSpreadFloor(baseline.median));

  // Spread is only 0 when the baseline is entirely empty — on a system with
  // no signups at all, *any* arrival is maximally surprising. `minCount` is
  // what stops that from paging anyone.
  if (spread === 0) return MAX_SCORE;

  return Math.min((MAD_SCALE * delta) / spread, MAX_SCORE);
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure: bucketing
// ──────────────────────────────────────────────────────────────────────────────

/** Floor a timestamp to the start of its bucket. */
export function bucketStartFor(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

/**
 * Turn a possibly-sparse, possibly-unordered bucket list into a dense,
 * ascending series covering `[since, until)` with zero-filled gaps.
 *
 * Zero-filling matters: without it a flood that silences organic traffic (or a
 * quiet night) would shrink the baseline sample and skew the median upward.
 * Buckets outside the window are dropped; duplicates are summed.
 */
export function densifyBuckets(
  buckets: SignupBucket[],
  opts: { since: Date; until: Date; bucketMs: number },
): SignupBucket[] {
  const { bucketMs } = opts;
  const firstStart = bucketStartFor(opts.since.getTime(), bucketMs);
  const untilMs = opts.until.getTime();

  const counts = new Map<number, number>();
  for (const b of buckets) {
    const startMs = bucketStartFor(b.start.getTime(), bucketMs);
    if (startMs < firstStart || startMs >= untilMs) continue;
    if (!Number.isFinite(b.count) || b.count <= 0) continue;
    counts.set(startMs, (counts.get(startMs) ?? 0) + b.count);
  }

  const series: SignupBucket[] = [];
  for (let t = firstStart; t < untilMs; t += bucketMs) {
    series.push({ start: new Date(t), count: counts.get(t) ?? 0 });
  }
  return series;
}

/**
 * Convenience for callers holding raw signup timestamps rather than
 * pre-aggregated counts (fixtures, backfills, small datasets).
 */
export function bucketizeSignups(
  timestamps: Date[],
  opts: { since: Date; until: Date; bucketMs: number },
): SignupBucket[] {
  return densifyBuckets(
    timestamps.map((t) => ({ start: t, count: 1 })),
    opts,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure: detection
// ──────────────────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Score `evaluation` buckets against a baseline learned from `baselineSeries`.
 *
 * A bucket is anomalous when it clears the absolute floor **and** at least one
 * relative rule fires. Severity escalates to `critical` at twice either
 * relative threshold.
 */
export function detectAnomalies(
  baselineSeries: SignupBucket[],
  evaluation: SignupBucket[],
  config: DetectorConfig,
): { baseline: Baseline; anomalies: SignupAnomaly[]; topScore: number } {
  const baseline = computeBaseline(baselineSeries.map((b) => b.count));
  const hasBaseline = baseline.sampleSize >= config.minBaselineBuckets;

  const anomalies: SignupAnomaly[] = [];
  let topScore = 0;

  for (const bucket of evaluation) {
    const score = hasBaseline ? modifiedZScore(bucket.count, baseline) : 0;
    if (score > topScore) topScore = score;

    // Absolute floor first — cheapest check, and it gates everything else.
    if (bucket.count < config.minCount) continue;

    const expected = hasBaseline ? baseline.median : 0;
    const ratio = bucket.count / Math.max(expected, 1);

    const triggers: AnomalyTrigger[] = [];
    if (!hasBaseline) {
      // Not enough history to say what "normal" is; the floor alone fired.
      triggers.push("COLD_START_BURST");
    } else {
      if (score >= config.zThreshold) triggers.push("MODIFIED_Z_SCORE");
      if (ratio >= config.ratioThreshold) triggers.push("RATIO_TO_BASELINE");
    }
    if (triggers.length === 0) continue;

    const severity: AnomalySeverity =
      score >= config.zThreshold * 2 || ratio >= config.ratioThreshold * 2
        ? "critical"
        : "warning";

    anomalies.push({
      bucketStart: bucket.start.toISOString(),
      bucketEnd: new Date(bucket.start.getTime() + config.bucketMs).toISOString(),
      count: bucket.count,
      expected,
      ratio: round2(ratio),
      score: round2(score),
      severity,
      triggers,
    });
  }

  // Most severe first, then most recent — the shape an on-call reader wants.
  anomalies.sort(
    (a, b) => b.score - a.score || b.bucketStart.localeCompare(a.bucketStart),
  );

  return { baseline, anomalies, topScore: round2(topScore) };
}

// ──────────────────────────────────────────────────────────────────────────────
// Orchestration — load + detect + report
// ──────────────────────────────────────────────────────────────────────────────

export interface RunSignupAnomalyScanOptions extends SignupAnomalyOptions {
  /** Override "now" — used by tests. */
  now?: () => Date;
  correlationId?: string | null;
}

/**
 * End-to-end scan: validate → load → densify → split → score → report.
 *
 * Read-only: nothing is persisted, so re-running is free and idempotent.
 * Findings are surfaced via the return value, structured logs, and Prometheus
 * metrics.
 *
 * @throws {ZodError} when `opts` violates {@link signupAnomalyOptionsSchema}.
 */
export async function runSignupAnomalyScan(
  repo: SignupAnomalyRepo,
  opts: RunSignupAnomalyScanOptions = {},
): Promise<SignupAnomalyReport> {
  const { now: nowFn, correlationId: explicitCorrelationId, ...tunables } = opts;

  // Validate again at the service boundary — a direct caller (worker, script)
  // never reaches the route's Zod check.
  const config = resolveConfig(signupAnomalyOptionsSchema.parse(tunables));

  const now = (nowFn ?? (() => new Date()))();
  const correlationId = explicitCorrelationId ?? getRequestId() ?? null;

  // Align the window to bucket boundaries so buckets are stable across runs.
  const untilMs =
    bucketStartFor(now.getTime(), config.bucketMs) + config.bucketMs;
  const evaluationSinceMs = untilMs - config.evaluationWindowMs;
  const sinceMs = evaluationSinceMs - config.baselineWindowMs;

  const since = new Date(sinceMs);
  const until = new Date(untilMs);
  const evaluationSince = new Date(evaluationSinceMs);

  logger.info(
    {
      correlationId,
      since: since.toISOString(),
      until: until.toISOString(),
      bucketMs: config.bucketMs,
    },
    "signup_anomaly_scan: start",
  );

  const raw = await repo.loadSignupBuckets({
    since,
    until,
    bucketMs: config.bucketMs,
  });
  const series = densifyBuckets(raw, { since, until, bucketMs: config.bucketMs });

  const splitIndex = series.findIndex(
    (b) => b.start.getTime() >= evaluationSinceMs,
  );
  const baselineSeries = splitIndex === -1 ? series : series.slice(0, splitIndex);
  const evaluation = splitIndex === -1 ? [] : series.slice(splitIndex);

  const { baseline, anomalies, topScore } = detectAnomalies(
    baselineSeries,
    evaluation,
    config,
  );

  const totalSignups = evaluation.reduce((sum, b) => sum + b.count, 0);
  const peakBucket = evaluation.reduce<SignupBucket | null>(
    (best, b) => (best === null || b.count > best.count ? b : best),
    null,
  );

  const report: SignupAnomalyReport = {
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      evaluationSince: evaluationSince.toISOString(),
      bucketMs: config.bucketMs,
    },
    baseline,
    evaluated: evaluation.length,
    totalSignups,
    peak:
      peakBucket === null
        ? null
        : { bucketStart: peakBucket.start.toISOString(), count: peakBucket.count },
    anomalies,
    topScore,
    correlationId,
  };

  signupAnomalyScansTotal.inc();
  signupAnomalyTopScore.set(topScore);
  for (const a of anomalies) {
    signupAnomaliesDetectedTotal.inc({ severity: a.severity });
  }

  if (anomalies.length > 0) {
    logger.warn(
      {
        correlationId,
        anomalies: anomalies.length,
        topScore,
        totalSignups,
        peak: report.peak,
        baselineMedian: baseline.median,
        severities: anomalies.map((a) => a.severity),
      },
      "signup_anomaly_scan: signup flood detected",
    );
  } else {
    logger.info(
      { correlationId, evaluated: evaluation.length, totalSignups, topScore },
      "signup_anomaly_scan: complete",
    );
  }

  return report;
}

// ──────────────────────────────────────────────────────────────────────────────
// Drizzle-backed repository (production wiring)
// ──────────────────────────────────────────────────────────────────────────────

/** Row shape returned by the bucketing query. */
interface BucketRow extends Record<string, unknown> {
  bucket_start: string | Date;
  signups: string | number;
}

export class DrizzleSignupAnomalyRepo implements SignupAnomalyRepo {
  // `any` mirrors the other services here (see DrizzleFraudRepo) — the shared
  // drizzle helper is not generically typed in this codebase.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = defaultDb) {}

  /**
   * Aggregate in the database rather than streaming rows into Node: a 24 h
   * window at 5-minute buckets is 288 rows regardless of signup volume.
   *
   * `bucketMs` is bound as a parameter (never interpolated), and the epoch
   * arithmetic keeps bucket boundaries identical to `bucketStartFor` so the
   * pure and SQL paths agree.
   */
  async loadSignupBuckets(opts: {
    since: Date;
    until: Date;
    bucketMs: number;
  }): Promise<SignupBucket[]> {
    const bucketSeconds = opts.bucketMs / 1000;
    const result = (await this.db.execute(
      sql`
        SELECT
          to_timestamp(
            floor(extract(epoch FROM created_at) / ${bucketSeconds})
              * ${bucketSeconds}
          ) AS bucket_start,
          count(*)::int AS signups
        FROM users
        WHERE created_at >= ${opts.since} AND created_at < ${opts.until}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    )) as { rows?: BucketRow[] } | undefined;
    const rows: BucketRow[] = result?.rows ?? [];
    return rows.map((r) => ({
      start: r.bucket_start instanceof Date
        ? r.bucket_start
        : new Date(r.bucket_start),
      count: Number(r.signups),
    }));
  }
}

/** Convenience for routes/workers that do not care about repo wiring. */
export async function scanSignupAnomalies(
  opts: RunSignupAnomalyScanOptions = {},
  repo: SignupAnomalyRepo = new DrizzleSignupAnomalyRepo(),
): Promise<SignupAnomalyReport> {
  return runSignupAnomalyScan(repo, opts);
}
