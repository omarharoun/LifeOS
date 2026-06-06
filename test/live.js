/**
 * Live smoke test — exercises real generation through the configured provider
 * (OpenRouter or Anthropic). Requires a key (railway.config.json / env).
 * Run: npm run live   (skips with exit 0 if no key is configured)
 */
const { loadConfig } = require("../electron/config");
const { routeRequest } = require("../electron/generate");

(async () => {
  const cfg = loadConfig();
  if (!cfg.hasKey) {
    console.log("LIVE: no API key configured — skipping (set railway.config.json).");
    process.exit(0);
  }
  console.log(`LIVE: provider=${cfg.provider} model=${cfg.model}\n`);

  const cases = [
    { req: "draft the tricky email to the vendor about the overcharge", want: "surface" },
    { req: "tell Sarah I'm running late", want: "do" },
    { req: "check inbox", want: "surface" },
  ];

  let failures = 0;
  for (const c of cases) {
    try {
      const res = await routeRequest(c.req, {
        apiKey: cfg.apiKey,
        model: cfg.model,
        provider: cfg.provider,
      });
      if (!res.ok) {
        console.log(`  ✗ "${c.req}" => error: ${res.error}`);
        failures++;
        continue;
      }
      const okMode = res.mode === c.want;
      // a surface must be contract-valid (routeRequest already validated it)
      const detail =
        res.mode === "do"
          ? `do ${res.capability} (${res.summary})`
          : `surface [${res.surface.blocks.map((b) => b.type).join("+")}] "${res.surface.intent}"`;
      console.log(`  ${okMode ? "✓" : "✗"} "${c.req}" => ${detail}${okMode ? "" : ` (expected ${c.want})`}`);
      if (!okMode) failures++;
    } catch (e) {
      console.log(`  ✗ "${c.req}" threw: ${e.message}`);
      failures++;
    }
  }

  console.log(failures === 0 ? "\nLIVE SMOKE: PASS" : `\nLIVE SMOKE: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
