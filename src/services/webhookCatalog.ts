export type WebhookEventType = "market.resolved" | "dispute.opened";

export type WebhookPayloadFieldType =
  | "string"
  | "number"
  | "integer"
  | "iso8601"
  | "nullable-string";

export interface WebhookPayloadField {
  name: string;
  type: WebhookPayloadFieldType;
  required: boolean;
  description: string;
  example: string | number | null;
}

export interface WebhookEventDefinition {
  type: WebhookEventType;
  description: string;
  producer: string;
  delivery: {
    method: "POST";
    contentType: "application/json";
    signatureHeader: "X-Predictify-Signature";
    eventHeader: "X-Predictify-Event";
    deliveryHeader: "X-Predictify-Delivery";
  };
  payloadFields: readonly WebhookPayloadField[];
  examplePayload: Record<string, unknown>;
}

const WEBHOOK_DELIVERY_CONTRACT = {
  method: "POST",
  contentType: "application/json",
  signatureHeader: "X-Predictify-Signature",
  eventHeader: "X-Predictify-Event",
  deliveryHeader: "X-Predictify-Delivery",
} as const;

export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventDefinition[] = [
  {
    type: "market.resolved",
    description:
      "Emitted after an on-chain market resolution is applied to the off-chain market row and predictions are marked won or lost.",
    producer: "src/services/marketResolutionService.ts",
    delivery: WEBHOOK_DELIVERY_CONTRACT,
    payloadFields: [
      {
        name: "event",
        type: "string",
        required: true,
        description: "Webhook event type. Always market.resolved for this payload.",
        example: "market.resolved",
      },
      {
        name: "marketId",
        type: "string",
        required: true,
        description: "Predictify market identifier that was resolved.",
        example: "market_01J4YC8Z7R8P9N0ABCDEF12345",
      },
      {
        name: "winningOutcome",
        type: "string",
        required: true,
        description: "Outcome value selected by the resolver and used to settle predictions.",
        example: "YES",
      },
      {
        name: "ledger",
        type: "integer",
        required: true,
        description: "Stellar ledger sequence where the resolution event was observed.",
        example: 521034,
      },
      {
        name: "timestamp",
        type: "integer",
        required: true,
        description: "Unix timestamp, in seconds, for the observed resolution event.",
        example: 1767225600,
      },
    ],
    examplePayload: {
      event: "market.resolved",
      marketId: "market_01J4YC8Z7R8P9N0ABCDEF12345",
      winningOutcome: "YES",
      ledger: 521034,
      timestamp: 1767225600,
    },
  },
  {
    type: "dispute.opened",
    description:
      "Emitted when an eligible user opens a dispute against a market outcome and the market enters disputed status.",
    producer: "src/services/disputeService.ts",
    delivery: WEBHOOK_DELIVERY_CONTRACT,
    payloadFields: [
      {
        name: "type",
        type: "string",
        required: true,
        description: "Webhook event type. Always dispute.opened for this payload.",
        example: "dispute.opened",
      },
      {
        name: "marketId",
        type: "string",
        required: true,
        description: "Market identifier associated with the dispute.",
        example: "market_01J4YC8Z7R8P9N0ABCDEF12345",
      },
      {
        name: "disputeId",
        type: "string",
        required: true,
        description: "Identifier of the created dispute record.",
        example: "disc_01J4YF9TP2R0E3XYZ987654321",
      },
      {
        name: "openedBy",
        type: "string",
        required: true,
        description: "User identifier that opened the dispute.",
        example: "550e8400-e29b-41d4-a716-446655440000",
      },
      {
        name: "reason",
        type: "string",
        required: true,
        description: "User-provided dispute reason.",
        example: "Oracle data did not match the published resolution source.",
      },
      {
        name: "evidenceUri",
        type: "nullable-string",
        required: false,
        description: "Optional URI containing evidence supplied by the disputing user.",
        example: "https://example.com/evidence/market_01J4YC8",
      },
      {
        name: "timestamp",
        type: "iso8601",
        required: true,
        description: "ISO-8601 timestamp for when the dispute was created.",
        example: "2026-06-28T00:00:00.000Z",
      },
    ],
    examplePayload: {
      type: "dispute.opened",
      marketId: "market_01J4YC8Z7R8P9N0ABCDEF12345",
      disputeId: "disc_01J4YF9TP2R0E3XYZ987654321",
      openedBy: "550e8400-e29b-41d4-a716-446655440000",
      reason: "Oracle data did not match the published resolution source.",
      evidenceUri: "https://example.com/evidence/market_01J4YC8",
      timestamp: "2026-06-28T00:00:00.000Z",
    },
  },
] as const;

export function listWebhookEvents(): readonly WebhookEventDefinition[] {
  return WEBHOOK_EVENT_CATALOG;
}

export function getWebhookEventDefinition(
  eventType: string,
): WebhookEventDefinition | undefined {
  return WEBHOOK_EVENT_CATALOG.find((event) => event.type === eventType);
}

export function listWebhookEventTypes(): WebhookEventType[] {
  return WEBHOOK_EVENT_CATALOG.map((event) => event.type);
}
