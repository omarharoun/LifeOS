/**
 * Railway — config (M2+)
 * ------------------------------------------------------------------
 * Where the app's secrets/settings come from, in priority order:
 *   1. environment variables (ANTHROPIC_API_KEY, RAILWAY_MODEL)
 *   2. a local railway.config.json next to package.json (gitignored)
 *   3. a local .env file (KEY=value lines), as a convenience
 *
 * Nothing here is committed. See railway.config.example.json.
 * If no API key is found, the app still runs — generation falls back to
 * the renderer's built-in keyword router (M1 behavior).
 * ------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function readJsonConfig() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "railway.config.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readDotEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — fine */
  }
  return out;
}

function loadConfig() {
  const json = readJsonConfig();
  const env = readDotEnv();

  const apiKey =
    process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || json.anthropicApiKey || null;
  const model =
    process.env.RAILWAY_MODEL || env.RAILWAY_MODEL || json.model || "claude-sonnet-4-6";

  return { apiKey, model, hasKey: Boolean(apiKey) };
}

module.exports = { loadConfig };
