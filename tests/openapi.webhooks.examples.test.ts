import * as fs from "fs";
import * as yaml from "js-yaml";

/**
 * Validates that the OpenAPI spec for /api/webhooks endpoints contains
 * correctly-shaped examples for each operation and response code.
 *
 * These tests act as a contract: if the route behaviour changes (new fields,
 * renamed keys, changed status codes) the examples must be updated too so
 * Swagger UI and generated clients stay accurate.
 */

describe("OpenAPI webhook endpoints include examples", () => {
  const yamlPath = process.cwd() + "/openapi.yaml";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: Record<string, any>;

  beforeAll(() => {
    expect(fs.existsSync(yamlPath)).toBe(true);
    parsed = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Record<string, any>;
  });

  // ---------------------------------------------------------------------------
  // Component schemas
  // ---------------------------------------------------------------------------

  describe("component schemas", () => {
    test("WebhookDelivery schema is defined with required fields", () => {
      const schema = parsed.components?.schemas?.WebhookDelivery;
      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      const required: string[] = schema.required;
      expect(required).toContain("id");
      expect(required).toContain("eventId");
      expect(required).toContain("eventType");
      expect(required).toContain("targetUrl");
      expect(required).toContain("payloadBase64");
      expect(required).toContain("signature");
      expect(required).toContain("status");
      expect(required).toContain("attempts");
      expect(required).toContain("maxAttempts");
      expect(required).toContain("createdAt");
      expect(required).toContain("updatedAt");
    });

    test("DlqRow schema is defined with required fields", () => {
      const schema = parsed.components?.schemas?.DlqRow;
      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      const required: string[] = schema.required;
      expect(required).toContain("id");
      expect(required).toContain("originalId");
      expect(required).toContain("eventId");
      expect(required).toContain("eventType");
      expect(required).toContain("targetUrl");
      expect(required).toContain("payloadBase64");
      expect(required).toContain("signature");
      expect(required).toContain("attempts");
      expect(required).toContain("lastError");
      expect(required).toContain("failedAt");
      expect(required).toContain("replayedAt");
      expect(required).toContain("replayDeliveryId");
    });

    test("DeliveryStatus schema enumerates the three states", () => {
      const schema = parsed.components?.schemas?.DeliveryStatus;
      expect(schema).toBeDefined();
      expect(schema.enum).toContain("pending");
      expect(schema.enum).toContain("delivered");
      expect(schema.enum).toContain("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/webhooks
  // ---------------------------------------------------------------------------

  describe("GET /api/webhooks", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let op: Record<string, any>;

    beforeAll(() => {
      op = parsed.paths?.["/api/webhooks"]?.get;
    });

    test("operation exists and is tagged Webhooks", () => {
      expect(op).toBeDefined();
      expect(op.tags).toContain("Webhooks");
    });

    test("requires bearerAuth security", () => {
      expect(op.security).toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
    });

    test("200 response has a webhookDeliveriesPage example with correct shape", () => {
      const examples =
        op.responses?.["200"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();

      const ex = examples.webhookDeliveriesPage;
      expect(ex).toBeDefined();
      expect(ex.summary).toBeTruthy();
      expect(Array.isArray(ex.value.data)).toBe(true);
      expect(ex.value.data.length).toBeGreaterThan(0);

      const first = ex.value.data[0];
      expect(first.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(first.eventId).toBeTruthy();
      expect(first.eventType).toBeTruthy();
      expect(first.targetUrl).toMatch(/^https?:\/\//);
      expect(first.payloadBase64).toBeTruthy();
      // Validate the example payload is actually valid base64
      expect(() =>
        Buffer.from(first.payloadBase64, "base64"),
      ).not.toThrow();
      expect(first.signature).toBeTruthy();
      expect(["pending", "delivered", "failed"]).toContain(first.status);
      expect(typeof first.attempts).toBe("number");
      expect(typeof first.maxAttempts).toBe("number");
      expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(first.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // nextCursor can be a string or null
      expect(ex.value.nextCursor !== undefined).toBe(true);
    });

    test("200 response has an emptyPage example", () => {
      const examples =
        op.responses?.["200"]?.content?.["application/json"]?.examples;
      const empty = examples?.emptyPage;
      expect(empty).toBeDefined();
      expect(empty.value.data).toEqual([]);
      expect(empty.value.nextCursor).toBeNull();
    });

    test("400 response has an invalidLimit example", () => {
      const examples =
        op.responses?.["400"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();
      const ex = examples.invalidLimit;
      expect(ex).toBeDefined();
      expect(ex.value.error.code).toBe("validation_error");
      expect(ex.value.error.message).toBeTruthy();
      expect(ex.value.error.requestId).toBeTruthy();
    });

    test("401 and 403 responses are documented", () => {
      expect(op.responses?.["401"]).toBeDefined();
      expect(op.responses?.["403"]).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/webhooks/dlq
  // ---------------------------------------------------------------------------

  describe("GET /api/admin/webhooks/dlq", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let op: Record<string, any>;

    beforeAll(() => {
      op = parsed.paths?.["/api/admin/webhooks/dlq"]?.get;
    });

    test("operation exists and is tagged Webhooks", () => {
      expect(op).toBeDefined();
      expect(op.tags).toContain("Webhooks");
    });

    test("requires bearerAuth security", () => {
      expect(op.security).toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
    });

    test("200 response has a dlqPage example with correct DlqRow shape", () => {
      const examples =
        op.responses?.["200"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();

      const ex = examples.dlqPage;
      expect(ex).toBeDefined();
      expect(Array.isArray(ex.value.data)).toBe(true);
      expect(ex.value.data.length).toBeGreaterThan(0);

      const first = ex.value.data[0];
      expect(first.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(first.originalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(first.eventId).toBeTruthy();
      expect(first.eventType).toBeTruthy();
      expect(first.targetUrl).toMatch(/^https?:\/\//);
      expect(first.payloadBase64).toBeTruthy();
      expect(() => Buffer.from(first.payloadBase64, "base64")).not.toThrow();
      expect(first.signature).toBeTruthy();
      expect(typeof first.attempts).toBe("number");
      expect(typeof first.maxAttempts).toBe("number");
      expect(first.lastError).toBeTruthy();
      expect(first.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // First entry is unreplayed
      expect(first.replayedAt).toBeNull();
      expect(first.replayDeliveryId).toBeNull();
    });

    test("dlqPage example contains an already-replayed entry", () => {
      const examples =
        op.responses?.["200"]?.content?.["application/json"]?.examples;
      const ex = examples?.dlqPage;
      const replayed = ex?.value?.data?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row: any) => row.replayedAt !== null,
      );
      expect(replayed).toBeDefined();
      expect(replayed.replayDeliveryId).toBeTruthy();
    });

    test("200 response has an emptyDlq example", () => {
      const examples =
        op.responses?.["200"]?.content?.["application/json"]?.examples;
      const empty = examples?.emptyDlq;
      expect(empty).toBeDefined();
      expect(empty.value.data).toEqual([]);
      expect(empty.value.nextCursor).toBeNull();
    });

    test("401 and 403 responses are documented", () => {
      expect(op.responses?.["401"]).toBeDefined();
      expect(op.responses?.["403"]).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/admin/webhooks/dlq/{id}/replay
  // ---------------------------------------------------------------------------

  describe("POST /api/admin/webhooks/dlq/{id}/replay", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let op: Record<string, any>;

    beforeAll(() => {
      op = parsed.paths?.["/api/admin/webhooks/dlq/{id}/replay"]?.post;
    });

    test("operation exists and is tagged Webhooks", () => {
      expect(op).toBeDefined();
      expect(op.tags).toContain("Webhooks");
    });

    test("requires bearerAuth security", () => {
      expect(op.security).toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
    });

    test("{id} path parameter is defined as a UUID", () => {
      const idParam = op.parameters?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => p.name === "id" && p.in === "path",
      );
      expect(idParam).toBeDefined();
      expect(idParam.required).toBe(true);
      expect(idParam.schema.format).toBe("uuid");
    });

    test("202 response has a replayAccepted example with deliveryId, status, attempts", () => {
      const examples =
        op.responses?.["202"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();

      const ex = examples.replayAccepted;
      expect(ex).toBeDefined();
      expect(ex.value.data.deliveryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(ex.value.data.status).toBe("pending");
      expect(ex.value.data.attempts).toBe(0);
    });

    test("400 response has a badId example", () => {
      const examples =
        op.responses?.["400"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();
      const ex = examples.badId;
      expect(ex).toBeDefined();
      expect(ex.value.error.code).toBeTruthy();
      expect(ex.value.error.message).toBeTruthy();
      expect(ex.value.error.requestId).toBeTruthy();
    });

    test("404 response has a notFound example", () => {
      const examples =
        op.responses?.["404"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();
      const ex = examples.notFound;
      expect(ex).toBeDefined();
      expect(ex.value.error.code).toBe("not_found");
      expect(ex.value.error.message).toBeTruthy();
    });

    test("409 response has an alreadyReplayed example", () => {
      const examples =
        op.responses?.["409"]?.content?.["application/json"]?.examples;
      expect(examples).toBeDefined();
      const ex = examples.alreadyReplayed;
      expect(ex).toBeDefined();
      expect(ex.value.error.type).toBe("already_replayed");
      expect(ex.value.replayDeliveryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    test("401 and 403 responses are documented", () => {
      expect(op.responses?.["401"]).toBeDefined();
      expect(op.responses?.["403"]).toBeDefined();
    });
  });
});
