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

// 1) Renderer: React + SurfaceRenderer.jsx → a browser bundle for the window.
const rendererOpts = {
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
};

// 2) Contract: surface-contract.ts (TS + zod) → a Node ESM module the main
//    process dynamically imports for validation. ESM so import.meta stays
//    native; zod is bundled in.
const contractOpts = {
  entryPoints: ["surface-contract.ts"],
  bundle: true,
  outfile: "electron/gen/contract.mjs",
  format: "esm",
  platform: "node",
  target: ["node22"],
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const rCtx = await esbuild.context(rendererOpts);
  const cCtx = await esbuild.context(contractOpts);
  await Promise.all([rCtx.watch(), cCtx.watch()]);
  console.log("[build] watching renderer + contract for changes…");
} else {
  await Promise.all([esbuild.build(rendererOpts), esbuild.build(contractOpts)]);
  console.log(
    "[build] wrote renderer/dist/bundle.js and electron/gen/contract.mjs"
  );
}
