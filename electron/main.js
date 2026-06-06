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
const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("path");

// A launcher window needs no GPU. Some Linux/Wayland setups have a flaky
// GPU sandbox that crashes the GPU process fatally ("GPU process isn't
// usable. Goodbye."); software rendering sidesteps that and is plenty here.
app.disableHardwareAcceleration();

const HOTKEY = "CommandOrControl+Space";

/** @type {BrowserWindow | null} */
let win = null;

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

  // Launcher etiquette: vanish when it loses focus (e.g. you Esc or click away).
  win.on("blur", () => hideWindow());
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

  const registered = globalShortcut.register(HOTKEY, toggleWindow);
  if (!registered) {
    // Don't die silently — if the OS won't give us the hotkey, say so.
    console.error(
      `[railway] Failed to register global hotkey "${HOTKEY}". ` +
        `It may be claimed by the OS or another app.`
    );
  } else {
    console.log(`[railway] Ready. Press ${HOTKEY} to summon the launcher.`);
  }

  // Show once on first launch so it's obvious the app is alive.
  showWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Keep the app alive in the tray-less background even with no windows shown:
// the whole point is that the hotkey can summon it later. So we do NOT quit
// on window-all-closed (the window is hidden, not closed, in normal use).
app.on("window-all-closed", () => {
  // no-op on purpose; quit explicitly via Cmd/Ctrl+Q or the menu.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
