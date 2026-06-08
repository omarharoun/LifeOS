/**
 * Railway — screenshot harness.  Run: npm run screenshots
 * ------------------------------------------------------------------
 * Captures the real renderer window in several states via
 * webContents.capturePage() (works where OS screenshots are blocked, e.g.
 * GNOME/Wayland). Hermetic: RAILWAY_NO_GMAIL forces mock data and a scripted
 * router, so the images are deterministic and contain nothing personal.
 * Output: screenshots/*.png
 * ------------------------------------------------------------------
 */
process.env.RAILWAY_NO_GMAIL = "1";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const seams = require("./seams");

app.disableHardwareAcceleration();

const OUT = path.join(__dirname, "..", "screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // Scripted, hermetic handlers (mock data; no network, no real sends).
  ipcMain.handle("railway:generate", async (_e, request) => {
    if (/tell sarah/i.test(request))
      return {
        ok: true, mode: "do", capability: "email.send",
        args: { to: "sarah@example.com", subject: "Running late", body: "About 10 minutes behind — start without me." },
        summary: "Tell Sarah you're running late", intent: "Tell Sarah you're running late",
      };
    if (/lunch|calendar|coffee|event|add /i.test(request))
      return {
        ok: true, mode: "do", capability: "calendar.createEvent",
        args: { summary: "Lunch with Sam", start: "2026-06-08 12:30", location: "Cafe Luce" },
        summary: "Add lunch with Sam", intent: "Add lunch with Sam",
      };
    return { ok: false, needKey: true };
  });
  ipcMain.handle("railway:resolveQuery", async (_e, s) => ({ ok: true, items: await seams.resolveQuery(s) }));
  ipcMain.handle("railway:invoke", async (_e, n, a) => seams.invokeCapability(n, a));
  ipcMain.handle("railway:gmailStatus", async () => seams.status());
  ipcMain.handle("railway:remember", async () => ({ ok: true }));
  ipcMain.handle("railway:memoryStats", async () => ({ count: 0 }));
  ipcMain.on("window:hide", () => {});
  ipcMain.on("window:pending", () => {});

  const win = new BrowserWindow({
    width: 640,
    height: 600,
    show: true,
    frame: false,
    backgroundColor: "#f3efe6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  await sleep(700); // fonts + first paint

  fs.mkdirSync(OUT, { recursive: true });

  const submit = (t) => `(() => {
    const el = document.querySelector(".bar-input");
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(t)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  })()`;
  const waitFor = async (expr, n = 25) => {
    for (let i = 0; i < n; i++) {
      if ((await win.webContents.executeJavaScript(`(() => ${expr})()`)) === true) return true;
      await sleep(120);
    }
    return false;
  };
  const shot = async (name) => {
    await sleep(450); // let entry animations settle
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log("  ✓ " + name);
  };

  console.log("Capturing screenshots:");

  // 1) Resting dashboard — ambient inbox + agenda glance (Step 3)
  await waitFor(`!!document.querySelector(".ambient .amb-row")`);
  await win.webContents.executeJavaScript(`document.querySelector(".bar-input")?.focus()`);
  await shot("01-dashboard.png");

  // 2) Composer (email draft) — shows the "Send" confirm label
  await win.webContents.executeJavaScript(submit("write the vendor email"));
  await waitFor(`document.querySelectorAll(".prim .input").length >= 2`);
  await shot("02-composer.png");

  // 3) Inbox list (mock threads)
  await win.webContents.executeJavaScript(submit("check inbox"));
  await waitFor(`document.querySelectorAll(".list .row").length >= 1`);
  await shot("03-inbox.png");

  // 4) Do-it confirm bar — irreversible action awaits an explicit tap (#1)
  await win.webContents.executeJavaScript(submit("tell Sarah I'm running late"));
  await waitFor(`!!document.querySelector(".pending")`);
  await shot("04-do-it-confirm.png");

  // 5) Calendar review composer — "show me the draft" + the "Add" label (#5)
  await win.webContents.executeJavaScript(submit("add lunch with Sam tomorrow at noon"));
  await waitFor(`!!document.querySelector(".pending .btn.ghost")`);
  await win.webContents.executeJavaScript(`document.querySelector(".pending .btn.ghost").click()`);
  await waitFor(`document.querySelectorAll(".prim .input").length >= 2`);
  await shot("05-calendar-review.png");

  console.log(`\nWrote screenshots to ${OUT}`);
  app.exit(0);
});
