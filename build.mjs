/**
 * Railway — renderer bundler (from M1 on)
 * ------------------------------------------------------------------
 * esbuild bundles the React renderer (which wraps SurfaceRenderer.jsx)
 * into renderer/dist/bundle.js, loaded by renderer/index.html inside the
 * Electron window. Run once with `node build.mjs`, or `node build.mjs --watch`.
 * Kept as a plain script (no config file) to stay legible.
 * ------------------------------------------------------------------
 */
import * as esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: ["renderer/src/main.jsx"],
  bundle: true,
  outfile: "renderer/dist/bundle.js",
  format: "iife",
  platform: "browser",
  target: ["chrome128"], // Electron 33 ships Chromium 128
  jsx: "automatic",
  loader: { ".js": "jsx", ".jsx": "jsx" },
  sourcemap: true,
  logLevel: "info",
});

if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("[build] watching renderer for changes…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("[build] renderer bundle written to renderer/dist/bundle.js");
}
