import * as fs from "fs";
import * as yaml from "js-yaml";

describe("OpenAPI markets endpoints include examples", () => {
  const yamlPath = process.cwd() + "/openapi.yaml";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: Record<string, any>;

  beforeAll(() => {
    expect(fs.existsSync(yamlPath)).toBe(true);
    parsed = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Record<string, any>;
  });

  test("GET /api/markets/recommendations has a 200 and 401 example", () => {
    const op = parsed.paths?.["/api/markets/recommendations"]?.get;
    const okEx = op?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(okEx).toBeDefined();
    expect(okEx.recommendedMarkets).toBeDefined();
    expect(Array.isArray(okEx.recommendedMarkets.value.data)).toBe(true);
    expect(okEx.recommendedMarkets.value.data[0].id).toBeTruthy();

    const unauthorizedEx = op?.responses?.["401"]?.content?.["application/json"]?.examples;
    expect(unauthorizedEx).toBeDefined();
    expect(unauthorizedEx.unauthorized.value.error.code).toBe("unauthorized");
  });

  test("GET /api/markets/search has a 200 and 400 example", () => {
    const op = parsed.paths?.["/api/markets/search"]?.get;
    const okEx = op?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(okEx).toBeDefined();
    expect(okEx.searchResults).toBeDefined();
    expect(Array.isArray(okEx.searchResults.value.data)).toBe(true);
    expect(okEx.searchResults.value.total).toBe(1);
    expect(okEx.searchResults.value.pagination).toBeDefined();
    expect(okEx.searchResults.value.meta).toBeDefined();

    const missingQueryEx = op?.responses?.["400"]?.content?.["application/json"]?.examples;
    expect(missingQueryEx).toBeDefined();
    expect(missingQueryEx.missingQuery.value.error.code).toBe("validation_error");
  });

  test("GET /api/markets/tags has a 200 example", () => {
    const op = parsed.paths?.["/api/markets/tags"]?.get;
    const ex = op?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(ex).toBeDefined();
    expect(ex.tagCounts).toBeDefined();
    expect(Array.isArray(ex.tagCounts.value.data)).toBe(true);
    expect(ex.tagCounts.value.data[0].tag).toBeTruthy();
    expect(typeof ex.tagCounts.value.data[0].count).toBe("number");
  });

  test("PATCH /api/markets/{id} has request and response examples", () => {
    const op = parsed.paths?.["/api/markets/{id}"]?.patch;
    const requestEx = op?.requestBody?.content?.["application/json"]?.examples;
    expect(requestEx).toBeDefined();
    expect(requestEx.updateQuestion).toBeDefined();
    expect(requestEx.updateQuestion.value.expectedVersion).toBe(1);

    const okEx = op?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(okEx).toBeDefined();
    expect(okEx.updatedMarket.value.data.id).toBeTruthy();
    expect(okEx.updatedMarket.value.data.version).toBe(2);

    const badReqEx = op?.responses?.["400"]?.content?.["application/json"]?.examples;
    expect(badReqEx).toBeDefined();
    expect(badReqEx.invalidBody.value.error.code).toBe("validation_error");

    const notFoundEx = op?.responses?.["404"]?.content?.["application/json"]?.examples;
    expect(notFoundEx).toBeDefined();
    expect(notFoundEx.notFound.value.error.code).toBe("not_found");

    const conflictEx = op?.responses?.["409"]?.content?.["application/json"]?.examples;
    expect(conflictEx).toBeDefined();
    expect(conflictEx.versionConflict.value.error.code).toBe("conflict");
  });

  test("GET /api/markets/{id}/prediction-count has 200, 400, and 404 examples", () => {
    const op = parsed.paths?.["/api/markets/{id}/prediction-count"]?.get;
    const okEx = op?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(okEx).toBeDefined();
    expect(okEx.predictionCount.value.data.marketId).toBeTruthy();
    expect(typeof okEx.predictionCount.value.data.count).toBe("number");
    expect(typeof okEx.predictionCount.value.data.cached).toBe("boolean");

    const badReqEx = op?.responses?.["400"]?.content?.["application/json"]?.examples;
    expect(badReqEx).toBeDefined();
    expect(badReqEx.invalidId.value.error.code).toBe("validation_error");

    const notFoundEx = op?.responses?.["404"]?.content?.["application/json"]?.examples;
    expect(notFoundEx).toBeDefined();
    expect(notFoundEx.notFound.value.error.code).toBe("not_found");
  });

  test("GET /api/markets/featured has 200 and 400 examples", () => {
    const op = parsed.paths?.["/api/markets/featured"]?.get;
    const okEx = op?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(okEx).toBeDefined();
    expect(Array.isArray(okEx.featuredMarkets.value.data)).toBe(true);
    expect(okEx.featuredMarkets.value.data[0].featuredAt).toBeTruthy();

    const badReqEx = op?.responses?.["400"]?.content?.["application/json"]?.examples;
    expect(badReqEx).toBeDefined();
    expect(badReqEx.invalidLimit.value.error.code).toBe("validation_error");
  });
});
