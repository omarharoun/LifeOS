/**
 * M2 generation tests — no live API key required.
 * Injects a fake Anthropic client to exercise the validate→repair loop
 * deterministically. Run: node test/generate.test.js
 * (Requires `npm run build` first so electron/gen/contract.mjs exists.)
 */
const assert = require("node:assert");
const { generateSurface } = require("../electron/generate");

let passed = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

// A valid surface the model might emit (matches surface-contract.ts).
const validSurface = {
  id: "srf_1",
  intent: "Draft a quick reply",
  ephemeral: true,
  blocks: [
    {
      type: "composer",
      id: "cmp_1",
      fields: [{ key: "body", label: "Body", binding: { kind: "ref", path: "draft.body" }, multiline: true }],
    },
    {
      type: "confirm",
      id: "cnf_1",
      summary: "Send it?",
      onConfirm: { capability: "email.send", args: { draft: { kind: "ref", path: "draft" } } },
      onCancel: { capability: "ui.dismiss", args: {} },
    },
  ],
};

// An invalid surface (blocks empty → fails contract).
const invalidSurface = { id: "srf_bad", intent: "broken", blocks: [] };

function toolUseResponse(surface, data) {
  return {
    content: [
      { type: "tool_use", id: "tu_" + Math.round(surface.blocks.length), name: "emit_surface", input: { surface, data } },
    ],
  };
}

// Fake client that returns a scripted sequence of responses.
function fakeClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return responses[Math.min(i++, responses.length - 1)];
      },
    },
  };
}

(async () => {
  console.log("M2 generation tests:");

  // 1) Valid on first try → returns ok with the validated surface + data.
  {
    const client = fakeClient([toolUseResponse(validSurface, { draft: { body: "hi" } })]);
    const res = await generateSurface("reply to sarah", { client, model: "x" });
    assert.equal(res.ok, true, "should succeed");
    assert.equal(res.surface.intent, "Draft a quick reply");
    assert.deepEqual(res.data, { draft: { body: "hi" } });
    assert.equal(client.calls.length, 1, "one API call");
    // The tool was forced and its schema was derived from the contract.
    assert.equal(client.calls[0].tool_choice.name, "emit_surface");
    assert.ok(client.calls[0].tools[0].input_schema.properties.surface, "surface schema present");
    ok("valid surface on first try returns ok (forced tool, contract-derived schema)");
  }

  // 2) Invalid then valid → repair loop fixes it on the second call.
  {
    const client = fakeClient([
      toolUseResponse(invalidSurface, {}),
      toolUseResponse(validSurface, { draft: { body: "fixed" } }),
    ]);
    const res = await generateSurface("reply", { client, model: "x" });
    assert.equal(res.ok, true, "should repair and succeed");
    assert.equal(client.calls.length, 2, "two API calls (initial + repair)");
    // The repair turn must include a tool_result carrying the validation errors.
    const repairMsg = client.calls[1].messages.find(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result")
    );
    assert.ok(repairMsg, "repair turn includes a tool_result with errors");
    ok("invalid surface triggers repair loop and recovers");
  }

  // 3) Always invalid → gives up after MAX_REPAIR_ATTEMPTS with an error.
  {
    const client = fakeClient([toolUseResponse(invalidSurface, {})]);
    const res = await generateSurface("reply", { client, model: "x" });
    assert.equal(res.ok, false, "should fail");
    assert.equal(client.calls.length, 3, "exhausts 3 attempts");
    assert.match(res.error, /valid surface/i);
    ok("persistently invalid output fails gracefully after retries");
  }

  // 4) No key and no client → needKey signal (renderer falls back).
  {
    const res = await generateSurface("anything", {});
    assert.equal(res.ok, false);
    assert.equal(res.needKey, true);
    ok("no API key returns needKey (graceful fallback signal)");
  }

  // 5) Capability gate: a shape-valid surface referencing an UNREGISTERED
  //    capability triggers repair (it can't render an action we can't invoke).
  {
    const unregistered = {
      id: "s",
      intent: "archive it",
      ephemeral: true,
      blocks: [{ type: "confirm", id: "c", summary: "Archive?", onConfirm: { capability: "email.archive", args: {} } }],
    };
    const client = fakeClient([
      toolUseResponse(unregistered, {}), // shape-valid, but email.archive isn't registered
      toolUseResponse(validSurface, { draft: { body: "ok" } }),
    ]);
    const res = await generateSurface("archive it", {
      client,
      model: "x",
      capabilities: ["email.send", "ui.dismiss"],
    });
    assert.equal(res.ok, true, "should repair to a surface with only registered capabilities");
    assert.equal(client.calls.length, 2, "one repair round");
    const repair = client.calls[1].messages.find(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result")
    );
    assert.match(repair.content[0].content, /email\.archive|not available/i);
    ok("unregistered capability triggers the semantic gate → repair");
  }

  console.log(`\nM2 GENERATION TESTS: PASS (${passed}/5)`);
})().catch((e) => {
  console.error("\nM2 GENERATION TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
