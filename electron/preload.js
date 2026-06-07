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
  // #1: tell main a do-it is pending so it keeps the window visible.
  setPending: (pending) => ipcRenderer.send("window:pending", pending),
  // Quit affordance for a frameless, taskbar-skipped app (tray may be hidden).
  quit: () => ipcRenderer.send("app:quit"),
  // M2: ask the main process to generate a validated Surface for a request.
  // Returns { ok, surface, data, intent } or { ok:false, error, needKey? }.
  generate: (request) => ipcRenderer.invoke("railway:generate", request),
  // M3: the two real seams.
  resolveQuery: (source) => ipcRenderer.invoke("railway:resolveQuery", source),
  invoke: (capability, args) => ipcRenderer.invoke("railway:invoke", capability, args),
  gmailStatus: () => ipcRenderer.invoke("railway:gmailStatus"),
  // M5: log a completed task; read aggregate stats (time-to-done).
  remember: (record) => ipcRenderer.invoke("railway:remember", record),
  memoryStats: () => ipcRenderer.invoke("railway:memoryStats"),
});
