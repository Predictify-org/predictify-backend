import {
  getWebhookEventDefinition,
  listWebhookEvents,
  listWebhookEventTypes,
  WEBHOOK_EVENT_CATALOG,
} from "../src/services/webhookCatalog";

describe("webhook event catalog", () => {
  it("exposes unique event types", () => {
    const types = listWebhookEventTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types).size).toBe(types.length);
  });

  it("contains the currently emitted webhook events", () => {
    expect(listWebhookEventTypes()).toEqual(
      expect.arrayContaining(["market.resolved", "dispute.opened"]),
    );
  });

  it("returns the market.resolved payload schema", () => {
    const definition = getWebhookEventDefinition("market.resolved");

    expect(definition).toBeDefined();
    expect(definition?.producer).toBe("src/services/marketResolutionService.ts");
    expect(definition?.delivery.signatureHeader).toBe("X-Predictify-Signature");
    expect(definition?.payloadFields.map((field) => field.name)).toEqual([
      "event",
      "marketId",
      "winningOutcome",
      "ledger",
      "timestamp",
    ]);
    expect(definition?.examplePayload).toMatchObject({
      event: "market.resolved",
      winningOutcome: "YES",
    });
  });

  it("returns the dispute.opened payload schema", () => {
    const definition = getWebhookEventDefinition("dispute.opened");

    expect(definition).toBeDefined();
    expect(definition?.producer).toBe("src/services/disputeService.ts");
    expect(definition?.payloadFields.find((field) => field.name === "evidenceUri")).toMatchObject({
      required: false,
      type: "nullable-string",
    });
    expect(definition?.examplePayload).toMatchObject({
      type: "dispute.opened",
    });
  });

  it("returns undefined for unknown event types", () => {
    expect(getWebhookEventDefinition("unknown.event")).toBeUndefined();
  });

  it("keeps exported catalog immutable from callers", () => {
    const events = listWebhookEvents();
    expect(events).toBe(WEBHOOK_EVENT_CATALOG);
  });
});
