/**
 * M3 Gmail tests — pure helpers + seams, no network, no credentials.
 * Run: node test/gmail.test.js
 */
// Force the mock path so this test never touches a real (authorized) account
// or sends a live email, even when gmail.token.json exists.
process.env.RAILWAY_NO_GMAIL = "1";

const assert = require("node:assert");
const gmail = require("../electron/gmail");
const seams = require("../electron/seams");

let passed = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

(async () => {
  console.log("M3 Gmail tests:");

  // buildRawMessage produces a decodable RFC822 message with the right parts.
  {
    const raw = gmail.buildRawMessage({
      to: "a@b.com",
      subject: "Hi there",
      body: "Line one\nLine two",
    });
    const decoded = b64urlDecode(raw);
    assert.ok(decoded.includes("To: a@b.com"));
    assert.ok(decoded.includes("Subject: Hi there"));
    assert.ok(/Content-Type: text\/plain/.test(decoded));
    assert.ok(decoded.includes("Line one\nLine two"));
    assert.ok(!/[+/]/.test(raw.replace(/-|_/g, "")) || true); // base64url (no +,/)
    assert.ok(!raw.includes("+") && !raw.includes("/"), "uses base64url alphabet");
    ok("buildRawMessage encodes a valid base64url RFC822 message");
  }

  // pickHeaders extracts a friendly From and the Subject/Date.
  {
    const h = gmail.pickHeaders([
      { name: "From", value: '"Sarah Chen" <sarah@x.com>' },
      { name: "Subject", value: "Lunch?" },
      { name: "Date", value: "Mon, 2 Jun 2025 09:02:00 +0000" },
    ]);
    assert.equal(h.from, "Sarah Chen");
    assert.equal(h.subject, "Lunch?");
    ok("pickHeaders parses a friendly sender name");
  }

  // shortDate: same day → time; other day → month/day.
  {
    const now = new Date("2025-06-02T18:00:00");
    const sameDay = gmail.shortDate("2025-06-02T09:02:00", now);
    const otherDay = gmail.shortDate("2025-05-30T09:02:00", now);
    assert.ok(sameDay.length > 0 && sameDay !== otherDay);
    assert.match(otherDay, /May|05/);
    assert.equal(gmail.shortDate("not a date", now), "");
    ok("shortDate formats same-day vs older messages");
  }

  // DATA seam: inbox query falls back to mock when unauthorized.
  {
    const items = await seams.resolveQuery("inbox");
    assert.ok(Array.isArray(items) && items.length >= 1);
    assert.ok(items[0].from && items[0].snippet);
    assert.deepEqual(await seams.resolveQuery("nope"), []);
    ok("resolveQuery('inbox') returns mock rows when Gmail is unauthorized");
  }

  // enrichSurfaceData injects resolved rows for a list's query source.
  {
    const surface = {
      blocks: [
        { type: "list", id: "l1", source: { kind: "query", source: "inbox" }, item: { title: "{{from}}" } },
      ],
    };
    const data = await seams.enrichSurfaceData(surface, {});
    assert.ok(Array.isArray(data.inbox) && data.inbox.length >= 1);
    ok("enrichSurfaceData resolves a list's query into data");
  }

  // ACTIONS seam: simulated send when unauthorized; rejects missing recipient.
  {
    const sent = await seams.invokeCapability("email.send", { draft: { to: "x@y.com", subject: "Hi", body: "yo" } });
    assert.equal(sent.ok, true);
    assert.equal(sent.simulated, true);
    assert.equal(sent.to, "x@y.com");

    const bad = await seams.invokeCapability("email.send", { draft: {} });
    assert.equal(bad.ok, false);

    const unknown = await seams.invokeCapability("does.not.exist", {});
    assert.equal(unknown.ok, false);
    ok("invokeCapability simulates send (unauthorized) and validates inputs");
  }

  // status reflects no-credentials state.
  {
    const s = await seams.status();
    assert.equal(typeof s.configured, "boolean");
    assert.equal(typeof s.authorized, "boolean");
    ok("status() reports configuration/authorization flags");
  }

  console.log(`\nM3 GMAIL TESTS: PASS (${passed}/7)`);
})().catch((e) => {
  console.error("\nM3 GMAIL TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
