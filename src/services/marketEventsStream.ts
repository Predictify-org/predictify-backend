/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { indexerEvents, type IndexerEvent } from "../db/schema";

export const POLL_INTERVAL_MS = 2_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface StreamEvent {
  id: string;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function toStreamEvent(row: IndexerEvent): StreamEvent {
  return {
    id: String(row.id),
    eventType: row.eventType,
    data: (row.data ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export function formatSSE(event: StreamEvent): string {
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function heartbeatComment(): string {
  return ": heartbeat\n\n";
}

export async function fetchNewEvents(
  marketId: string,
  afterId: any,
): Promise<IndexerEvent[]> {
  return db
    .select()
    .from(indexerEvents)
    .where(
      and(
        eq(indexerEvents.marketId, marketId),
        gt(indexerEvents.id, afterId as any),
      ),
    )
    .orderBy(indexerEvents.id)
    .limit(100);
}

export interface SSECleanup {
  (): void;
}

export function createSSEPump(
  marketId: string,
  onEvent: (chunk: string) => void,
  onHeartbeat: (chunk: string) => void,
  onError: (err: Error) => void,
  lastEventId: any = null,
): SSECleanup {
  let lastId: any = lastEventId ?? 0;
  let polling = true;

  const poll = async () => {
    if (!polling) return;
    try {
      const rows = await fetchNewEvents(marketId, lastId);
      for (const row of rows) {
        const event = toStreamEvent(row);
        onEvent(formatSSE(event));
        lastId = row.id;
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const evTimer = setInterval(poll, POLL_INTERVAL_MS);
  const hbTimer = setInterval(() => {
    onHeartbeat(heartbeatComment());
  }, HEARTBEAT_INTERVAL_MS);

  poll();

  return () => {
    polling = false;
    clearInterval(evTimer);
    clearInterval(hbTimer);
  };
}
