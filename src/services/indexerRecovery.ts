/**
 * Deterministic checkpoint and replay primitives for the Soroban indexer.
 *
 * The RPC event stream is at-least-once. These helpers keep the state machine
 * independent of Postgres and make the important invariants executable:
 * replay is deduplicated by event identity, a checkpoint only crosses ledgers
 * that were explicitly observed, and a replacement at the same ledger/op is
 * treated as a reorg rather than a second canonical event.
 */

export interface RecoveryEvent {
  ledger: number;
  txHash: string;
  opIndex: number;
  eventType?: string;
  payload?: unknown;
}

export interface LedgerObservation {
  ledger: number;
  events: RecoveryEvent[];
}

export interface ReorgReplacement {
  ledger: number;
  opIndex: number;
  oldTxHash: string;
  newTxHash: string;
}

export interface ReplayChunk {
  from: number;
  to: number;
}

export function eventIdentity(event: Pick<RecoveryEvent, "ledger" | "txHash" | "opIndex">): string {
  return `${event.ledger}:${event.txHash}:${event.opIndex}`;
}

export function positionIdentity(event: Pick<RecoveryEvent, "ledger" | "opIndex">): string {
  return `${event.ledger}:${event.opIndex}`;
}

/** Removes duplicate delivery while preserving first-seen order. */
export function dedupeEvents(events: RecoveryEvent[]): RecoveryEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = eventIdentity(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Finds ledger ranges not represented by an explicit observation. Empty
 * ledgers must be supplied as `{ ledger, events: [] }`; absence is a gap.
 */
export function findUnobservedLedgers(from: number, to: number, observations: LedgerObservation[]): number[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return [];
  const observed = new Set(observations.map((item) => item.ledger));
  const missing: number[] = [];
  for (let ledger = from; ledger <= to; ledger += 1) {
    if (!observed.has(ledger)) missing.push(ledger);
  }
  return missing;
}

export function groupLedgerRanges(ledgers: number[]): ReplayChunk[] {
  const sorted = [...new Set(ledgers)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const ranges: ReplayChunk[] = [];
  let from = sorted[0];
  let to = sorted[0];
  for (const ledger of sorted.slice(1)) {
    if (ledger === to + 1) to = ledger;
    else {
      ranges.push({ from, to });
      from = ledger;
      to = ledger;
    }
  }
  ranges.push({ from, to });
  return ranges;
}

/** Splits a recovery range so a single RPC timeout cannot consume the whole replay. */
export function chunkReplayRanges(ranges: ReplayChunk[], maxLedgers: number): ReplayChunk[] {
  if (!Number.isInteger(maxLedgers) || maxLedgers < 1) throw new Error("maxLedgers must be positive");
  const chunks: ReplayChunk[] = [];
  for (const range of ranges) {
    for (let from = range.from; from <= range.to; from += maxLedgers) {
      chunks.push({ from, to: Math.min(range.to, from + maxLedgers - 1) });
    }
  }
  return chunks;
}

/**
 * Compares the canonical stream with a replay. Same position + new tx hash
 * means the chain reorganised; same position + same tx hash is harmless.
 */
export function detectReorgs(
  canonical: RecoveryEvent[],
  replay: RecoveryEvent[],
): ReorgReplacement[] {
  const byPosition = new Map(canonical.map((event) => [positionIdentity(event), event]));
  const replacements: ReorgReplacement[] = [];
  for (const event of dedupeEvents(replay)) {
    const previous = byPosition.get(positionIdentity(event));
    if (previous && previous.txHash !== event.txHash) {
      replacements.push({ ledger: event.ledger, opIndex: event.opIndex, oldTxHash: previous.txHash, newTxHash: event.txHash });
    }
  }
  return replacements;
}

export interface CheckpointDecision {
  accepted: boolean;
  nextCheckpoint: number;
  missing: ReplayChunk[];
}

/** Advances only through explicitly observed contiguous ledgers. */
export function decideCheckpoint(
  current: number,
  requestedTo: number,
  observations: LedgerObservation[],
): CheckpointDecision {
  const from = current + 1;
  if (requestedTo < from) return { accepted: true, nextCheckpoint: current, missing: [] };
  const missing = groupLedgerRanges(findUnobservedLedgers(from, requestedTo, observations));
  if (missing.length > 0) return { accepted: false, nextCheckpoint: current, missing };
  return { accepted: true, nextCheckpoint: requestedTo, missing: [] };
}

export function assertCheckpointDecision(decision: CheckpointDecision): number {
  if (!decision.accepted) {
    throw new Error(`indexer checkpoint blocked by ${decision.missing.length} missing range(s)`);
  }
  return decision.nextCheckpoint;
}

export function validateRecoveryEvent(event: RecoveryEvent): void {
  if (!Number.isSafeInteger(event.ledger) || event.ledger < 0) throw new Error("event ledger must be a non-negative safe integer");
  if (!Number.isSafeInteger(event.opIndex) || event.opIndex < 0) throw new Error("event operation index must be non-negative");
  if (event.txHash.trim().length === 0) throw new Error("event transaction hash is required");
}

/** Validates and normalizes an RPC batch before it can influence a checkpoint. */
export function normalizeRecoveryBatch(events: RecoveryEvent[]): RecoveryEvent[] {
  for (const event of events) validateRecoveryEvent(event);
  return dedupeEvents(events).sort((left, right) =>
    left.ledger - right.ledger || left.opIndex - right.opIndex || left.txHash.localeCompare(right.txHash),
  );
}

/** Merges observations from multiple RPC pages without losing explicitly empty ledgers. */
export function mergeObservations(observations: LedgerObservation[]): LedgerObservation[] {
  const byLedger = new Map<number, RecoveryEvent[]>();
  for (const observation of observations) {
    if (!Number.isSafeInteger(observation.ledger) || observation.ledger < 0) throw new Error("observation ledger must be non-negative");
    byLedger.set(observation.ledger, [...(byLedger.get(observation.ledger) ?? []), ...observation.events]);
  }
  return [...byLedger.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ledger, events]) => ({ ledger, events: normalizeRecoveryBatch(events) }));
}

export function reorgAffectedRange(replacements: ReorgReplacement[]): ReplayChunk | null {
  if (replacements.length === 0) return null;
  return {
    from: Math.min(...replacements.map((replacement) => replacement.ledger)),
    to: Math.max(...replacements.map((replacement) => replacement.ledger)),
  };
}

export class IndexerRecoveryPlanner {
  constructor(private readonly maxReplayLedgers: number) {
    if (!Number.isInteger(maxReplayLedgers) || maxReplayLedgers < 1) throw new Error("maxReplayLedgers must be positive");
  }

  plan(current: number, target: number, observations: LedgerObservation[]): ReplayChunk[] {
    const decision = decideCheckpoint(current, target, mergeObservations(observations));
    return chunkReplayRanges(decision.missing, this.maxReplayLedgers);
  }

  checkpoint(current: number, target: number, observations: LedgerObservation[]): number {
    const decision = decideCheckpoint(current, target, mergeObservations(observations));
    return assertCheckpointDecision(decision);
  }
}
