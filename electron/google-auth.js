/**
 * Railway — shared Google OAuth (used by every Google integration)
 * ------------------------------------------------------------------
 * This is the auth plumbing both gmail.js and calendar.js sit on top of, so
 * adding a Google app is just its DATA + ACTIONS seam — auth doesn't change.
 *
 * Desktop-app OAuth with a loopback redirect. Credentials come from
 * gmail.credentials.json (kept that name so existing setups keep working);
 * the token is cached in gmail.token.json. One-time consent: `npm run gmail-auth`.
 *
 * RAILWAY_NO_GMAIL forces the unconfigured state (tests/hermetic selftest).
 * ------------------------------------------------------------------
 */
const fs = require("fs");
const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");
const { dataPath } = require("./paths");

const CRED_PATH = dataPath("gmail.credentials.json");
const TOKEN_PATH = dataPath("gmail.token.json");

// Every scope Railway's Google apps need. Gmail: read + send. Calendar: read
// upcoming events + create events. Adding a scope here means re-running consent.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

function isConfigured() {
  if (process.env.RAILWAY_NO_GMAIL) return false;
  return fs.existsSync(CRED_PATH);
}
function isAuthorized() {
  if (process.env.RAILWAY_NO_GMAIL) return false;
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

/** Authorized client from the cached token (auto-refresh + persist on use). */
function getAuthorizedClient() {
  if (!isAuthorized()) throw new Error("Google not authorized — run `npm run gmail-auth`.");
  const oauth = makeOAuthClient();
  oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  oauth.on("tokens", (t) => {
    const merged = { ...JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")), ...t };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return oauth;
}

/** Interactive one-time consent via a loopback server (grants all SCOPES). */
async function runConsentFlow({ openUrl } = {}) {
  if (!fs.existsSync(CRED_PATH))
    throw new Error("Missing gmail.credentials.json (see README / Google Cloud Console).");

  return new Promise((resolve, reject) => {
    let oauth;
    const server = http.createServer(async (req, res) => {
      try {
        const code = new URL(req.url, "http://localhost").searchParams.get("code");
        if (!code) {
          res.writeHead(400).end("No authorization code in request.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Railway is connected to Google. You can close this tab.</h2>");
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
      // localhost (not 127.0.0.1) to match the Desktop client's registered
      // http://localhost redirect; loopback allows any port.
      oauth = makeOAuthClient(`http://localhost:${port}`);
      const authUrl = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
      if (openUrl) openUrl(authUrl);
      else console.log("\nOpen this URL to authorize Railway → Google:\n\n" + authUrl + "\n");
    });
  });
}

module.exports = {
  SCOPES,
  CRED_PATH,
  TOKEN_PATH,
  isConfigured,
  isAuthorized,
  getAuthorizedClient,
  runConsentFlow,
};
