/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  // Runs before every test file; injects stub env vars so src/config/env.ts
  // validates without a real .env present.
  setupFiles: ["./tests/setup.ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
};
