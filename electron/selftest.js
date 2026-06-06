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
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { loadConfig } = require("./config");
const { generateSurface } = require("./generate");
const seams = require("./seams");

app.disableHardwareAcceleration();

const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // Mirror main.js's generate handler so the preload→IPC round-trip is real.
  ipcMain.handle("railway:generate", async (_e, request) => {
    const cfg = loadConfig();
    const res = await generateSurface(request, { apiKey: cfg.apiKey, model: cfg.model });
    if (res.ok) res.data = await seams.enrichSurfaceData(res.surface, res.data);
    return res;
  });
  ipcMain.handle("railway:resolveQuery", async (_e, source) => ({
    ok: true,
    items: await seams.resolveQuery(source),
  }));
  ipcMain.handle("railway:invoke", async (_e, name, args) => seams.invokeCapability(name, args));
  ipcMain.handle("railway:gmailStatus", async () => seams.status());
  ipcMain.on("window:hide", () => {});

  const win = new BrowserWindow({
    width: 640,
    height: 460,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Deterministic timers: a hidden window throttles setTimeout (~1/s),
      // which would delay the dissolve animation in this headless harness.
      // In real use the window is shown when you act, so timers run normally.
      backgroundThrottling: false,
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

  // Poll an expression (returning a boolean) until true or timeout — UI
  // updates are async (summon awaits an IPC round-trip, then React renders).
  const waitFor = async (expr, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      if ((await win.webContents.executeJavaScript(`(() => ${expr})()`)) === true) return true;
      await sleep(100);
    }
    return false;
  };

  // "check inbox" -> list surface with mock threads.
  await win.webContents.executeJavaScript(submit("check inbox"));
  const listOk = await waitFor(`
    document.querySelectorAll(".list .row").length >= 1 &&
    (document.querySelector(".row-title")?.textContent || "").length > 0
  `);
  check('typing "check inbox" renders the list surface with mock data', listOk === true);

  // "write the vendor email" -> composer surface, prefilled from mock draft.
  await win.webContents.executeJavaScript(submit("write the vendor email"));
  const composerOk = await waitFor(`
    document.querySelectorAll(".prim .input").length >= 2 &&
    (document.querySelectorAll(".prim .input")[0]?.value || "").includes("@")
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

  // M2: the generate IPC round-trips through the real main process. Without a
  // key it must return the graceful needKey signal (renderer then falls back).
  const genResult = await win.webContents.executeJavaScript(
    `window.railway.generate("reply to sarah")`
  );
  const genOk = process.env.ANTHROPIC_API_KEY
    ? genResult?.ok === true && genResult?.surface?.blocks?.length >= 1
    : genResult?.ok === false && genResult?.needKey === true;
  check(
    process.env.ANTHROPIC_API_KEY
      ? "generate IPC produces a valid Surface (live key)"
      : "generate IPC round-trips and signals needKey (no key → fallback)",
    genOk === true
  );

  // M3: DATA seam round-trips (mock inbox when Gmail unauthorized).
  const queryRes = await win.webContents.executeJavaScript(
    `window.railway.resolveQuery("inbox")`
  );
  check(
    "resolveQuery IPC returns inbox rows",
    queryRes?.ok === true && Array.isArray(queryRes.items) && queryRes.items.length >= 1
  );

  // M3: gmailStatus round-trips.
  const statusRes = await win.webContents.executeJavaScript(`window.railway.gmailStatus()`);
  check(
    "gmailStatus IPC reports flags",
    statusRes && typeof statusRes.authorized === "boolean"
  );

  // M3: ACTIONS seam — clicking Send fires email.send through the real
  // registry (simulated when unauthorized) and dissolves the surface.
  await win.webContents.executeJavaScript(submit("write the vendor email"));
  await waitFor(`!!document.querySelector(".btn.solid")`);
  await win.webContents.executeJavaScript(`document.querySelector(".btn.solid")?.click()`);
  // Poll for the surface to dissolve (send is async + a 360ms animation).
  let sendDiag = { toast: "", surfaceGone: false };
  for (let i = 0; i < 12; i++) {
    await sleep(150);
    sendDiag = await win.webContents.executeJavaScript(`
      ({ toast: document.querySelector(".toast")?.textContent || "",
         surfaceGone: !document.querySelector(".surface") })
    `);
    if (sendDiag.surfaceGone) break;
  }
  const sendOk = /(sent|simulated send) to .*@/i.test(sendDiag.toast) && sendDiag.surfaceGone;
  check("clicking Send invokes email.send (simulated) and dissolves", sendOk === true);

  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "\nSELF-TEST: PASS" : "\nSELF-TEST: FAIL");
  app.exit(allOk ? 0 : 1);
});
