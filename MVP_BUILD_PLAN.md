# Railway — MVP Build Plan

A personal launcher you open with a hotkey, type what you need, and it either
just does it or pops up a small purpose-built screen to do it. It remembers what
you ask and what you choose, and gets better at predicting and pre-filling over time.

**This first version is for *you* to use** (dogfood it before turning it into a
product). That keeps the scope small: one user, one machine, one real integration.

---

## What you already have (the skeleton)

- **`surface-contract.ts`** — the rulebook the AI follows to describe a screen
  (3 building blocks: a text editor, a list, a confirm step). Includes a validator.
- **`SurfaceRenderer.jsx`** — a working demo that draws those screens and does
  *pretend* actions. This is your UI starting point.

Everything below grows these two files into a real app. Don't replace them — wrap them.

---

## Tech stack (kept deliberately simple)

- **App shell:** Electron (easiest path to a desktop window + global hotkey).
  *Lighter alternative if you care about size: Tauri.*
- **UI:** React — reuse `SurfaceRenderer.jsx` as-is.
- **Brains:** Anthropic API (Claude), forced to output a valid Surface using the
  contract's schema. (This needs its **own API key** — separate from the Claude
  Code subscription you use to build it.)
- **Real action:** Gmail API (read inbox + send), connected via Google OAuth.
- **Memory:** a local SQLite file (or even a JSON file to start) of past requests
  and choices, fed back into the prompt.
- **Safety gate:** the zod validator already in `surface-contract.ts`.

---

## Build order (do these in sequence — don't skip ahead)

### M0 — It opens
**Goal:** an Electron app that opens a small window when you press a global hotkey
(e.g. Ctrl+Space), with the text input from the renderer in it.
**Done when:** hotkey shows/hides the window and you can type in the box.

### M1 — It draws screens (still fake)
**Goal:** drop `SurfaceRenderer.jsx` into the window. Hardcoded example surfaces
render; editing fields and clicking buttons works with mock data.
**Done when:** typing "write the vendor email" shows the composer; "check inbox"
shows the list — exactly like the demo, now inside the real app.

### M2 — The AI generates the screens
**Goal:** replace the hardcoded examples. When you type a request, call the Anthropic
API, force it to return a Surface that matches the contract, run it through the
validator, then render it. If invalid, send the errors back and ask it to fix
(the repair loop).
**Done when:** a request you've never hardcoded produces a valid, sensible screen.

### M3 — One real connection (email)
**Goal:** wire Gmail. "Read inbox" pulls real threads into the list. The email
composer pre-fills from a real draft. **Send actually sends.**
**Done when:** you send a real email from the launcher and it lands.
*(This is the milestone that proves the whole thing is real, not a demo.)*

### M4 — The router (do-it vs. show-me)
**Goal:** before generating a screen, decide: should the AI just do this silently,
or does the user want a screen to do it themselves? Make wrong guesses fixable in
one tap ("no — show me the draft").
**Done when:** "tell Sarah I'm running late" sends with no screen; "draft the
tricky email" opens the composer.

### M5 — Memory
**Goal:** log every request + what you picked + edits you made. Feed the relevant
recent history into the prompt so the AI predicts better and pre-fills smarter.
**Done when:** repeating a kind of task is visibly faster — better defaults, fewer
edits — than the first time you did it.

---

## The two pieces you implement per integration

These are the only system-specific parts. Email is the first; calendar/etc. later
reuse the same pattern.

1. **Where data comes from** — given a reference like `draft.body` or a query like
   `inbox`, fetch the real value (from Gmail). In the code this is the `DataContext`.
2. **What actions do** — given a name like `email.send`, run the real Gmail call.
   In the code this is the `CapabilityRegistry`.

Adding a new app later = writing these two things again for that app. Nothing else
changes. That's the whole design.

---

## Memory, in plain terms

A tiny local table: `{ what you asked, what screen appeared, what you chose/edited, when }`.
Before each new request, pull the most relevant recent rows and include them in the
prompt to Claude. That's it — no fancy ML. "Learns you" = "remembers you and tells
the model." You can make it smarter later.

---

## Do NOT build yet (resist these)

- The grand shared "data layer" / unified schema — let it emerge after a 2nd app.
- Multi-step automations / autonomous agent runs.
- Other people's accounts, sign-up, billing, sharing.
- More than the 3 primitives. Add a 4th only when a screen genuinely can't be built.

Ship M0–M5 for yourself first. Everything above is the second project.

---

## One thing to measure from day one

Log **time-to-done**: from opening the launcher to the task being finished. Your
whole reason for existing is that this number goes *down* and that you spend *less*
time in the app, not more. If a feature makes that number worse, it's wrong.

---

## How to start in Claude Code

1. **Install Claude Code** (needs a paid Anthropic plan — Pro/Max/Team/Enterprise,
   or Console credits):
   - Recommended (no Node needed):
     - macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`
     - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
   - Or via npm (needs Node.js 18+): `npm install -g @anthropic-ai/claude-code`
2. Put `surface-contract.ts`, `SurfaceRenderer.jsx`, and this file in one folder.
3. Open a terminal in that folder and run `claude`.
4. Tell it: *"Read MVP_BUILD_PLAN.md. Let's build M0 only. Don't start M1 until M0
   runs."* Then go milestone by milestone — one at a time, testing each before moving on.

The single most useful habit: **make it finish and run each milestone before
starting the next.** That's how this stays a working app instead of a half-built one.
