/**
 * Railway — where local files live (config, tokens, memory).
 * ------------------------------------------------------------------
 * In dev this is the project root. In a packaged app the project root is
 * inside a read-only asar, so main.js sets RAILWAY_DATA_DIR to the OS
 * userData dir before requiring anything; we honor that here. Kept free of
 * any Electron import so plain-Node tests can require it too.
 * ------------------------------------------------------------------
 */
const path = require("path");

function dataDir() {
  return process.env.RAILWAY_DATA_DIR || path.join(__dirname, "..");
}

function dataPath(name) {
  return path.join(dataDir(), name);
}

module.exports = { dataDir, dataPath };
