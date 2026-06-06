/**
 * Calendar tests — pure helpers + seams. Hermetic (no network, no real account).
 * Run: node test/calendar.test.js
 */
process.env.RAILWAY_NO_GMAIL = "1";

const assert = require("node:assert");
const calendar = require("../electron/calendar");
const seams = require("../electron/seams");

let passed = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

(async () => {
  console.log("Calendar tests:");

  // formatEventWhen: timed today / other day / all-day / missing.
  {
    const now = new Date("2025-06-10T08:00:00");
    const today = calendar.formatEventWhen({ start: { dateTime: "2025-06-10T15:00:00" } }, now);
    assert.match(today, /^Today /);
    const other = calendar.formatEventWhen({ start: { dateTime: "2025-06-12T09:30:00" } }, now);
    assert.ok(other && !/^Today/.test(other));
    const allDay = calendar.formatEventWhen({ start: { date: "2025-06-15" } }, now);
    assert.match(allDay, /all day/);
    assert.equal(calendar.formatEventWhen({}, now), "");
    ok("formatEventWhen handles timed / other-day / all-day / missing");
  }

  // buildEventResource: ISO start → {dateTime}; default +1h end; title default.
  {
    const r = calendar.buildEventResource({ summary: "Coffee", start: "2025-06-10T10:00:00Z", location: "Cafe" });
    assert.equal(r.summary, "Coffee");
    assert.equal(r.location, "Cafe");
    assert.ok(r.start.dateTime.startsWith("2025-06-10T10:00"));
    assert.ok(r.end.dateTime.startsWith("2025-06-10T11:00"), "defaults end to start + 1h");
    const bare = calendar.buildEventResource({});
    assert.equal(bare.summary, "(untitled)");
    ok("buildEventResource normalizes start/end and defaults");
  }

  // DATA seam: agenda falls back to mock when unauthorized, with expected fields.
  {
    const items = await seams.resolveQuery("agenda");
    assert.ok(Array.isArray(items) && items.length >= 1);
    assert.ok("title" in items[0] && "when" in items[0] && "location" in items[0]);
    // aliases resolve too
    assert.deepEqual(await seams.resolveQuery("calendar"), items);
    ok("resolveQuery('agenda') returns mock events with {title,when,location}");
  }

  // ACTIONS seam: simulated create when unauthorized; rejects missing title.
  {
    const created = await seams.invokeCapability("calendar.createEvent", {
      event: { summary: "Lunch with Sam", start: "2025-06-11T12:00:00Z" },
    });
    assert.equal(created.ok, true);
    assert.equal(created.simulated, true);
    assert.equal(created.summary, "Lunch with Sam");

    // accepts flat args + title alias
    const flat = await seams.invokeCapability("calendar.createEvent", { title: "Sync", start: "2025-06-11T12:00:00Z" });
    assert.equal(flat.ok, true);
    assert.equal(flat.summary, "Sync");

    const bad = await seams.invokeCapability("calendar.createEvent", { event: {} });
    assert.equal(bad.ok, false);
    ok("invokeCapability('calendar.createEvent') simulates + validates inputs");
  }

  console.log(`\nCALENDAR TESTS: PASS (${passed}/4)`);
})().catch((e) => {
  console.error("\nCALENDAR TESTS: FAIL");
  console.error(e);
  process.exit(1);
});
