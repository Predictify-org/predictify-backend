import * as fs from "fs";
import * as yaml from "js-yaml";

describe("OpenAPI user endpoints include examples", () => {
  const yamlPath = process.cwd() + "/openapi.yaml";
  let parsed: Record<string, any>;

  beforeAll(() => {
    expect(fs.existsSync(yamlPath)).toBe(true);
    parsed = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Record<string, any>;
  });

  test("GET /api/users/me has a 200 example", () => {
    const ex = parsed.paths?.["/api/users/me"]?.get?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(ex).toBeDefined();
    expect(ex.currentUser).toBeDefined();
    expect(ex.currentUser.value.data.stellarAddress).toMatch(/^G/);
  });

  test("GET /api/users/{address}/predictions has a 200 example", () => {
    const ex = parsed.paths?.["/api/users/{address}/predictions"]?.get?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(ex).toBeDefined();
    expect(ex.samplePage).toBeDefined();
    expect(Array.isArray(ex.samplePage.value.data)).toBe(true);
  });

  test("GET /api/users/{stellarAddress}/profile has a 200 example", () => {
    const ex = parsed.paths?.["/api/users/{stellarAddress}/profile"]?.get?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(ex).toBeDefined();
    expect(ex.publicProfile).toBeDefined();
    expect(ex.publicProfile.value.data.id).toBeTruthy();
    expect(ex.publicProfile.value.data.stellarAddress).toMatch(/^G/);
  });

  test("POST/DELETE /api/users/{addr}/follow have 200 examples", () => {
    const postEx = parsed.paths?.["/api/users/{addr}/follow"]?.post?.responses?.["200"]?.content?.["application/json"]?.examples;
    const delEx = parsed.paths?.["/api/users/{addr}/follow"]?.delete?.responses?.["200"]?.content?.["application/json"]?.examples;
    expect(postEx).toBeDefined();
    expect(postEx.followCreated).toBeDefined();
    expect(postEx.followCreated.value.data.follower).toMatch(/^G/);
    expect(delEx).toBeDefined();
    expect(delEx.followRemoved).toBeDefined();
  });
  test("GET /api/users/me has a 401 example", () => {
    const ex = parsed.paths?.["/api/users/me"]?.get?.responses?.["401"]?.content?.["application/json"]?.examples;
    expect(ex).toBeDefined();
    expect(ex.unauthorized).toBeDefined();
    expect(ex.unauthorized.value.error.code).toBe("UNAUTHORIZED");
  });

  test("GET /api/users/{address}/predictions has 400 and 404 examples", () => {
    const ex400 = parsed.paths?.["/api/users/{address}/predictions"]?.get?.responses?.["400"]?.content?.["application/json"]?.examples;
    expect(ex400).toBeDefined();
    expect(ex400.invalidAddress).toBeDefined();

    const ex404 = parsed.paths?.["/api/users/{address}/predictions"]?.get?.responses?.["404"]?.content?.["application/json"]?.examples;
    expect(ex404).toBeDefined();
    expect(ex404.notFound).toBeDefined();
  });

  test("GET /api/users/{stellarAddress}/profile has 400 and 404 examples", () => {
    const ex400 = parsed.paths?.["/api/users/{stellarAddress}/profile"]?.get?.responses?.["400"]?.content?.["application/json"]?.examples;
    expect(ex400).toBeDefined();
    expect(ex400.invalidAddress).toBeDefined();

    const ex404 = parsed.paths?.["/api/users/{stellarAddress}/profile"]?.get?.responses?.["404"]?.content?.["application/json"]?.examples;
    expect(ex404).toBeDefined();
    expect(ex404.notFound).toBeDefined();
  });

  test("POST/DELETE /api/users/{addr}/follow have 400 and 401 examples", () => {
    const postEx400 = parsed.paths?.["/api/users/{addr}/follow"]?.post?.responses?.["400"]?.content?.["application/json"]?.examples;
    const postEx401 = parsed.paths?.["/api/users/{addr}/follow"]?.post?.responses?.["401"]?.content?.["application/json"]?.examples;
    expect(postEx400).toBeDefined();
    expect(postEx401).toBeDefined();

    const delEx400 = parsed.paths?.["/api/users/{addr}/follow"]?.delete?.responses?.["400"]?.content?.["application/json"]?.examples;
    const delEx401 = parsed.paths?.["/api/users/{addr}/follow"]?.delete?.responses?.["401"]?.content?.["application/json"]?.examples;
    expect(delEx400).toBeDefined();
    expect(delEx401).toBeDefined();
  });
});
