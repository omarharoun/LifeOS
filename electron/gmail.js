/**
 * Railway — Gmail integration (M3)
 * ------------------------------------------------------------------
 * The first real connection. Two responsibilities, matching the contract's
 * two per-system seams:
 *   - DATA: list real inbox threads (DataContext query "inbox").
 *   - ACTIONS: actually send an email (CapabilityRegistry "email.send").
 *
 * Auth is Google OAuth (Desktop-app client) with a loopback redirect. You
 * supply gmail.credentials.json (from Google Cloud Console); the token is
 * cached in gmail.token.json. Both are gitignored. Run the one-time consent
 * with `npm run gmail-auth`.
 *
 * If credentials/token are absent the app still runs — the caller falls back
 * to mock inbox data and a simulated send (see electron/seams.js).
 * ------------------------------------------------------------------
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { google } = require("googleapis");

const ROOT = path.join(__dirname, "..");
const CRED_PATH = path.join(ROOT, "gmail.credentials.json");
const TOKEN_PATH = path.join(ROOT, "gmail.token.json");

// Read inbox + send. (gmail.send is narrower than full gmail.modify.)
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

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
  if (sameDay)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ---------- config / auth ---------- */

function isConfigured() {
  return fs.existsSync(CRED_PATH);
}
function isAuthorized() {
  return fs.existsSync(CRED_PATH) && fs.existsSync(TOKEN_PATH);
}

function readCredentials() {
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));
  const c = raw.installed || raw.web;
  if (!c) throw new Error("gmail.credentials.json: expected an 'installed' or 'web' client.");
  return c;
}

function makeOAuthClient(redirectUri) {
  const c = readCredentials();
  return new google.auth.OAuth2(
    c.client_id,
    c.client_secret,
    redirectUri || (c.redirect_uris && c.redirect_uris[0]) || "http://localhost"
  );
}

/** Authorized client from the cached token (auto-refresh on use). */
function getAuthorizedClient() {
  if (!isAuthorized()) throw new Error("Gmail not authorized — run `npm run gmail-auth`.");
  const oauth = makeOAuthClient();
  oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  // Persist refreshed tokens so we don't re-consent.
  oauth.on("tokens", (t) => {
    const merged = { ...JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")), ...t };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return oauth;
}

/**
 * Interactive one-time consent via a loopback server. `openUrl` defaults to
 * printing the URL; in Electron pass shell.openExternal.
 */
async function runConsentFlow({ openUrl } = {}) {
  if (!isConfigured())
    throw new Error("Missing gmail.credentials.json (see README / Google Cloud Console).");

  return new Promise((resolve, reject) => {
    let oauth; // set once the server is listening and we know the redirect port

    const server = http.createServer(async (req, res) => {
      try {
        const code = new URL(req.url, "http://localhost").searchParams.get("code");
        if (!code) {
          res.writeHead(400).end("No authorization code in request.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Railway is connected to Gmail. You can close this tab.</h2>");
        server.close();
        const { tokens } = await oauth.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        resolve(tokens);
      } catch (e) {
        reject(e);
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      oauth = makeOAuthClient(`http://127.0.0.1:${port}`);
      const authUrl = oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });
      if (openUrl) openUrl(authUrl);
      else console.log("\nOpen this URL to authorize Railway → Gmail:\n\n" + authUrl + "\n");
    });
  });
}

/* ---------- API calls ---------- */

async function listInbox(max = 10) {
  const auth = getAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const list = await gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: max });
  const ids = (list.data.messages || []).map((m) => m.id);
  const items = await Promise.all(
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
  return items;
}

async function sendMessage({ to, subject, body }) {
  const auth = getAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildRawMessage({ to, subject, body });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return { id: res.data.id, threadId: res.data.threadId };
}

async function getProfileEmail() {
  const auth = getAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.getProfile({ userId: "me" });
  return res.data.emailAddress;
}

module.exports = {
  buildRawMessage,
  pickHeaders,
  shortDate,
  isConfigured,
  isAuthorized,
  runConsentFlow,
  listInbox,
  sendMessage,
  getProfileEmail,
  CRED_PATH,
  TOKEN_PATH,
};
