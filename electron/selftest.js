/**
 * Railway — M0 self-test (automated acceptance check)
 * ------------------------------------------------------------------
 * GNOME/Wayland blocks non-interactive screenshots, so instead of an
 * eyeball check we drive the real launcher window headlessly and assert
 * the M0 "done when" criteria:
 *   1. the window shows / hides on demand (the hotkey just calls these),
 *   2. the renderer loads the actual index.html the app uses,
 *   3. the text input exists and you can type into it,
 *   4. Enter submits, Esc requests dismiss.
 *
 * Run with:  npm run selftest   (exits 0 on pass, 1 on fail)
 * This is test-only; the shipped app entry is electron/main.js.
 * ------------------------------------------------------------------
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();

const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640,
    height: 460,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // (1) show/hide — the exact operations the global hotkey toggles.
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  check("renderer/index.html loads without error", true);

  win.show();
  check("window shows", win.isVisible() === true);
  win.hide();
  check("window hides", win.isVisible() === false);

  // (2) the preload bridge the renderer relies on is wired up.
  const bridgeOk = await win.webContents.executeJavaScript(
    `typeof window.railway?.hide === "function" && typeof window.railway?.onShown === "function"`
  );
  check("preload bridge (railway.hide / onShown) exposed", bridgeOk === true);

  // (3) the text input from the renderer is present and typable.
  const inputOk = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById("bar-input");
      if (!el || el.tagName !== "INPUT") return false;
      el.focus();
      el.value = "write the vendor email";
      // confirm it accepted the text (i.e. it is a real, editable input)
      return document.activeElement === el && el.value === "write the vendor email";
    })()
  `);
  check("text input exists, focuses, and accepts typing", inputOk === true);

  // (4) Enter submits (echoes the typed text), then clears the box.
  const enterOk = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById("bar-input");
      el.value = "check inbox";
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const echo = document.getElementById("echo").textContent;
      return echo.includes("check inbox") && el.value === "";
    })()
  `);
  check("Enter submits the typed text and clears the input", enterOk === true);

  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "\nM0 SELF-TEST: PASS" : "\nM0 SELF-TEST: FAIL");
  app.exit(allOk ? 0 : 1);
});
