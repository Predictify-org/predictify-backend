import {
  DEFAULT_BUCKET_MS,
  DrizzleSignupAnomalyRepo,
  MAX_BUCKETS_PER_SCAN,
  MAX_SCORE,
  type SignupAnomalyRepo,
  type SignupBucket,
  bucketStartFor,
  bucketizeSignups,
  computeBaseline,
  densifyBuckets,
  detectAnomalies,
  median,
  modifiedZScore,
  resolveConfig,
  runSignupAnomalyScan,
  scanSignupAnomalies,
  signupAnomalyOptionsSchema,
} from "../src/services/anomalyDetector";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

/** A bucket-aligned instant so windows are deterministic. */
const NOW = new Date("2026-07-24T12:00:00.000Z");
const MINUTE = 60_000;

class FakeRepo implements SignupAnomalyRepo {
  buckets: SignupBucket[] = [];
  calls: { since: Date; until: Date; bucketMs: number }[] = [];
  shouldThrow = false;

  async loadSignupBuckets(opts: {
    since: Date;
    until: Date;
    bucketMs: number;
  }): Promise<SignupBucket[]> {
    this.calls.push(opts);
    if (this.shouldThrow) throw new Error("db down");
    return this.buckets;
  }
}

/**
 * Build a flat baseline of `count` signups per bucket filling `[since, until)`,
 * then overwrite the final `flood.length` buckets with the flood values.
 */
function series(
  until: Date,
  bucketMs: number,
  baseline: number[],
  flood: number[] = [],
): SignupBucket[] {
  const all = [...baseline, ...flood];
  const startMs = until.getTime() - all.length * bucketMs;
  return all.map((count, i) => ({
    start: new Date(startMs + i * bucketMs),
    count,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure statistics
// ──────────────────────────────────────────────────────────────────────────────

describe("median", () => {
  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });

  it("returns the middle element for odd-length lists", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the two middle elements for even-length lists", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("computeBaseline", () => {
  it("returns zeros for an empty sample", () => {
    expect(computeBaseline([])).toEqual({
      median: 0,
      mad: 0,
      meanAbsDev: 0,
      sampleSize: 0,
    });
  });

  it("computes median, MAD and mean absolute deviation", () => {
    const b = computeBaseline([1, 2, 3, 4, 100]);
    expect(b.median).toBe(3);
    // deviations: 2, 1, 0, 1, 97 → median 1
    expect(b.mad).toBe(1);
    expect(b.meanAbsDev).toBeCloseTo(20.2, 5);
    expect(b.sampleSize).toBe(5);
  });

  it("reports zero spread for a perfectly flat sample", () => {
    const b = computeBaseline([4, 4, 4, 4]);
    expect(b.median).toBe(4);
    expect(b.mad).toBe(0);
    expect(b.meanAbsDev).toBe(0);
  });

  it("is robust: one huge outlier does not move the median", () => {
    const flat = computeBaseline([5, 5, 5, 5, 5, 5, 5]);
    const contaminated = computeBaseline([5, 5, 5, 5, 5, 5, 100_000]);
    expect(contaminated.median).toBe(flat.median);
  });
});

describe("modifiedZScore", () => {
  // median 7, deviations all 3 → MAD 3, comfortably above the Poisson floor
  // (0.6745·√7 ≈ 1.78) so this baseline exercises the MAD path.
  const baseline = computeBaseline([4, 4, 10, 10, 4, 10]);

  it("returns 0 when there is no baseline sample", () => {
    expect(modifiedZScore(500, computeBaseline([]))).toBe(0);
  });

  it("returns 0 for values at or below the median (downward is not a flood)", () => {
    expect(modifiedZScore(baseline.median, baseline)).toBe(0);
    expect(modifiedZScore(0, baseline)).toBe(0);
  });

  it("scales the deviation by MAD", () => {
    expect(baseline.median).toBe(7);
    expect(baseline.mad).toBe(3);
    expect(modifiedZScore(13, baseline)).toBeCloseTo((0.6745 * 6) / 3, 5);
  });

  it("falls back to the mean absolute deviation when MAD is 0", () => {
    // [1,1,1,1,9] → median 1, deviations [0,0,0,0,8] → MAD 0, meanAbsDev 1.6.
    // Rescaled meanAbsDev (2.005) beats the Poisson floor (0.6745·√1 ≈ 0.67).
    const b = computeBaseline([1, 1, 1, 1, 9]);
    expect(b.mad).toBe(0);
    const expected = (0.6745 * 4) / (1.6 * 1.253314);
    expect(modifiedZScore(5, b)).toBeCloseTo(expected, 5);
  });

  it("floors the spread at Poisson noise when the baseline is perfectly flat", () => {
    // [12,12,12,12] → MAD 0 and meanAbsDev 0; without the floor a single extra
    // signup would score MAX_SCORE.
    const flat = computeBaseline([12, 12, 12, 12]);
    expect(flat.mad).toBe(0);
    expect(modifiedZScore(13, flat)).toBeCloseTo(
      (0.6745 * 1) / (0.6745 * Math.sqrt(12)),
      5,
    );
    expect(modifiedZScore(13, flat)).toBeLessThan(1);
    // A real flood still scores far above the threshold.
    expect(modifiedZScore(900, flat)).toBeGreaterThan(100);
  });

  it("returns the capped score when the baseline is entirely empty", () => {
    expect(modifiedZScore(50, computeBaseline([0, 0, 0, 0]))).toBe(MAX_SCORE);
  });

  it("caps enormous deviations at MAX_SCORE", () => {
    expect(modifiedZScore(1e12, baseline)).toBe(MAX_SCORE);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bucketing
// ──────────────────────────────────────────────────────────────────────────────

describe("bucketStartFor", () => {
  it("floors a timestamp to its bucket boundary", () => {
    const t = new Date("2026-07-24T12:07:31.500Z").getTime();
    expect(new Date(bucketStartFor(t, 5 * MINUTE)).toISOString()).toBe(
      "2026-07-24T12:05:00.000Z",
    );
  });

  it("is idempotent on an already-aligned timestamp", () => {
    const t = new Date("2026-07-24T12:05:00.000Z").getTime();
    expect(bucketStartFor(bucketStartFor(t, 5 * MINUTE), 5 * MINUTE)).toBe(t);
  });
});

describe("densifyBuckets", () => {
  const since = new Date("2026-07-24T12:00:00.000Z");
  const until = new Date("2026-07-24T12:15:00.000Z");
  const opts = { since, until, bucketMs: 5 * MINUTE };

  it("zero-fills gaps and produces an ascending dense series", () => {
    const out = densifyBuckets(
      [{ start: new Date("2026-07-24T12:10:00.000Z"), count: 7 }],
      opts,
    );
    expect(out.map((b) => b.count)).toEqual([0, 0, 7]);
    expect(out[0].start.toISOString()).toBe("2026-07-24T12:00:00.000Z");
  });

  it("returns an empty series when the window is empty", () => {
    expect(densifyBuckets([], { ...opts, until: since })).toEqual([]);
  });

  it("sums duplicate buckets that land in the same slot", () => {
    const out = densifyBuckets(
      [
        { start: new Date("2026-07-24T12:00:00.000Z"), count: 2 },
        { start: new Date("2026-07-24T12:03:00.000Z"), count: 3 },
      ],
      opts,
    );
    expect(out[0].count).toBe(5);
  });

  it("drops buckets outside the window and non-positive counts", () => {
    const out = densifyBuckets(
      [
        { start: new Date("2026-07-24T11:50:00.000Z"), count: 9 }, // before
        { start: new Date("2026-07-24T12:15:00.000Z"), count: 9 }, // at `until`
        { start: new Date("2026-07-24T12:05:00.000Z"), count: 0 },
        { start: new Date("2026-07-24T12:05:00.000Z"), count: Number.NaN },
      ],
      opts,
    );
    expect(out.map((b) => b.count)).toEqual([0, 0, 0]);
  });

  it("re-sorts unordered input", () => {
    const out = densifyBuckets(
      [
        { start: new Date("2026-07-24T12:10:00.000Z"), count: 3 },
        { start: new Date("2026-07-24T12:00:00.000Z"), count: 1 },
      ],
      opts,
    );
    expect(out.map((b) => b.count)).toEqual([1, 0, 3]);
  });
});

describe("bucketizeSignups", () => {
  it("counts raw timestamps into their buckets", () => {
    const out = bucketizeSignups(
      [
        new Date("2026-07-24T12:00:10.000Z"),
        new Date("2026-07-24T12:04:59.999Z"),
        new Date("2026-07-24T12:12:00.000Z"),
      ],
      {
        since: new Date("2026-07-24T12:00:00.000Z"),
        until: new Date("2026-07-24T12:15:00.000Z"),
        bucketMs: 5 * MINUTE,
      },
    );
    expect(out.map((b) => b.count)).toEqual([2, 0, 1]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Detection
// ──────────────────────────────────────────────────────────────────────────────

describe("detectAnomalies", () => {
  const config = resolveConfig();
  const base = new Date("2026-07-24T00:00:00.000Z").getTime();
  const bucket = (i: number, count: number): SignupBucket => ({
    start: new Date(base + i * DEFAULT_BUCKET_MS),
    count,
  });

  const steadyBaseline = [10, 11, 9, 10, 12, 10, 11, 9].map((c, i) =>
    bucket(i, c),
  );

  it("reports nothing when traffic stays near the baseline", () => {
    const out = detectAnomalies(steadyBaseline, [bucket(8, 12)], config);
    expect(out.anomalies).toEqual([]);
  });

  it("flags a bucket whose z-score clears the threshold", () => {
    const out = detectAnomalies(steadyBaseline, [bucket(8, 400)], config);
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0].triggers).toContain("MODIFIED_Z_SCORE");
    expect(out.anomalies[0].count).toBe(400);
    expect(out.anomalies[0].expected).toBe(10);
    expect(out.anomalies[0].severity).toBe("critical");
  });

  it("flags on the ratio rule alone when the z-score stays below threshold", () => {
    // Wildly noisy baseline (median 10, MAD 10) keeps z at 2.7 — under the 3.5
    // threshold — but 5x the median is still a flood.
    const noisy = [0, 0, 0, 20, 20, 20, 10, 10].map((c, i) => bucket(i, c));
    const out = detectAnomalies(noisy, [bucket(8, 50)], config);
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0].triggers).toEqual(["RATIO_TO_BASELINE"]);
    expect(out.anomalies[0].score).toBeLessThan(config.zThreshold);
    expect(out.anomalies[0].severity).toBe("warning");
  });

  it("respects the absolute floor: small spikes on a quiet system are ignored", () => {
    const quiet = new Array(8).fill(0).map((_, i) => bucket(i, 0));
    // 9 signups against a baseline of 0 is a huge ratio but below minCount(10).
    const out = detectAnomalies(quiet, [bucket(8, 9)], config);
    expect(out.anomalies).toEqual([]);
  });

  it("flags a cold start burst when there is not enough baseline history", () => {
    const out = detectAnomalies([bucket(0, 1)], [bucket(1, 250)], config);
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0].triggers).toEqual(["COLD_START_BURST"]);
    expect(out.anomalies[0].expected).toBe(0);
    expect(out.anomalies[0].score).toBe(0);
  });

  it("grades a moderate spike as warning and a severe one as critical", () => {
    // median 10 → spread floors at 0.6745·√10 ≈ 2.13; z(25) ≈ 4.7 (over the
    // 3.5 threshold, under the 7.0 critical line), z(90) ≈ 25.
    const tight = [10, 10, 10, 11, 10, 9, 10, 10].map((c, i) => bucket(i, c));
    const warn = detectAnomalies(tight, [bucket(8, 25)], config).anomalies[0];
    expect(warn.severity).toBe("warning");
    expect(warn.triggers).toEqual(["MODIFIED_Z_SCORE"]);
    const crit = detectAnomalies(tight, [bucket(8, 90)], config).anomalies[0];
    expect(crit.severity).toBe("critical");
  });

  it("sorts anomalies by score descending", () => {
    const out = detectAnomalies(
      steadyBaseline,
      [bucket(8, 60), bucket(9, 800), bucket(10, 200)],
      config,
    );
    expect(out.anomalies.map((a) => a.count)).toEqual([800, 200, 60]);
  });

  it("reports the top score even when no bucket is anomalous", () => {
    const out = detectAnomalies(steadyBaseline, [bucket(8, 9)], config);
    expect(out.anomalies).toEqual([]);
    expect(out.topScore).toBe(0);
  });

  it("emits JSON-safe finite numbers even at the score cap", () => {
    const flat = new Array(8).fill(0).map((_, i) => bucket(i, 5));
    const a = detectAnomalies(flat, [bucket(8, 5000)], config).anomalies[0];
    expect(Number.isFinite(a.score)).toBe(true);
    expect(a.score).toBe(MAX_SCORE);
    expect(JSON.parse(JSON.stringify(a)).score).toBe(MAX_SCORE);
  });

  it("exposes the bucket boundaries as ISO strings", () => {
    const a = detectAnomalies(steadyBaseline, [bucket(8, 400)], config)
      .anomalies[0];
    expect(new Date(a.bucketEnd).getTime() - new Date(a.bucketStart).getTime())
      .toBe(config.bucketMs);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Options validation
// ──────────────────────────────────────────────────────────────────────────────

describe("signupAnomalyOptionsSchema", () => {
  it("accepts an empty object (all defaults)", () => {
    expect(signupAnomalyOptionsSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys", () => {
    expect(signupAnomalyOptionsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it.each([
    ["bucketMs too small", { bucketMs: 1000 }],
    ["bucketMs too large", { bucketMs: 7_200_000 }],
    ["baselineWindowMs beyond 7 days", { baselineWindowMs: 8 * 86_400_000 }],
    ["evaluationWindowMs beyond 24h", { evaluationWindowMs: 25 * 3_600_000 }],
    ["zThreshold below 1", { zThreshold: 0.5 }],
    ["ratioThreshold below 1", { ratioThreshold: 0 }],
    ["minCount below 1", { minCount: 0 }],
    ["non-integer bucketMs", { bucketMs: 60_000.5 }],
  ])("rejects %s", (_label, input) => {
    expect(signupAnomalyOptionsSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an evaluation window narrower than one bucket", () => {
    const res = signupAnomalyOptionsSchema.safeParse({
      bucketMs: 600_000,
      evaluationWindowMs: 60_000,
    });
    expect(res.success).toBe(false);
  });

  it("rejects a baseline window narrower than one bucket", () => {
    const res = signupAnomalyOptionsSchema.safeParse({
      bucketMs: 600_000,
      baselineWindowMs: 60_000,
    });
    expect(res.success).toBe(false);
  });

  it("rejects a window that would exceed the bucket ceiling", () => {
    const res = signupAnomalyOptionsSchema.safeParse({
      bucketMs: 60_000,
      baselineWindowMs: 7 * 86_400_000,
    });
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error.issues[0].message).toContain(
      String(MAX_BUCKETS_PER_SCAN),
    );
  });
});

describe("resolveConfig", () => {
  it("applies every default", () => {
    expect(resolveConfig()).toEqual({
      bucketMs: 300_000,
      baselineWindowMs: 86_400_000,
      evaluationWindowMs: 1_800_000,
      zThreshold: 3.5,
      ratioThreshold: 4,
      minCount: 10,
      minBaselineBuckets: 6,
    });
  });

  it("lets callers override individual knobs", () => {
    expect(resolveConfig({ minCount: 99 }).minCount).toBe(99);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Orchestration
// ──────────────────────────────────────────────────────────────────────────────

describe("runSignupAnomalyScan", () => {
  const now = () => NOW;

  it("queries a bucket-aligned window covering baseline + evaluation", async () => {
    const repo = new FakeRepo();
    const report = await runSignupAnomalyScan(repo, { now });

    const call = repo.calls[0];
    expect(call.bucketMs).toBe(DEFAULT_BUCKET_MS);
    // NOW is bucket-aligned, so `until` is one bucket past it.
    expect(call.until.toISOString()).toBe("2026-07-24T12:05:00.000Z");
    expect(call.since.toISOString()).toBe("2026-07-23T11:35:00.000Z");
    expect(report.window.evaluationSince).toBe("2026-07-24T11:35:00.000Z");
    // 30-minute evaluation window at 5-minute buckets.
    expect(report.evaluated).toBe(6);
  });

  it("returns an all-clear report for steady traffic", async () => {
    const repo = new FakeRepo();
    const until = new Date("2026-07-24T12:05:00.000Z");
    repo.buckets = series(
      until,
      DEFAULT_BUCKET_MS,
      new Array(288).fill(12), // 24h of steady traffic
      [12, 11, 13, 12, 12, 12],
    );

    const report = await runSignupAnomalyScan(repo, { now });
    expect(report.anomalies).toEqual([]);
    expect(report.baseline.median).toBe(12);
    expect(report.totalSignups).toBe(72);
    expect(report.peak).toEqual({
      bucketStart: "2026-07-24T11:45:00.000Z",
      count: 13,
    });
  });

  it("detects a signup flood in the evaluation window", async () => {
    const repo = new FakeRepo();
    const until = new Date("2026-07-24T12:05:00.000Z");
    repo.buckets = series(
      until,
      DEFAULT_BUCKET_MS,
      new Array(288).fill(12),
      [12, 13, 900, 1200, 11, 12],
    );

    const report = await runSignupAnomalyScan(repo, { now });
    expect(report.anomalies).toHaveLength(2);
    expect(report.anomalies.map((a) => a.count)).toEqual([1200, 900]);
    expect(report.anomalies.every((a) => a.severity === "critical")).toBe(true);
    expect(report.peak?.count).toBe(1200);
    expect(report.topScore).toBeGreaterThan(3.5);
  });

  it("does not let an earlier flood poison the baseline for a later one", async () => {
    const repo = new FakeRepo();
    const until = new Date("2026-07-24T12:05:00.000Z");
    const baseline = new Array(288).fill(10);
    // A previous flood sits inside the baseline window.
    baseline.splice(100, 6, 5000, 5000, 5000, 5000, 5000, 5000);
    repo.buckets = series(until, DEFAULT_BUCKET_MS, baseline, [
      10, 10, 10, 10, 10, 800,
    ]);

    const report = await runSignupAnomalyScan(repo, { now });
    expect(report.baseline.median).toBe(10); // unmoved by the old flood
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0].count).toBe(800);
  });

  it("carries the caller's correlation id into the report", async () => {
    const repo = new FakeRepo();
    const report = await runSignupAnomalyScan(repo, {
      now,
      correlationId: "corr-123",
    });
    expect(report.correlationId).toBe("corr-123");
  });

  it("defaults the correlation id to null outside a request context", async () => {
    const report = await runSignupAnomalyScan(new FakeRepo(), { now });
    expect(report.correlationId).toBeNull();
  });

  it("handles a completely empty database", async () => {
    const report = await runSignupAnomalyScan(new FakeRepo(), { now });
    expect(report.anomalies).toEqual([]);
    expect(report.totalSignups).toBe(0);
    expect(report.peak).toEqual({
      bucketStart: "2026-07-24T11:35:00.000Z",
      count: 0,
    });
    expect(report.baseline.sampleSize).toBeGreaterThan(0);
  });

  it("evaluates exactly one bucket at the narrowest legal window", async () => {
    const report = await runSignupAnomalyScan(new FakeRepo(), {
      now,
      bucketMs: 3_600_000,
      evaluationWindowMs: 3_600_000,
    });
    expect(report.evaluated).toBe(1);
    expect(report.peak).not.toBeNull();
  });

  it("honours caller-supplied tunables", async () => {
    const repo = new FakeRepo();
    await runSignupAnomalyScan(repo, {
      now,
      bucketMs: 60_000,
      baselineWindowMs: 3_600_000,
      evaluationWindowMs: 600_000,
    });
    const call = repo.calls[0];
    expect(call.bucketMs).toBe(60_000);
    expect(call.until.getTime() - call.since.getTime()).toBe(
      3_600_000 + 600_000,
    );
  });

  it("rejects invalid options before touching the repo", async () => {
    const repo = new FakeRepo();
    await expect(
      runSignupAnomalyScan(repo, { now, minCount: 0 }),
    ).rejects.toThrow();
    expect(repo.calls).toHaveLength(0);
  });

  it("rejects unknown option keys", async () => {
    await expect(
      runSignupAnomalyScan(new FakeRepo(), {
        now,
        // @ts-expect-error — deliberately passing an unsupported key
        dropTable: true,
      }),
    ).rejects.toThrow();
  });

  it("propagates repository failures to the caller", async () => {
    const repo = new FakeRepo();
    repo.shouldThrow = true;
    await expect(runSignupAnomalyScan(repo, { now })).rejects.toThrow("db down");
  });

  it("produces a JSON-serialisable report", async () => {
    const repo = new FakeRepo();
    const until = new Date("2026-07-24T12:05:00.000Z");
    repo.buckets = series(
      until,
      DEFAULT_BUCKET_MS,
      new Array(288).fill(0),
      [0, 0, 0, 0, 0, 500],
    );
    const report = await runSignupAnomalyScan(repo, { now });
    const round = JSON.parse(JSON.stringify(report));
    expect(round).toEqual(report);
    expect(round.anomalies[0].score).toBe(MAX_SCORE);
  });
});

describe("scanSignupAnomalies", () => {
  it("delegates to runSignupAnomalyScan with the supplied repo", async () => {
    const repo = new FakeRepo();
    const report = await scanSignupAnomalies({ now: () => NOW }, repo);
    expect(repo.calls).toHaveLength(1);
    expect(report.window.bucketMs).toBe(DEFAULT_BUCKET_MS);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Drizzle repository (query shape only — no live database)
// ──────────────────────────────────────────────────────────────────────────────

describe("DrizzleSignupAnomalyRepo", () => {
  const opts = {
    since: new Date("2026-07-24T00:00:00.000Z"),
    until: new Date("2026-07-24T12:00:00.000Z"),
    bucketMs: 300_000,
  };

  it("aggregates in SQL and maps rows to buckets", async () => {
    const execute = jest.fn().mockResolvedValue({
      rows: [
        { bucket_start: "2026-07-24T11:00:00.000Z", signups: "4" },
        { bucket_start: new Date("2026-07-24T11:05:00.000Z"), signups: 7 },
      ],
    });
    const repo = new DrizzleSignupAnomalyRepo({ execute });

    const out = await repo.loadSignupBuckets(opts);
    expect(out).toEqual([
      { start: new Date("2026-07-24T11:00:00.000Z"), count: 4 },
      { start: new Date("2026-07-24T11:05:00.000Z"), count: 7 },
    ]);
  });

  it("binds the bucket width and window instead of interpolating them", async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [] });
    await new DrizzleSignupAnomalyRepo({ execute }).loadSignupBuckets(opts);

    const chunks: unknown[] = execute.mock.calls[0][0].queryChunks;
    const literals = chunks.filter(
      (c) => c !== null && typeof c === "object" && "value" in (c as object),
    );
    const bound = chunks.filter((c) => !literals.includes(c));

    // 300000 ms → 300 s, bound twice (floor + multiply), plus since/until.
    expect(bound).toEqual([300, 300, opts.since, opts.until]);
    // The SQL text itself must never carry the caller's values.
    const text = literals
      .map((c) => (c as { value: string[] }).value.join(""))
      .join("");
    expect(text).toContain("FROM users");
    expect(text).not.toContain("300");
  });

  it("tolerates a driver that returns no rows array", async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const out = await new DrizzleSignupAnomalyRepo({ execute }).loadSignupBuckets(
      opts,
    );
    expect(out).toEqual([]);
  });
});
