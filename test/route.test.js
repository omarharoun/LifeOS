/**
 * M4 router tests — do-it vs show-me, with a mock Anthropic client.
 * Run: node test/route.test.js  (after npm run build)
 */
const assert = require("node:assert");
const { routeRequest } = require("../electron/generate");

let passed = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

const validSurface = {
  id: "s1",
  intent: "Draft email",
  ephemeral: true,
  blocks: [
    { type: "composer", id: "c1", fields: [{ key: "body", label: "Body", binding: { kind: "ref", path: "draft.body" } }] },
  ],
};
const invalidSurface = { id: "bad", intent: "x", blocks: [] };

const surfaceResp = (surface, data) => ({
  content: [{ type: "tool_use", id: "tu1", name: "emit_surface", input: { surface, data } }],
});
const doResp = (capability, args, summary) => ({
  content: [{ type: "tool_use", id: "tu2", name: "do_silently", input: { capability, args, summary } }],
});

function fakeClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: { create: async (req) => (calls.push(req), responses[Math.min(i++, responses.length - 1)]) },
  };
}

(async () => {
  console.log("M4 router tests:");

  // do_silently → mode "do" with capability/args/summary.
  {
    const client = fakeClient([
      doResp("email.send", { to: "sarah@x.com", subject: "Running late", body: "10 min behind" }, "Tell Sarah you're late"),
    ]);
    const res = await routeRequest("tell sarah I'm running late", { client, model: "x" });
    assert.equal(res.ok, true);
    assert.equal(res.mode, "do");
    assert.equal(res.capability, "email.send");
    assert.equal(res.args.to, "sarah@x.com");
    // The router offers both tools and lets the model choose.
    assert.equal(client.calls[0].tool_choice.type, "any");
    assert.equal(client.calls[0].tools.length, 2);
    ok('"tell sarah I\'m running late" routes to do-it (silent send)');
  }

  // emit_surface valid → mode "surface".
  {
    const client = fakeClient([surfaceResp(validSurface, { draft: { body: "hi" } })]);
    const res = await routeRequest("draft the tricky email", { client, model: "x" });
    assert.equal(res.ok, true);
    assert.equal(res.mode, "surface");
    assert.equal(res.surface.intent, "Draft email");
    ok('"draft the tricky email" routes to show-me (a surface)');
  }

  // emit_surface invalid → falls back to the repair loop and recovers.
  {
    const client = fakeClient([
      surfaceResp(invalidSurface, {}), // router call: chosen tool is emit_surface but invalid
      surfaceResp(invalidSurface, {}), // repair attempt 1
      surfaceResp(validSurface, { draft: { body: "ok" } }), // repair attempt 2
    ]);
    const res = await routeRequest("write something", { client, model: "x" });
    assert.equal(res.ok, true);
    assert.equal(res.mode, "surface");
    assert.equal(client.calls.length, 3, "router call + 2 repair attempts");
    ok("invalid surface from the router recovers via the repair loop");
  }

  // No key → needKey.
  {
    const res = await routeRequest("anything", {});
    assert.equal(res.ok, false);
    assert.equal(res.needKey, true);
    ok("no API key returns needKey");
  }

  console.log(`\nM4 ROUTER TESTS: PASS (${passed}/4)`);
})().catch((e) => {
  console.error("\nM4 ROUTER TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
