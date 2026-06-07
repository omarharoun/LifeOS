/**
 * Config tests — provider/model/hotkey/history/local resolution. No network.
 * Isolated via RAILWAY_DATA_DIR → empty temp dir so the real railway.config.json
 * isn't read. Run: node test/config.test.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Point config at an empty dir BEFORE requiring it (paths.js reads the env).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "railway-cfg-"));
process.env.RAILWAY_DATA_DIR = tmp;

// Clear anything that would leak from the real environment.
for (const k of [
  "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "RAILWAY_PROVIDER", "RAILWAY_MODEL",
  "RAILWAY_BASE_URL", "RAILWAY_HOTKEY", "RAILWAY_NO_HISTORY",
]) delete process.env[k];

const { loadConfig } = require("../electron/config");

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

(async () => {
  console.log("Config tests:");

  // Defaults with no key: generation disabled, sensible hotkey/history.
  {
    const c = loadConfig();
    assert.equal(c.provider, "anthropic");
    assert.equal(c.hasKey, false);
    assert.equal(c.hotkey, "CommandOrControl+Space");
    assert.equal(c.sendHistory, true);
    ok("defaults: anthropic, no key, Ctrl+Space, history on");
  }

  // OpenRouter key → provider inferred from prefix; generation enabled.
  {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const c = loadConfig();
    assert.equal(c.provider, "openrouter");
    assert.equal(c.model, "anthropic/claude-sonnet-4.5");
    assert.equal(c.hasKey, true);
    delete process.env.OPENROUTER_API_KEY;
    ok("OpenRouter key → provider+model inferred, enabled");
  }

  // Local provider → no key needed, generation still enabled.
  {
    process.env.RAILWAY_PROVIDER = "local";
    process.env.RAILWAY_BASE_URL = "http://localhost:11434/v1";
    const c = loadConfig();
    assert.equal(c.provider, "local");
    assert.equal(c.hasKey, true, "local needs no key but is enabled");
    assert.equal(c.model, "llama3.1");
    assert.equal(c.baseUrl, "http://localhost:11434/v1");
    delete process.env.RAILWAY_PROVIDER;
    delete process.env.RAILWAY_BASE_URL;
    ok("local provider: enabled without a key, default model + base URL");
  }

  // Privacy + hotkey overrides.
  {
    process.env.RAILWAY_NO_HISTORY = "1";
    process.env.RAILWAY_HOTKEY = "Control+Alt+Space";
    const c = loadConfig();
    assert.equal(c.sendHistory, false);
    assert.equal(c.hotkey, "Control+Alt+Space");
    delete process.env.RAILWAY_NO_HISTORY;
    delete process.env.RAILWAY_HOTKEY;
    ok("RAILWAY_NO_HISTORY disables history; RAILWAY_HOTKEY overrides hotkey");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nCONFIG TESTS: PASS (${passed}/4)`);
})().catch((e) => {
  console.error("\nCONFIG TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
