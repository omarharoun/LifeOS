/**
 * Railway — Gmail integration (M3)
 * ------------------------------------------------------------------
 * The first real connection. Two responsibilities, matching the contract's
 * two per-system seams:
 *   - DATA: list real inbox threads (DataContext query "inbox").
 *   - ACTIONS: actually send an email (CapabilityRegistry "email.send").
 *
 * Auth lives in google-auth.js (shared with calendar.js). If credentials/token
 * are absent the caller falls back to mock inbox + simulated send (seams.js).
 * ------------------------------------------------------------------
 */
const { google } = require("googleapis");
const auth = require("./google-auth");

/* ---------- pure helpers (unit-tested, no network) ---------- */

/** Build a base64url-encoded RFC 2822 message for gmail.users.messages.send. */
function buildRawMessage({ to, subject, body, from, inReplyTo }) {
  const headers = [
    from ? `From: ${from}` : null,
    `To: ${to}`,
    `Subject: ${subject || ""}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  const message = headers.join("\r\n") + "\r\n\r\n" + (body || "");
  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Pull the fields we show from a message's MIME headers. */
function pickHeaders(headers = []) {
  const find = (name) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  const rawFrom = find("From");
  // "Sarah Chen <sarah@x.com>" → "Sarah Chen"; fall back to the address.
  const from = rawFrom.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || rawFrom;
  return { from, subject: find("Subject"), date: find("Date") };
}

/** Format a Date header into the compact label the list shows. */
function shortDate(dateStr, now = new Date()) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ---------- API calls ---------- */

async function listInbox(max = 10) {
  const gmail = google.gmail({ version: "v1", auth: auth.getAuthorizedClient() });
  const list = await gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: max });
  const ids = (list.data.messages || []).map((m) => m.id);
  return Promise.all(
    ids.map(async (id) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const { from, date } = pickHeaders(msg.data.payload?.headers);
      return { id, from, snippet: msg.data.snippet || "", date: shortDate(date) };
    })
  );
}

async function sendMessage({ to, subject, body }) {
  const gmail = google.gmail({ version: "v1", auth: auth.getAuthorizedClient() });
  const raw = buildRawMessage({ to, subject, body });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return { id: res.data.id, threadId: res.data.threadId };
}

async function getProfileEmail() {
  const gmail = google.gmail({ version: "v1", auth: auth.getAuthorizedClient() });
  const res = await gmail.users.getProfile({ userId: "me" });
  return res.data.emailAddress;
}

module.exports = {
  buildRawMessage,
  pickHeaders,
  shortDate,
  // auth re-exported for backward compatibility (gmail-auth.js, seams.js).
  isConfigured: auth.isConfigured,
  isAuthorized: auth.isAuthorized,
  runConsentFlow: auth.runConsentFlow,
  listInbox,
  sendMessage,
  getProfileEmail,
  CRED_PATH: auth.CRED_PATH,
  TOKEN_PATH: auth.TOKEN_PATH,
};
