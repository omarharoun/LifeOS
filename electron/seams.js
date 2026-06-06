/**
 * Railway — the two per-system seams (M3)
 * ------------------------------------------------------------------
 * From MVP_BUILD_PLAN.md ("The two pieces you implement per integration"):
 *   1. DATA: resolve a query like "inbox" / a ref to real values.
 *   2. ACTIONS: run a named capability like "email.send".
 *
 * Email is the first system. Adding another later = another branch here.
 * When Gmail isn't authorized, everything degrades to mock data + a
 * simulated send so the app keeps working end-to-end for development.
 * ------------------------------------------------------------------
 */
const gmail = require("./gmail");
const calendar = require("./calendar");
const auth = require("./google-auth");

// The capabilities the registry can actually invoke. Used as the semantic gate
// (checkCapabilities) before a surface is allowed to render, so the model can't
// emit an action we can't perform. "ui.dismiss" is handled in the renderer.
const KNOWN_CAPABILITIES = ["email.send", "email.openThread", "calendar.createEvent", "ui.dismiss"];

// Mock data used until Google is connected (mirrors SurfaceRenderer's demo).
const MOCK_INBOX = [
  { id: "t1", from: "Sarah Chen", snippet: "Can we move the 3pm?", date: "9:02" },
  { id: "t2", from: "Vendor Billing", snippet: "Q3 invoice attached", date: "Tue" },
  { id: "t3", from: "Design weekly", snippet: "Notes from standup", date: "Mon" },
];
const MOCK_AGENDA = [
  { id: "e1", title: "Standup", when: "Today 9:30 AM", location: "Zoom" },
  { id: "e2", title: "Lunch w/ Sarah", when: "Today 12:30 PM", location: "Cafe Luce" },
  { id: "e3", title: "Design review", when: "Tue 3:00 PM", location: "Room 2" },
];

/** DATA seam: resolve a query source to a collection. */
async function resolveQuery(source) {
  if (source === "inbox") {
    if (auth.isAuthorized()) {
      try {
        return await gmail.listInbox(12);
      } catch (e) {
        return { error: `Gmail read failed: ${e?.message || e}`, items: MOCK_INBOX };
      }
    }
    return MOCK_INBOX;
  }
  if (source === "agenda" || source === "calendar" || source === "events") {
    if (auth.isAuthorized()) {
      try {
        return await calendar.listUpcoming(12);
      } catch (e) {
        return { error: `Calendar read failed: ${e?.message || e}`, items: MOCK_AGENDA };
      }
    }
    return MOCK_AGENDA;
  }
  return []; // unknown source — empty for now
}

/**
 * Walk a generated surface and resolve every list's query source against the
 * DATA seam, merging results into `data` so the renderer can render real rows.
 */
async function enrichSurfaceData(surface, data = {}) {
  const out = { ...data };
  for (const node of surface?.blocks || []) {
    if (node.type === "list" && node.source?.kind === "query") {
      const src = node.source.source;
      const resolved = await resolveQuery(src);
      out[src] = Array.isArray(resolved) ? resolved : resolved.items || [];
    }
  }
  return out;
}

/** ACTIONS seam: run a named capability with already-resolved args. */
async function invokeCapability(name, args = {}) {
  switch (name) {
    case "email.send": {
      // args.draft is the resolved {to, subject, body}; some surfaces pass them flat.
      const d = args.draft || args;
      const to = d.to;
      const subject = d.subject;
      const body = d.body;
      if (!to) return { ok: false, error: "No recipient to send to." };
      if (gmail.isAuthorized()) {
        try {
          const sent = await gmail.sendMessage({ to, subject, body });
          return { ok: true, to, id: sent.id, simulated: false };
        } catch (e) {
          return { ok: false, error: `Send failed: ${e?.message || e}` };
        }
      }
      return { ok: true, to, simulated: true }; // dev fallback: pretend-send
    }
    case "email.openThread":
      return { ok: true, note: "openThread is not wired yet" };
    case "calendar.createEvent": {
      const a = args.event || args;
      if (!a.summary && !a.title) return { ok: false, error: "No event title." };
      const eventArgs = { ...a, summary: a.summary || a.title };
      if (auth.isAuthorized()) {
        try {
          const created = await calendar.createEvent(eventArgs);
          return { ok: true, summary: created.summary, id: created.id, link: created.htmlLink, simulated: false };
        } catch (e) {
          return { ok: false, error: `Create event failed: ${e?.message || e}` };
        }
      }
      return { ok: true, summary: eventArgs.summary, simulated: true };
    }
    default:
      return { ok: false, error: `Unknown capability: ${name}` };
  }
}

async function status() {
  const configured = auth.isConfigured();
  const authorized = auth.isAuthorized();
  let email = null;
  if (authorized) {
    try {
      email = await gmail.getProfileEmail();
    } catch {
      /* token may be stale; treat as unauthorized-ish */
    }
  }
  return { configured, authorized, email };
}

module.exports = {
  resolveQuery,
  enrichSurfaceData,
  invokeCapability,
  status,
  KNOWN_CAPABILITIES,
  MOCK_INBOX,
  MOCK_AGENDA,
};
