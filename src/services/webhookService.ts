import { logger } from "../config/logger";

export interface WebhookEvent {
  type: string;
  marketId: string;
  disputeId: string;
  openedBy: string;
  reason: string;
  evidenceUri?: string | null;
  timestamp: string;
}

export async function emitWebhook(event: WebhookEvent): Promise<void> {
  logger.info({ event }, "webhook_emitted");
}
