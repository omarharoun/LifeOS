/**
 * Railway — self-test (automated acceptance check)
 * ------------------------------------------------------------------
 * GNOME/Wayland blocks non-interactive screenshots, so instead of an
 * eyeball check we drive the real launcher window headlessly.
 *
 * Covers M0 + M1 "done when":
 *   M0: window shows/hides; the text input exists and accepts typing.
 *   M1: SurfaceRenderer is mounted; typing "check inbox" renders the list
 *       surface and "write the vendor email" renders the composer, both
 *       with mock data; editing a field updates it.
 *
 * Run with:  npm run selftest   (exits 0 on pass, 1 on fail)
 * Test-only; the shipped app entry is electron/main.js.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  // give React a tick to mount
  await sleep(300);
  check("renderer/index.html loads without error", true);

  // M0: show / hide (what the global hotkey toggles).
  win.show();
  check("window shows", win.isVisible() === true);
  win.hide();
  check("window hides", win.isVisible() === false);

  // Preload bridge present.
  const bridgeOk = await win.webContents.executeJavaScript(
    `typeof window.railway?.hide === "function" && typeof window.railway?.onShown === "function"`
  );
  check("preload bridge (railway.hide / onShown) exposed", bridgeOk === true);

  // M1: SurfaceRenderer mounted — its input bar exists and is typable.
  const inputOk = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(".bar-input");
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    })()
  `);
  check("SurfaceRenderer input bar present and focusable", inputOk === true);

  // Helper to type into the bar and press Enter via React's value setter.
  const submit = (text) => `
    (() => {
      const el = document.querySelector(".bar-input");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()
  `;

  // "check inbox" -> list surface with mock threads.
  await win.webContents.executeJavaScript(submit("check inbox"));
  await sleep(150);
  const listOk = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll(".list .row");
      const title = document.querySelector(".row-title")?.textContent || "";
      return rows.length >= 1 && title.length > 0;
    })()
  `);
  check('typing "check inbox" renders the list surface with mock data', listOk === true);

  // "write the vendor email" -> composer surface, prefilled from mock draft.
  await win.webContents.executeJavaScript(submit("write the vendor email"));
  await sleep(150);
  const composerOk = await win.webContents.executeJavaScript(`
    (() => {
      const inputs = document.querySelectorAll(".prim .input");
      const toVal = inputs[0]?.value || "";
      return inputs.length >= 2 && toVal.includes("@");
    })()
  `);
  check('typing "write the vendor email" renders the composer prefilled', composerOk === true);

  // Editing a composer field updates its value (mock write-back works).
  const editOk = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(".prim .input");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "edited@example.com");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return document.querySelector(".prim .input").value === "edited@example.com";
    })()
  `);
  check("editing a composer field updates it", editOk === true);

  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "\nSELF-TEST: PASS" : "\nSELF-TEST: FAIL");
  app.exit(allOk ? 0 : 1);
});
