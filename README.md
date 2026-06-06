# Railway

A personal launcher: press a hotkey, say what you need, and it either just does
it or pops up a small, purpose-built screen to do it. Built milestone by
milestone per [`MVP_BUILD_PLAN.md`](./MVP_BUILD_PLAN.md).

The core idea is one seam (`surface-contract.ts`): the model emits a typed UI
tree ("Surface") built from three primitives — **composer**, **list**,
**confirm** — where data is referenced by binding and actions are referenced by
name. The renderer (`SurfaceRenderer.jsx`) draws it; the main process resolves
the data and runs the actions.

## Run it

```bash
npm install
npm start            # builds the renderer + contract, launches Electron
```

Press **Ctrl+Space** to summon/dismiss the launcher. Type a request and hit
Enter. **Esc** dismisses.

The app runs with zero configuration — it falls back to a keyword router and
mock data. Add keys to make it real (below).

## Make it real

### AI generation (M2) — optional
Generation uses the Anthropic API (a **separate** key from any Claude Code
subscription). Provide it any one way:

- `ANTHROPIC_API_KEY=...` in the environment or a `.env` file, or
- copy `railway.config.example.json` → `railway.config.json` and fill it in.

Optionally set `RAILWAY_MODEL` (default `claude-sonnet-4-6`). Without a key, the
built-in keyword router is used instead.

### Gmail (M3) — optional
Real inbox + real send via Google OAuth:

1. In Google Cloud Console: create a project, enable the **Gmail API**, and
   create an OAuth **Desktop app** client.
2. Download the client JSON, save it as `gmail.credentials.json` in this folder.
3. Run the one-time consent:
   ```bash
   npm run gmail-auth
   ```
   This opens your browser, captures the loopback redirect, and writes
   `gmail.token.json`.

Without credentials, "check inbox" shows mock threads and sending is simulated.
All secret files (`railway.config.json`, `gmail.credentials.json`,
`gmail.token.json`, `.env`) are gitignored.

## Develop

```bash
npm run watch        # rebuild renderer + contract on change
npm test             # headless unit tests (generation repair loop, Gmail seams)
npm run selftest     # drives the real Electron window and asserts behavior
```

## Layout

```
surface-contract.ts     the contract: primitives, bindings, zod validator (single source of truth)
SurfaceRenderer.jsx     the renderer: draws surfaces, the input bar, the three primitives
electron/
  main.js               window + global hotkey + IPC wiring
  preload.js            the renderer↔main bridge (generate / resolveQuery / invoke)
  generate.js           M2: Anthropic call, forced tool output, validate→repair loop
  config.js             API key / model resolution
  gmail.js              M3: OAuth + inbox listing + RFC822 send
  seams.js              M3: DataContext (resolveQuery) + CapabilityRegistry (invoke)
  selftest.js           automated acceptance check (run via npm run selftest)
build.mjs               esbuild: renderer bundle + contract → Node ESM
test/                   headless unit tests
```
