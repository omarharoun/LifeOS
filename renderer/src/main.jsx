/**
 * Railway — renderer entry (M1+)
 * ------------------------------------------------------------------
 * Mounts the demo App from SurfaceRenderer.jsx into the launcher window
 * WITHOUT modifying that file (the plan says wrap, don't replace). This
 * thin shell adds the launcher-window behaviors the standalone demo
 * doesn't know about:
 *   - focus the input bar whenever the window is summoned (railway.onShown)
 *   - Esc dismisses the window (railway.hide)
 * Everything else — the input bar, the three primitives, mock surfaces —
 * comes straight from SurfaceRenderer.jsx.
 * ------------------------------------------------------------------
 */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "../../SurfaceRenderer.jsx";

function LauncherShell() {
  useEffect(() => {
    const focusBar = () => {
      const el = document.querySelector(".bar-input");
      if (el) el.focus();
    };
    focusBar();
    // main process pings us each time the hotkey summons the window
    window.railway?.onShown?.(focusBar);

    const onKey = (e) => {
      if (e.key === "Escape") window.railway?.hide?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <App />;
}

createRoot(document.getElementById("root")).render(<LauncherShell />);
