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
// Hermetic: never touch the real Gmail account or send a live email, even if
// credentials/token exist. resolveQuery → mock inbox, email.send → simulated.
process.env.RAILWAY_NO_GMAIL = "1";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const seams = require("./seams");
const { createMemory } = require("./memory");
const os = require("os");

// Use a throwaway memory file so the test doesn't touch the real log.
const testMemory = createMemory(path.join(os.tmpdir(), `railway-selftest-mem-${process.pid}.json`));

app.disableHardwareAcceleration();

const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // Mirror main.js's generate handler so the preload→IPC round-trip is real.
  // The selftest runs hermetically (no network) for deterministic results:
  // script a do-it route for a known phrase, and signal needKey otherwise so
  // the renderer falls back to its keyword router. Live generation is covered
  // separately by `npm run live`.
  ipcMain.handle("railway:generate", async (_e, request) => {
    if (/tell sarah/i.test(request)) {
      return {
        ok: true,
        mode: "do",
        capability: "email.send",
        args: { to: "sarah@example.com", subject: "Running late", body: "10 minutes behind." },
        summary: "Tell Sarah you're running late",
        intent: "Tell Sarah you're running late",
      };
    }
    return { ok: false, needKey: true, error: "selftest is hermetic (no live API)" };
  });
  ipcMain.handle("railway:resolveQuery", async (_e, source) => ({
    ok: true,
    items: await seams.resolveQuery(source),
  }));
  ipcMain.handle("railway:invoke", async (_e, name, args) => seams.invokeCapability(name, args));
  ipcMain.handle("railway:gmailStatus", async () => seams.status());
  ipcMain.handle("railway:remember", async (_e, record) => {
    testMemory.append({ ...record, ts: Date.now() });
    return { ok: true };
  });
  ipcMain.handle("railway:memoryStats", async () => testMemory.stats());
  ipcMain.on("window:hide", () => {});

  ipcMain.on("window:pending", () => {});

  const win = new BrowserWindow({
    width: 640,
    height: 600,
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

  // Step 3: at rest the dashboard shows the ambient inbox + agenda glance
  // (two columns, real rows) and no surface — never blank.
  const dashOk = await waitFor(`
    !!document.querySelector(".ambient") &&
    document.querySelectorAll(".ambient .amb-col").length === 2 &&
    document.querySelectorAll(".ambient .amb-row").length >= 2 &&
    !document.querySelector(".surface")
  `);
  check("resting dashboard shows ambient inbox + agenda glance (never blank)", dashOk === true);

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

  // M2: the generate IPC round-trips through the real main process and signals
  // needKey here (hermetic), so the renderer falls back to its keyword router.
  const genResult = await win.webContents.executeJavaScript(
    `window.railway.generate("reply to sarah")`
  );
  check(
    "generate IPC round-trips and signals needKey (hermetic → fallback)",
    genResult?.ok === false && genResult?.needKey === true
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

  // Step 3: after the action dissolves, we land back on the dashboard, not blank.
  const backToDash = await waitFor(`
    !document.querySelector(".surface") && !!document.querySelector(".ambient .amb-row")
  `);
  check("dissolving an action returns to the dashboard (never blank)", backToDash === true);

  // M4: "tell Sarah I'm running late" routes to do-it → shows the catchable
  // pending bar, no surface.
  await win.webContents.executeJavaScript(submit("tell Sarah I'm running late"));
  const pendingShown = await waitFor(
    `!!document.querySelector(".pending") && !document.querySelector(".surface")`
  );
  check("do-it route shows the catchable confirm bar (no screen)", pendingShown === true);

  // #1: an irreversible action (email.send) must NOT auto-fire on a timer —
  // it should still be pending with no send after a wait, until an explicit tap.
  await sleep(1200);
  const stillPending = await win.webContents.executeJavaScript(`
    (() => ({
      pending: !!document.querySelector(".pending"),
      noDrainBar: !document.querySelector(".pending-bar"),
      // this action ("running late") must NOT have fired (its commit toast says so)
      notFired: !/running late/i.test(document.querySelector(".toast")?.textContent || ""),
    }))()
  `);
  check(
    "#1 irreversible do-it does NOT auto-send (no timer; awaits explicit tap)",
    stillPending.pending && stillPending.noDrainBar && stillPending.notFired
  );

  // M4: the one-tap fix — "no, show me the draft" opens an editable composer.
  await win.webContents.executeJavaScript(`document.querySelector(".pending .btn.ghost")?.click()`);
  const draftShown = await waitFor(`
    !document.querySelector(".pending") &&
    document.querySelectorAll(".prim .input").length >= 2 &&
    (document.querySelectorAll(".prim .input")[0]?.value || "").includes("sarah@")
  `);
  check('"show me the draft" turns the do-it into an editable composer', draftShown === true);

  // M4: an explicit tap commits the action through the registry.
  await win.webContents.executeJavaScript(submit("tell Sarah I'm running late"));
  await waitFor(`!!document.querySelector(".pending .btn.solid")`);
  await win.webContents.executeJavaScript(`document.querySelector(".pending .btn.solid")?.click()`);
  const committed = await waitFor(`
    !document.querySelector(".pending") &&
    /running late/i.test(document.querySelector(".toast")?.textContent || "")
  `);
  check("explicit tap commits the do-it action (simulated send)", committed === true);

  // M5: completed tasks are logged to memory (time-to-done recorded).
  const stats = await win.webContents.executeJavaScript(`window.railway.memoryStats()`);
  check(
    "completed tasks are remembered (memory log + time-to-done)",
    stats && stats.count >= 1 && typeof stats.medianTimeToDoneMs === "number"
  );

  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "\nSELF-TEST: PASS" : "\nSELF-TEST: FAIL");
  app.exit(allOk ? 0 : 1);
});
