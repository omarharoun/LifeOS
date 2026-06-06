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

// Mock inbox used until Gmail is connected (mirrors SurfaceRenderer's demo).
const MOCK_INBOX = [
  { id: "t1", from: "Sarah Chen", snippet: "Can we move the 3pm?", date: "9:02" },
  { id: "t2", from: "Vendor Billing", snippet: "Q3 invoice attached", date: "Tue" },
  { id: "t3", from: "Design weekly", snippet: "Notes from standup", date: "Mon" },
];

/** DATA seam: resolve a query source to a collection. */
async function resolveQuery(source) {
  if (source === "inbox") {
    if (gmail.isAuthorized()) {
      try {
        return await gmail.listInbox(12);
      } catch (e) {
        return { error: `Gmail read failed: ${e?.message || e}`, items: MOCK_INBOX };
      }
    }
    return MOCK_INBOX;
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
    default:
      return { ok: false, error: `Unknown capability: ${name}` };
  }
}

async function status() {
  const configured = gmail.isConfigured();
  const authorized = gmail.isAuthorized();
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

module.exports = { resolveQuery, enrichSurfaceData, invokeCapability, status, MOCK_INBOX };
