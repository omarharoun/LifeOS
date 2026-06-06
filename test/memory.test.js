/**
 * M5 memory tests — local log + relevance + stats. No Electron, no network.
 * Run: node test/memory.test.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMemory } = require("../electron/memory");
const { routeRequest } = require("../electron/generate");

let passed = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

const tmp = path.join(os.tmpdir(), `railway-mem-${process.pid}.json`);
const cleanup = () => {
  try {
    fs.unlinkSync(tmp);
  } catch {}
};

(async () => {
  console.log("M5 memory tests:");
  cleanup();
  const mem = createMemory(tmp);

  // append + recent (most-recent-first).
  {
    mem.append({ request: "email the vendor about the invoice", intent: "Draft vendor email", mode: "surface", edits: 3, committed: true, timeToDoneMs: 9000, ts: 1 });
    mem.append({ request: "check inbox", intent: "inbox", mode: "surface", edits: 0, committed: true, timeToDoneMs: 1000, ts: 2 });
    mem.append({ request: "tell sarah I'm late", intent: "Tell Sarah", mode: "do", edits: 0, committed: true, timeToDoneMs: 500, ts: 3 });
    const r = mem.recent(2);
    assert.equal(r.length, 2);
    assert.equal(r[0].request, "tell sarah I'm late");
    ok("append + recent returns most-recent-first");
  }

  // relevant ranks by keyword overlap.
  {
    const rel = mem.relevant("send the vendor another invoice email");
    assert.ok(rel.length >= 1);
    assert.match(rel[0].request, /vendor/);
    assert.ok("edits" in rel[0]);
    ok("relevant() ranks prior requests by keyword overlap");
  }

  // unrelated request → no false matches.
  {
    const rel = mem.relevant("what's the weather");
    assert.equal(rel.length, 0);
    ok("relevant() returns nothing for unrelated requests");
  }

  // stats: median time-to-done.
  {
    const s = mem.stats();
    assert.equal(s.count, 3);
    assert.equal(s.medianTimeToDoneMs, 1000); // median of [500,1000,9000]
    ok("stats() reports count + median time-to-done");
  }

  // history is actually fed into the model prompt (the whole point of M5).
  {
    const calls = [];
    const client = {
      messages: {
        create: async (req) => {
          calls.push(req);
          return { content: [{ type: "tool_use", id: "t", name: "do_silently", input: { capability: "email.send", args: {}, summary: "x" } }] };
        },
      },
    };
    await routeRequest("email the vendor again", {
      client,
      model: "x",
      history: mem.relevant("email the vendor again"),
    });
    const userMsg = calls[0].messages[0].content;
    assert.match(userMsg, /Recent things this user did/);
    assert.match(userMsg, /vendor/);
    ok("relevant history is injected into the model prompt");
  }

  cleanup();
  console.log(`\nM5 MEMORY TESTS: PASS (${passed}/5)`);
})().catch((e) => {
  cleanup();
  console.error("\nM5 MEMORY TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
