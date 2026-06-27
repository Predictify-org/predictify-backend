/**
 * jest.config.js  (frontend — app/)
 *
 * Separate Jest configuration for the frontend feature files under app/.
 * Uses jsdom as the test environment so DOM APIs and React components render
 * correctly.
 *
 * Run with:
 *   npx jest --config app/jest.config.js
 *
 * Or add as a Jest project in the root jest.config.js:
 *   projects: ["<rootDir>/jest.config.js", "<rootDir>/app/jest.config.js"]
 *
 * Prerequisites (add to your frontend package.json if not present):
 *   @testing-library/react
 *   @testing-library/user-event
 *   @testing-library/jest-dom
 *   @types/react
 *   jest-environment-jsdom
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: "frontend",
  preset: "ts-jest",
  testEnvironment: "jsdom",

  // Runs after the test framework is installed — extends expect with
  // jest-dom matchers (toBeInTheDocument, toHaveAttribute, etc.)
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],

  testMatch: [
    "<rootDir>/components/**/*.test.tsx",
    "<rootDir>/state/**/*.test.ts",
  ],

  moduleNameMapper: {
    // Allow @/ alias imports (Next.js convention)
    "^@/(.*)$": "<rootDir>/../$1",
  },

  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: {
          jsx: "react-jsx",
          strict: true,
          esModuleInterop: true,
          moduleResolution: "node",
        },
      },
    ],
  },

  collectCoverageFrom: [
    "<rootDir>/components/**/*.{ts,tsx}",
    "<rootDir>/state/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
    "!**/jest.setup.ts",
  ],

  coverageDirectory: "<rootDir>/../coverage/frontend",
};
