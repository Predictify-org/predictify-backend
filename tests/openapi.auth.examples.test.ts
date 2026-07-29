import * as fs from "fs";
import * as yaml from "js-yaml";

describe("OpenAPI auth endpoints include examples", () => {
  const yamlPath = process.cwd() + "/openapi.yaml";
  let parsed: Record<string, unknown>;

  beforeAll(() => {
    expect(fs.existsSync(yamlPath)).toBe(true);
    parsed = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
  });

  test("POST /api/auth/challenge has request and response examples", () => {
    const challenge = parsed.paths?.["/api/auth/challenge"]?.post;
    const requestExamples = challenge?.requestBody?.content?.["application/json"]?.examples;
    const responseExamples = challenge?.responses?.["201"]?.content?.["application/json"]?.examples;

    expect(requestExamples).toBeDefined();
    expect(requestExamples.challengeRequest).toBeDefined();
    expect(requestExamples.challengeRequest.value.stellarAddress).toMatch(/^G/);
    expect(responseExamples).toBeDefined();
    expect(responseExamples.challengeIssued).toBeDefined();
    expect(responseExamples.challengeIssued.value.nonce).toBeTruthy();
  });

  test("POST /api/auth/verify has request and response examples", () => {
    const verify = parsed.paths?.["/api/auth/verify"]?.post;
    const requestExamples = verify?.requestBody?.content?.["application/json"]?.examples;
    const responseExamples = verify?.responses?.["200"]?.content?.["application/json"]?.examples;

    expect(requestExamples).toBeDefined();
    expect(requestExamples.verifyRequest).toBeDefined();
    expect(requestExamples.verifyRequest.value.signature).toBeTruthy();
    expect(responseExamples).toBeDefined();
    expect(responseExamples.tokensIssued).toBeDefined();
    expect(responseExamples.tokensIssued.value.accessToken).toMatch(/^ey/);
  });

  test("POST /api/auth/refresh has request and response examples", () => {
    const refresh = parsed.paths?.["/api/auth/refresh"]?.post;
    const requestExamples = refresh?.requestBody?.content?.["application/json"]?.examples;
    const responseExamples = refresh?.responses?.["200"]?.content?.["application/json"]?.examples;

    expect(requestExamples).toBeDefined();
    expect(requestExamples.refreshTokenRequest).toBeDefined();
    expect(requestExamples.refreshTokenRequest.value.refreshToken).toBeTruthy();
    expect(responseExamples).toBeDefined();
    expect(responseExamples.refreshedTokens).toBeDefined();
    expect(responseExamples.refreshedTokens.value.refreshToken).toBeTruthy();
  });

  test("POST /api/auth/logout has request example", () => {
    const logout = parsed.paths?.["/api/auth/logout"]?.post;
    const requestExamples = logout?.requestBody?.content?.["application/json"]?.examples;

    expect(requestExamples).toBeDefined();
    expect(requestExamples.logoutRequest).toBeDefined();
    expect(requestExamples.logoutRequest.value.refreshToken).toBeTruthy();
  });
});
