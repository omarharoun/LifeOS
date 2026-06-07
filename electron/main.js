/**
 * Railway — main process (milestone M0)
 * ------------------------------------------------------------------
 * M0 scope, from MVP_BUILD_PLAN.md:
 *   Goal: an Electron app that opens a small window when you press a
 *   global hotkey (Ctrl+Space), with the text input from the renderer.
 *   Done when: the hotkey shows/hides the window and you can type in it.
 *
 * Nothing here generates or renders Surfaces yet — that's M1+. This file
 * is only the launcher shell: one frameless window, toggled by a global
 * hotkey, that gets out of the way the moment it loses focus.
 * ------------------------------------------------------------------
 */
const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require("electron");
const path = require("path");

// When packaged, the project root is inside a read-only asar — so config,
// tokens, and memory live in the OS userData dir. Set this BEFORE requiring
// modules that read those paths (config/seams/memory via paths.js). In dev
// (unpackaged) we leave it unset → files resolve to the project root.
if (app.isPackaged) process.env.RAILWAY_DATA_DIR = app.getPath("userData");

const { loadConfig } = require("./config");
const { routeRequest } = require("./generate");
const seams = require("./seams");
const { createMemory } = require("./memory");

const memory = createMemory();

// A launcher window needs no GPU. Some Linux/Wayland setups have a flaky
// GPU sandbox that crashes the GPU process fatally ("GPU process isn't
// usable. Goodbye."); software rendering sidesteps that and is plenty here.
app.disableHardwareAcceleration();

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
// True while a do-it action is pending in the renderer — we keep the window
// visible so the catch bar ("show me the draft" / commit) is never hidden.
let hasPending = false;
// Set true only when the user really wants to quit (tray Quit / Cmd-Q), so the
// window's close/blur don't kill a background hotkey app by surprise.
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 640,
    height: 460,
    show: false, // start hidden; the hotkey summons it
    frame: false, // chromeless launcher
    resizable: false,
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#f3efe6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Launcher etiquette: vanish when it loses focus (e.g. you Esc or click away)
  // — UNLESS a do-it action is pending, so its catch bar stays visible until
  // you commit or cancel it (no silent send behind your back).
  win.on("blur", () => {
    if (!hasPending) hideWindow();
  });

  // A background hotkey app: closing the window hides it; only an explicit
  // Quit (which sets `quitting`) actually ends the app.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
}

function showWindow() {
  if (!win) return;
  win.center();
  win.show();
  win.focus();
  // Tell the renderer to focus the input and clear any stale text.
  win.webContents.send("window:shown");
}

function hideWindow() {
  if (win && win.isVisible()) win.hide();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) hideWindow();
  else showWindow();
}

app.whenReady().then(() => {
  createWindow();

  // Renderer asks to dismiss (Esc key).
  ipcMain.on("window:hide", () => hideWindow());

  // Quit affordance (in-window control / Cmd-Q) — the dependable way out when
  // there's no taskbar and the tray may be hidden (GNOME/Wayland).
  ipcMain.on("app:quit", () => {
    quitting = true;
    app.quit();
  });
  installAppMenu();

  // The renderer tells us when a do-it action is pending so we keep the window
  // visible (don't hide on blur) until it's committed or cancelled.
  ipcMain.on("window:pending", (_evt, pending) => {
    hasPending = Boolean(pending);
  });

  // M2/M4: route the request (do-it vs show-me) and, for surfaces, generate +
  // validate. M3: enrich surfaces with real data (e.g. live inbox).
  ipcMain.handle("railway:generate", async (_evt, request) => {
    const cfg = loadConfig();
    try {
      // M5: feed relevant recent history into the prompt for better routing/
      // pre-fill — unless the user opted out of sharing history with the model.
      const history = cfg.sendHistory ? memory.relevant(request) : [];
      const res = await routeRequest(request, {
        apiKey: cfg.apiKey,
        model: cfg.model,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        history,
        // #2: the semantic gate — surfaces may only reference invokable actions.
        capabilities: seams.KNOWN_CAPABILITIES,
      });
      if (res.ok && res.mode === "surface")
        res.data = await seams.enrichSurfaceData(res.surface, res.data);
      return res;
    } catch (e) {
      return { ok: false, error: `generation failed: ${e?.message || e}` };
    }
  });

  // M5: log a completed task (request, route, edits, time-to-done) for memory.
  ipcMain.handle("railway:remember", async (_evt, record) => {
    try {
      const saved = memory.append({ ...record, ts: Date.now() });
      const s = memory.stats();
      console.log(
        `[railway] remembered "${record.request}" (${record.mode}, ${record.edits ?? 0} edits, ` +
          `${record.timeToDoneMs ?? "?"}ms). median time-to-done: ${s.medianTimeToDoneMs ?? "n/a"}ms over ${s.count}.`
      );
      return { ok: true, id: saved.id };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("railway:memoryStats", async () => memory.stats());

  // M3 DATA seam: resolve a query source (e.g. "inbox") to real rows.
  ipcMain.handle("railway:resolveQuery", async (_evt, source) => {
    try {
      return { ok: true, items: await seams.resolveQuery(source) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // M3 ACTIONS seam: run a named capability (e.g. "email.send") for real.
  ipcMain.handle("railway:invoke", async (_evt, name, args) => {
    try {
      return await seams.invokeCapability(name, args);
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("railway:gmailStatus", async () => seams.status());

  const cfg = loadConfig();
  console.log(
    cfg.hasKey
      ? `[railway] AI generation enabled (${cfg.provider}, model: ${cfg.model}).`
      : `[railway] No API key — using built-in keyword router (see railway.config.example.json).`
  );
  seams.status().then((s) => {
    console.log(
      s.authorized
        ? `[railway] Google connected as ${s.email || "(unknown)"} — real Gmail + Calendar.`
        : s.configured
          ? `[railway] Google credentials found but not authorized — run \`npm run gmail-auth\`.`
          : `[railway] Google not configured — using mock data + simulated actions (see README).`
    );
  });

  // #3: configurable global hotkey (default Ctrl+Space collides with IME on
  // some Linux setups — override with RAILWAY_HOTKEY or config.hotkey).
  const registered = globalShortcut.register(cfg.hotkey, toggleWindow);
  if (!registered) {
    console.error(
      `[railway] Failed to register global hotkey "${cfg.hotkey}". It may be claimed ` +
        `by the OS or another app — set a different one via RAILWAY_HOTKEY or railway.config.json.`
    );
  } else {
    console.log(`[railway] Ready. Press ${cfg.hotkey} to summon the launcher.`);
  }

  setupTray(cfg.hotkey);

  // Show once on first launch so it's obvious the app is alive.
  showWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// #3: a tray icon is the only always-available affordance for a frameless,
// taskbar-skipped background app — without it, a non-developer can't get the
// window back or quit. Click toggles; the menu shows/quits.
// An application menu gives a working Cmd/Ctrl+Q (and Ctrl+W → hide) whenever
// the window is focused — a reliable quit even where the tray isn't shown.
function installAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Railway",
      submenu: [
        { label: "Hide", accelerator: "Escape", click: () => hideWindow() },
        { type: "separator" },
        {
          label: "Quit Railway",
          accelerator: "CommandOrControl+Q",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function setupTray(hotkey) {
  try {
    const iconPath = path.join(__dirname, "..", "build", "icon.png");
    let image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 });
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip("Railway — a surface only when you need one");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Show (${hotkey})`, click: () => showWindow() },
        { type: "separator" },
        {
          label: "Quit Railway",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on("click", () => toggleWindow());
  } catch (e) {
    // No system tray (some Linux desktops) — not fatal; hotkey still works.
    console.warn(`[railway] Tray unavailable: ${e?.message || e}`);
  }
}

// Keep the app alive in the tray-less background even with no windows shown:
// the whole point is that the hotkey can summon it later. So we do NOT quit
// on window-all-closed (the window is hidden, not closed, in normal use).
app.on("window-all-closed", () => {
  // no-op on purpose; quit explicitly via Cmd/Ctrl+Q or the menu.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
