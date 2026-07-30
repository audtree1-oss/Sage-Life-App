# Sage 🌿

Regena's intelligent, collaborative personal assistant and thinking partner.

Built to the **Sage v1 Independent App Build Specification** (July 29, 2026).
Say something once, in ordinary language, and stop carrying it.

> "Regena should be able to think out loud once and stop worrying about
> remembering the thought." — spec §19

**Setting it up? Start with [GETTING-STARTED.md](GETTING-STARTED.md).**
**Checking it against the spec? See [SPEC-COVERAGE.md](SPEC-COVERAGE.md).**

## The architectural rule

**The database is the source of truth. Retrieval decides what matters.
The AI reasons over that.**

Nothing here depends on a chat history. Structured state lives in SQLite. On
each interaction the AI receives the *current* state, reasons about it, and
proposes structured updates that Regena approves. Close the app for a month
and everything is exactly where she left it.

Between the database and the reasoning sits a selection layer. Sending the
whole open list is the easy mistake, and it is why most assistants feel like
they are searching a database rather than knowing you. `selectContext()`
picks the handful that matter — what is live right now, and what her words
actually point at, scored by how distinctive each word is in her own data —
and states how much it left out so the reasoning layer never mistakes its
slice for the whole picture. Typically **9 items out of 51**, with a reason
attached to each.

The AI provider sits behind a single `askAI()` function. Paste a key and
nothing else: the provider is detected from the key's shape, and the model is
chosen automatically per request from the provider's own live model list — a
fast one for sorting what she says, a stronger one for thinking with her,
decided by how much is actually in the capture. Swapping providers changes no
data and no business logic.

## What's inside

- **Tell Sage** — the big button. Talk or type in ordinary language:
  *"Good morning Sage. 150.0."* · *"We're going to the lake Friday."* ·
  *"I paid Terminix."* Sage classifies it against everything already stored,
  shows what it understood, and saves only what she approves. Obvious,
  low-risk updates come pre-checked; anything consequential does not.
- **🤖 Her ChatGPT Sage can look in here** — she talks to a Sage in ChatGPT
  too, so that one can now see what's actually going on: what's on today, her
  routines, her projects, what Sage remembers. Connected as a custom GPT
  Action with its own revocable key. **Read-only by construction** — there is
  no write path on those routes at all. Changing anything still happens in the
  app, where she approves it.
- **🕐 A home screen** — Now leads with the time and date, live, in Sage's own
  timezone. Staying signed in is the point: the session slides forward every
  time she opens the app, so it never logs her out from under her.
- **✨ Fireflies** — eleven of them drift and blink behind the morning
  greeting and again after 7pm, when they'd really be out over the grass —
  each each on its own rhythm so they never pulse together. Pure CSS, no
  timers, nothing to drain a phone that lives on a kitchen table. They vanish
  entirely for anyone who prefers reduced motion. A surprise from Audrey.
- **The morning hour** — before 10am, Now opens with presence rather than
  productivity: her name, what the weather is actually doing, and *"this time
  belongs to you; there's nothing you need to do right now."* The day is one
  tap away when she wants it. For someone whose mornings belonged to a clock
  for forty years, opening with a task list would just be a commute in a new
  form. It still speaks up about anything inside three hours — being calm is
  not the same as letting her be late.
- **Now** — immediate items only, aimed at one iPhone screen. Next
  appointment, today's must-dos, and the routines that are actually relevant
  right now. Long checklists collapse to a line until tapped.
- **Today / This Week / Coming Up** — appointments and obligations, then
  horizons out to a year. Opportunities appear here as opportunities, never
  as overdue tasks.
- **Routines with a real trigger engine** — checklists that appear only when
  they apply: by day, season, weather, location, or event. Home PT
  disappears on a PT-appointment day. The lake departure list wakes up the
  day before a trip. Guest bathroom prep surfaces before company. Sump-pump
  check appears when rain is forecast.
- **Prerequisites** — hemming the curtains does not surface as actionable
  while the sewing machine setup is still open. It says so, plainly.
- **Seasonal windows** — "resurface the windows" waits for September and
  says *"not until September"* rather than nagging in July.
- **Opportunities** — useful, never owed. Filter by the time she actually
  has: 15 minutes, 30, an hour.
- **Projects** — outcome, next action, what's in the way. Nothing else.
- **The lake** — trips, departure and arrival checklists, what's stocked up
  there, and what needs to come home.
- **Recent captures** — the safety net. Everything she said, what Sage made
  of it, and a one-tap fix in her own words: *"that isn't urgent, leave it
  until September."*
- **Undo for anything Sage did on its own** — auto-applied changes appear in
  a strip on Now with an Undo button. Trust needs a visible undo.
- **Her calendar, both directions** — Sage's dated items flow *out* to the
  real Apple calendar (real alerts on phone and watch, including preparation
  lead times), and her appointments flow *in* — **iCloud** over CalDAV and
  **Google** (or Outlook) by pasting a private `.ics` link. Read-only: Sage
  never writes to her calendars. And her real appointments drive the trigger
  engine — a PT appointment on either one switches off home PT here, with no
  data entry at all. Recurring events are expanded properly, including
  "third Sunday" and "last Friday" patterns.
- **Export everything** as JSON, any time. Her data is hers.

## Accessibility

iPhone-first and large-text by default (not a setting she has to find —
Large is the default, with Largest available). 48px minimum tap targets,
short headings, checkboxes, progressive disclosure, and a light/dark
setting. Voice capture is first-class; typing is never required.

## Privacy boundary (spec §12)

Sage tracks *"update the beneficiary"* without storing the account it refers
to. No passwords, no financial credentials, no estate documents pulled in
just because they were mentioned. Only the context needed for the current
task is sent to the AI provider, and the export/delete path is always open.

## Architecture

Node/Express + SQLite on a persistent disk, deployable to Render via the
`render.yaml` blueprint.

- **Node 22** pinned in `render.yaml`, `.node-version`, and `package.json`
- **better-sqlite3** at `$DATA_DIR/sage.sqlite` (WAL mode)
- **Photos** on the disk at `$DATA_DIR/uploads`, served behind login
- **Auth** — single-account, bcrypt, httpOnly cookies, 120-day sessions
- **Weather** — open-meteo by fixed coordinates per place. No API key, no
  location permission prompt, no battery drain.
- **Frontend** — one mobile-first vanilla-JS page, no build step

## Run locally

```bash
npm install
npm start          # http://localhost:3000, data in ./data
```

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite DB + uploads |
| `AI_API_KEY` | *(unset)* | Enables the reasoning layer. Everything else is inferred. |
| `AI_PROVIDER` | auto | Override detection (`anthropic` / `openai`) |
| `AI_MODEL_FAST` | auto | Override the sorting model |
| `AI_MODEL_SMART` | auto | Override the thinking model |

Without `AI_API_KEY` the app still runs: capture falls back to rules, and
every view, routine, trigger, and checklist works exactly the same. The
database is the source of truth, so the AI is an enhancement, not a
dependency.

## Deploy to Render

**New + → Blueprint → pick this repo → Apply.** Walkthrough in
[GETTING-STARTED.md](GETTING-STARTED.md).
