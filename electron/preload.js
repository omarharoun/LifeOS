/**
 * Railway — preload (milestone M0)
 * ------------------------------------------------------------------
 * The only bridge between the launcher window and the main process.
 * For M0 we expose two things:
 *   - onShown(cb): main tells us the window was just summoned, so the
 *     renderer can focus + clear the input.
 *   - hide(): let the renderer dismiss the window (Esc key).
 * Kept tiny on purpose; capabilities/data seams come in later milestones.
 * ------------------------------------------------------------------
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("railway", {
  onShown: (cb) => ipcRenderer.on("window:shown", () => cb()),
  hide: () => ipcRenderer.send("window:hide"),
});
