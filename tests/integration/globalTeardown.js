const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CONTAINER_INFO_PATH = path.join(__dirname, ".container-info.json");

module.exports = async function () {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(CONTAINER_INFO_PATH, "utf-8"));
  } catch {
    return;
  }

  if (info.containerId) {
    try {
      execSync(`docker stop ${info.containerId}`, { stdio: "ignore" });
    } catch {
      // container may already be stopped
    }
    try {
      execSync(`docker rm --force ${info.containerId}`, { stdio: "ignore" });
    } catch {
      // container may already be removed
    }
  }

  try {
    fs.unlinkSync(CONTAINER_INFO_PATH);
  } catch {
    // ignore cleanup errors
  }
};
