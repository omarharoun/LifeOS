/**
 * Railway — Google Calendar integration (2nd app)
 * ------------------------------------------------------------------
 * Proof of the seam pattern: adding an app is just its two seams —
 *   - DATA: list upcoming events (DataContext query "agenda").
 *   - ACTIONS: create an event (CapabilityRegistry "calendar.createEvent").
 * Auth is the SAME google-auth.js as Gmail; nothing else changes.
 * Falls back to mock agenda + simulated create when unauthorized (seams.js).
 * ------------------------------------------------------------------
 */
const { google } = require("googleapis");
const auth = require("./google-auth");

/* ---------- pure helpers (unit-tested, no network) ---------- */

/** Compact "when" label for an event, e.g. "Today 3:00 PM" / "Tue 9:30 AM". */
function formatEventWhen(event, now = new Date()) {
  const raw = event?.start?.dateTime || event?.start?.date;
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  const allDay = !event.start.dateTime;
  const sameDay = d.toDateString() === now.toDateString();
  const day = sameDay
    ? "Today"
    : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  if (allDay) return `${day} (all day)`;
  return `${day} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Normalize do-it args into a Calendar event resource. Accepts ISO strings or
 * { dateTime } for start/end; if no end, defaults to start + 1 hour.
 */
function buildEventResource({ summary, description, location, start, end }) {
  const toDT = (v) => {
    if (!v) return null;
    if (typeof v === "object" && (v.dateTime || v.date)) return v;
    const d = new Date(v);
    if (isNaN(d.getTime())) {
      // Clear, actionable error instead of a cryptic RangeError surfaced as a
      // generic "create failed". (#4)
      throw new Error(
        `Couldn't understand the date/time "${v}". Use e.g. "2026-06-08 10:00" or an ISO time.`
      );
    }
    return { dateTime: d.toISOString() };
  };
  const s = toDT(start);
  let e = toDT(end);
  if (s?.dateTime && !e) {
    e = { dateTime: new Date(new Date(s.dateTime).getTime() + 60 * 60 * 1000).toISOString() };
  }
  const resource = { summary: summary || "(untitled)" };
  if (description) resource.description = description;
  if (location) resource.location = location;
  if (s) resource.start = s;
  if (e) resource.end = e;
  return resource;
}

/* ---------- API calls ---------- */

async function listUpcoming(max = 10) {
  const cal = google.calendar({ version: "v3", auth: auth.getAuthorizedClient() });
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults: max,
    singleEvents: true,
    orderBy: "startTime",
  });
  return (res.data.items || []).map((ev) => ({
    id: ev.id,
    title: ev.summary || "(no title)",
    when: formatEventWhen(ev),
    location: ev.location || "",
  }));
}

async function createEvent(args) {
  const cal = google.calendar({ version: "v3", auth: auth.getAuthorizedClient() });
  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: buildEventResource(args),
  });
  return { id: res.data.id, htmlLink: res.data.htmlLink, summary: res.data.summary };
}

async function deleteEvent(id) {
  const cal = google.calendar({ version: "v3", auth: auth.getAuthorizedClient() });
  await cal.events.delete({ calendarId: "primary", eventId: id });
  return { ok: true, id };
}

module.exports = { formatEventWhen, buildEventResource, listUpcoming, createEvent, deleteEvent };
