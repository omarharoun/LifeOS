/**
 * Railway — one-time Gmail consent (M3).  Run: npm run gmail-auth
 * Requires gmail.credentials.json (Desktop-app OAuth client from Google
 * Cloud Console) in the project root. Opens your browser, captures the
 * redirect on a loopback port, and saves gmail.token.json.
 */
const { exec } = require("child_process");
const gmail = require("./gmail");

(async () => {
  if (!gmail.isConfigured()) {
    console.error(
      "Missing gmail.credentials.json.\n" +
        "Create an OAuth 'Desktop app' client in Google Cloud Console, enable the\n" +
        "Gmail API, download the JSON, and save it as gmail.credentials.json here."
    );
    process.exit(1);
  }
  try {
    await gmail.runConsentFlow({
      openUrl: (url) => {
        console.log("Opening your browser to authorize Railway → Gmail…");
        exec(`xdg-open "${url}" || open "${url}"`);
      },
    });
    const email = await gmail.getProfileEmail();
    console.log(`\n✓ Gmail authorized. Connected as ${email}. Token saved.`);
    process.exit(0);
  } catch (e) {
    console.error("Auth failed:", e?.message || e);
    process.exit(1);
  }
})();
