/**
 * Provider translation tests — Anthropic ⇄ OpenAI (OpenRouter). No network.
 * Run: node test/llm.test.js
 */
const assert = require("node:assert");
const { toOpenAIMessages, toOpenAITools, toOpenAIToolChoice, fromOpenAIResponse } = require("../electron/llm");

let passed = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

(async () => {
  console.log("Provider translation tests:");

  // system + plain user message.
  {
    const m = toOpenAIMessages("SYS", [{ role: "user", content: "hello" }]);
    assert.deepEqual(m, [{ role: "system", content: "SYS" }, { role: "user", content: "hello" }]);
    ok("system + user message translate to OpenAI shape");
  }

  // assistant tool_use → OpenAI tool_calls; tool_result → role:tool.
  {
    const messages = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "emit_surface", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "bad" }] },
    ];
    const m = toOpenAIMessages(null, messages);
    const asst = m.find((x) => x.role === "assistant");
    assert.equal(asst.tool_calls[0].id, "tu1");
    assert.equal(asst.tool_calls[0].function.name, "emit_surface");
    assert.equal(asst.tool_calls[0].function.arguments, JSON.stringify({ a: 1 }));
    const tool = m.find((x) => x.role === "tool");
    assert.equal(tool.tool_call_id, "tu1");
    assert.equal(tool.content, "bad");
    ok("tool_use ⇄ tool_calls and tool_result ⇄ role:tool round-trip");
  }

  // tools + tool_choice translation.
  {
    const tools = toOpenAITools([{ name: "emit", description: "d", input_schema: { type: "object" } }]);
    assert.equal(tools[0].type, "function");
    assert.equal(tools[0].function.name, "emit");
    assert.deepEqual(tools[0].function.parameters, { type: "object" });
    assert.deepEqual(toOpenAIToolChoice({ type: "tool", name: "emit" }), { type: "function", function: { name: "emit" } });
    assert.equal(toOpenAIToolChoice({ type: "any" }), "required");
    assert.equal(toOpenAIToolChoice({ type: "auto" }), "auto");
    ok("tools + tool_choice translate to OpenAI shape");
  }

  // OpenAI response → Anthropic content shape (with tool call + bad JSON guard).
  {
    const resp = fromOpenAIResponse({
      choices: [{ message: { content: "hi", tool_calls: [{ id: "c1", function: { name: "emit", arguments: '{"x":2}' } }] } }],
    });
    assert.deepEqual(resp.content[0], { type: "text", text: "hi" });
    assert.deepEqual(resp.content[1], { type: "tool_use", id: "c1", name: "emit", input: { x: 2 } });

    const bad = fromOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "c2", function: { name: "e", arguments: "not json" } }] } }] });
    assert.deepEqual(bad.content[0].input, {}); // malformed args → empty object, no throw
    ok("OpenAI response maps back to Anthropic content (bad-JSON safe)");
  }

  console.log(`\nPROVIDER TESTS: PASS (${passed}/4)`);
})().catch((e) => {
  console.error("\nPROVIDER TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
