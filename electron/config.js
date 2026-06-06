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

// Infer the provider from the key shape (override with config.provider /
// RAILWAY_PROVIDER). OpenRouter keys start with "sk-or-".
function inferProvider(apiKey, explicit) {
  if (explicit) return explicit;
  if (apiKey && apiKey.startsWith("sk-or-")) return "openrouter";
  return "anthropic";
}

const DEFAULT_MODEL = {
  anthropic: "claude-sonnet-4-6",
  openrouter: "anthropic/claude-sonnet-4.5",
};

function loadConfig() {
  const json = readJsonConfig();
  const env = readDotEnv();

  const apiKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.OPENROUTER_API_KEY ||
    json.apiKey ||
    json.anthropicApiKey ||
    json.openrouterApiKey ||
    null;

  const provider = inferProvider(
    apiKey,
    process.env.RAILWAY_PROVIDER || env.RAILWAY_PROVIDER || json.provider
  );

  const model =
    process.env.RAILWAY_MODEL || env.RAILWAY_MODEL || json.model || DEFAULT_MODEL[provider];

  return { apiKey, provider, model, hasKey: Boolean(apiKey) };
}

module.exports = { loadConfig };
