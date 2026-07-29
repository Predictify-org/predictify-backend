import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { resetOpenApiCache, getOpenApiSpec } from "../src/openapi/builder";

function main() {
  resetOpenApiCache();
  const spec = getOpenApiSpec();

  const yamlStr = yaml.dump(spec, {
    indent: 2,
    lineWidth: 120,
    noRefs: false,
    sortKeys: false,
  });

  const outPath = path.resolve(__dirname, "..", "openapi.yaml");
  fs.writeFileSync(outPath, yamlStr, "utf-8");
  console.log(`OpenAPI spec written to ${outPath}`);
}

main();
