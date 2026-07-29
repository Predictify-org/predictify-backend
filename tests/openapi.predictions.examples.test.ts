import * as fs from "fs";
import * as yaml from "js-yaml";

describe("OpenAPI predictions endpoint includes examples", () => {
  const yamlPath = process.cwd() + "/openapi.yaml";
  let parsed: Record<string, unknown>;

  beforeAll(() => {
    expect(fs.existsSync(yamlPath)).toBe(true);
    parsed = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
  });

  test("GET /api/predictions has a 200 example", () => {
    const ex = parsed.paths?.["/api/predictions"]?.get?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(ex).toBeDefined();
    expect(ex.authenticatedPredictionsPage).toBeDefined();
    expect(Array.isArray(ex.authenticatedPredictionsPage.value.data)).toBe(true);
    expect(ex.authenticatedPredictionsPage.value.data[0].marketId).toBeTruthy();
    expect(ex.authenticatedPredictionsPage.value.nextCursor).toBeTruthy();
  });
});
