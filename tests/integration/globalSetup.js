const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CONTAINER_INFO_PATH = path.join(__dirname, ".container-info.json");

module.exports = async function () {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("predictify_test")
    .withUsername("predictify")
    .withPassword("predictify")
    .withLabels({ "com.predictify.integration": "postgres" })
    .start();

  const connectionString = container.getConnectionUri();
  const containerId = container.getId();

  const dbUrl = `${connectionString}?sslmode=disable`;

  execSync("npx drizzle-kit migrate", {
    cwd: path.join(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  fs.writeFileSync(
    CONTAINER_INFO_PATH,
    JSON.stringify({ connectionString: dbUrl, containerId }),
  );

  process.env.DATABASE_URL = dbUrl;
};
