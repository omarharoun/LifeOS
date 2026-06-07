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

Press **Ctrl+Space** to summon/dismiss the launcher (configurable — see below),
or use the **tray icon** (Show / Quit). Type a request and hit Enter. **Esc**
dismisses.

Silent "do-it" actions that are irreversible (sending an email, creating an
event) never fire on their own — they show a confirm bar and wait for an
explicit tap, and the window stays open while one is pending. One tap on
"show me the draft" turns it into an editable screen instead.

The app runs with zero configuration — it falls back to a keyword router and
mock data. Add keys to make it real (below).

### Settings (optional)
In `railway.config.json`, env, or `.env`:
- `RAILWAY_HOTKEY` / `"hotkey"` — global hotkey (Electron accelerator syntax;
  default `CommandOrControl+Space`). Change it if Ctrl+Space collides with your
  input-method switcher on Linux.
- `RAILWAY_NO_HISTORY=1` / `"sendHistory": false` — keep your recent request
  history local instead of sending it to the model for better pre-fill.

What it does: routes each request to either a silent **do-it** (catchable for a
moment, fixable in one tap) or a **show-me** screen built from the contract's
three primitives; sends/reads real email when Gmail is connected; and logs every
task — what you asked, what you picked, edits, and time-to-done — feeding the
relevant recent history back into the prompt so it predicts and pre-fills better
over time. All five MVP milestones (M0–M5) are implemented.

## Make it real

### AI generation (M2) — optional
Generation works with **OpenRouter** or the **Anthropic API** (a key separate
from any Claude Code subscription). The provider is inferred from the key
prefix: `sk-or-...` → OpenRouter, `sk-ant-...` → Anthropic. Provide a key any
one way:

- `OPENROUTER_API_KEY=...` / `ANTHROPIC_API_KEY=...` in the environment or a
  `.env` file, or
- copy `railway.config.example.json` → `railway.config.json` and fill it in.

Default model is `anthropic/claude-sonnet-4.5` (OpenRouter) or
`claude-sonnet-4-6` (Anthropic); override with `RAILWAY_MODEL`. Verify a live
key with `npm run live`. Without a key, the built-in keyword router is used.

**Fully local (no key, nothing leaves the machine):** run an OpenAI-compatible
server — [Ollama](https://ollama.com) (`ollama serve`, default
`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`) — and set:

```json
{ "provider": "local", "baseUrl": "http://localhost:11434/v1", "model": "llama3.1" }
```

or `RAILWAY_PROVIDER=local RAILWAY_BASE_URL=… RAILWAY_MODEL=…`. Pick a model that
supports tool/function calling (generation forces a tool call). This is the
privacy-maximal option — combine with `sendHistory:false` to keep everything on
your machine.

### Google: Gmail + Calendar — optional
Real inbox + send, and real agenda + event creation, via one Google OAuth
(shared `electron/google-auth.js` — adding Calendar was just its two seam pieces
in `electron/calendar.js` + `electron/seams.js`, nothing else changed).

1. In Google Cloud Console: create a project, enable the **Gmail API**, and
   create an OAuth **Desktop app** client.
2. Download the client JSON, save it as `gmail.credentials.json` in this folder.
3. Run the one-time consent:
   ```bash
   npm run gmail-auth
   ```
   This opens your browser, captures the loopback redirect, and writes
   `gmail.token.json`.

This grants Gmail **and** Calendar scopes. If you previously authorized for
Gmail only, re-run `npm run gmail-auth` to add Calendar. Then "what's on my
calendar" lists real events and "add coffee with Alex tomorrow at 10am" creates
a real event.

Without credentials, "check inbox" / "my agenda" show mock data and
send/create are simulated. All secret files (`railway.config.json`,
`gmail.credentials.json`, `gmail.token.json`, `.env`) are gitignored.

## Package as an installable app

```bash
npm run dist        # builds AppImage + the unpacked app under release/
```

Outputs to `release/`:
- **`Railway-<version>.AppImage`** — standard portable Linux app. Needs FUSE 2 at
  runtime; on Fedora: `sudo dnf install fuse fuse-libs`. Then `chmod +x` and run it.
- **`release/linux-unpacked/`** — the unpacked app (`./railway`), runs without FUSE.

When packaged, Railway reads/writes its config, token, and memory in the OS
**userData** dir (`~/.config/Railway` on Linux), not the project folder — so put
`railway.config.json` and `gmail.credentials.json` there for a packaged install.
In dev (`npm start`) it uses the project folder as before.

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
  google-auth.js        shared Google OAuth (Gmail + Calendar)
  gmail.js              M3: inbox listing + RFC822 send
  calendar.js           2nd app: agenda listing + event creation
  seams.js              DataContext (resolveQuery) + CapabilityRegistry (invoke) — the per-app seam
  memory.js             M5: local task log + relevance + time-to-done stats
  paths.js              where config/token/memory live (project root, or userData when packaged)
  selftest.js           automated acceptance check (run via npm run selftest)
build/icon.png          app icon used when packaging
build.mjs               esbuild: renderer bundle + contract → Node ESM
test/                   headless unit tests
```
