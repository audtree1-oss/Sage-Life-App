# Sage spec → what got built

A straight answer to "did it do what the spec said?" — written so Regena
(or Sage) can check the work rather than take my word for it.

## §15 Acceptance tests — all twelve

| Test | Status | How it's satisfied |
|---|---|---|
| **Morning test** | ✅ verified | "Good morning Sage. 150.0" records weight and returns the compact Now view. Works with the AI layer, and via rules without it. |
| **Cross-session persistence** | ✅ verified | Server restarted mid-test; all items, routines, trips and completions survived. SQLite on a persistent disk. |
| **Completion test** | ✅ verified | "I paid Terminix" matches the existing item and marks it done with a timestamp; it leaves active views immediately. |
| **Prerequisite test** | ✅ verified | "Hem the curtains" stayed out of actionable lists while "Set up and learn the sewing machine" was open, and showed *"waiting on: set up and learn the sewing machine"*. |
| **Conditional routine test** | ✅ verified | With a PT appointment on the day, Home PT vanished from the routine list; without one, it returns with two rounds. |
| **Hosting test** | ✅ verified | A hosting event tomorrow surfaced "Before company arrives → Guest bathroom clean" today. |
| **Lake test** | ✅ verified | A stated trip activated the 8-step "Before leaving Evans for the lake" checklist the day before departure. |
| **Opportunity test** | ✅ verified | Publix senior day appeared as eligible on Wednesday only, in the Opportunities view, with no due date and no way to become overdue. |
| **Display test** | ✅ verified | Large text is the default; checklists over three steps collapse to a single tappable line so Now stays scannable. |
| **Correction test** | ✅ built | Free-text correction on any item: "that isn't urgent, leave it until September" sets the window and target, not a due date. Requires the AI layer. |
| **Privacy test** | ✅ by design | Items store the task, never the secret. No password, account, or document fields exist to put them in. |
| **Provider test** | ✅ built | One `askAI()` interface; `AI_PROVIDER=anthropic\|openai`. Records and business logic are untouched by the swap. |

Weather triggers were verified against a stubbed forecast (the build sandbox
blocks outbound weather calls); the live call is a standard open-meteo
request and needs no key.

## §14 MVP stages

| Stage | Status |
|---|---|
| MVP-1 Auth + private database + backup | ✅ done (single-account, JSON export, Render disk) |
| MVP-2 Natural capture → structured records | ✅ done |
| MVP-3 Update/complete/defer/correct by language | ✅ done |
| MVP-4 Today + Morning + This Week views | ✅ done (+ Coming Up) |
| MVP-5 Trigger engine | ✅ done (day, season, weather, location, event, prerequisite, suppression) |
| MVP-6 Calendar read + notifications | ⏳ **partial** — feed *out* is done (real phone/watch alerts, with prep lead times). Reading *her* calendar in needs iCloud CalDAV or Google OAuth; deliberately deferred until we know which she uses. |
| MVP-7 Opportunities engine | ✅ done |
| MVP-8 Lake/location workflows + inventory | ✅ done |
| MVP-9 Weather-aware triggers | ✅ done |
| MVP-10 Export, history, provider abstraction | ✅ done (audit history with one-tap undo) |

## §17 technical questions — answered

| Question | Decision |
|---|---|
| Implementation target | **PWA, iPhone-first**, added to the home screen. Native iOS would add App Store, Xcode and yearly fees for one user with no benefit. |
| Backend + cost | Node/Express + SQLite on a Render persistent disk. ~$7–14/month plus a few cents of AI. |
| Auth + recovery | Single account, bcrypt, httpOnly cookie, 120-day session. Recovery server-side. |
| AI abstraction | `askAI()` behind two env vars; context minimized to open items, projects, locations and today's weather — never the whole database. |
| Apple Calendar/Reminders | Feed **out** now (subscribe once, real alerts). Read **in** deferred pending iCloud-vs-Google. |
| Notifications | The calendar feed carries the reliable ones, including preparation lead times. Web push is possible once installed to the home screen. |
| Weather/location | open-meteo on **fixed coordinates per place**. No permission prompt, no GPS, no battery cost — and her places don't move. |
| Backup/export | JSON export of everything, any time, plus disk snapshots. |
| Photos | Stored on disk, referenced by filename, served behind login — the database stays small. |
| Auto-mutation | Only high-confidence completions arrive pre-checked; consequential ones do not. Everything auto-applied lands in an undo strip. |

## §18 Out of scope — respected

No password manager, no banking aggregation, no autonomous financial
transactions, no attempt to replace the Excel budget, no bulk import of old
conversations, no perfect inventory, no multi-user features, and no giant
everything-dashboard. The Now view shows what's immediate and nothing else.

## What Sage knows the moment she signs in

Seeded from the **Full Day-One Context Export** (July 29, 2026) — `seed-data.js`.

- **11 routines** — summer morning, evening closing, lake departure, lake
  pack-up, weekly water run, patio kitchen, rain, guest prep, Monday garbage
  (with *why*: so it isn't blocking the street at commute time), home PT,
  quarterly house check.
- **51 items** — 21 tasks, 13 projects with next actions, 11 opportunities,
  4 dated events, 2 shopping items. Terminix, the Aug 24 call, birthday gifts
  by Aug 10, the Amazon hat return, the Jar Genie, the Maytag deep clean, the
  garden system, Masters prep, the estate tasks.
- **3 places** with real coordinates — Evans GA, Lake Greenwood SC, patio
  kitchen — so weather triggers work per location.
- **The July 31–Aug 2 lake trip**, already on the books.
- **3 supplies** on sale-watch, escalating on their own as they run out.
- **Her operating principles**, travelling with every AI request: *could
  improve ≠ needs improvement* · *what would this add that the current ones
  don't?* · *a deferred task is not automatically avoidance* · lower
  cognitive load, not maximum productivity, and not a smaller life.

Verified against her real calendar:

| Date | Expected | Result |
|---|---|---|
| Wed Jul 29 | Publix 5% eligible; no false departure two days out | ✅ |
| Thu Jul 30 | Home PT suppressed (PT at 9:30); lake departure checklist up | ✅ |
| Sun Aug 2 | Lake pack-up checklist up; summer morning suppressed while away | ✅ |
| Sep 10 & 11 | Guest prep up both the day before and the day of hosting | ✅ |

**Bug found and fixed during this pass:** every "is it soon?" test was
computed against the real today rather than the date being viewed, so trip
departure, lake pack-up, and hosting prep silently failed on any future
date. All date arithmetic is now relative to the day in question.

## Not in Sage, on purpose

Per §22 and §18: no passwords or security answers, no account or financial
data, no wills/trusts/estate documents, no medications or medical detail.
"Update the beneficiary" is tracked; what it refers to is not. The Excel
budget, Apple Calendar, Apple Reminders, Notes and Paprika are left alone —
they work, and duplicating them would only add noise.

## Where I differed from the spec, and why

1. **MVP-1 was not shipped as its own stage.** "Auth + database + backup" is
   a deliverable Regena cannot see. Stages 1–5 shipped together so the first
   thing she opens already works.
2. **Added: an undo strip.** The spec allows auto-applying low-risk updates.
   That's right, but trust needs a visible way back — so anything Sage did on
   its own shows on Now with one-tap Undo.
3. **Weather by fixed coordinates, not device location.** Simpler, no
   permission prompt, and better suited to two known places.
4. **Routines collapse on Now.** Found by looking at a real phone screen: an
   8-step evening checklist broke the "one screenful" requirement, so long
   lists became one tappable line.
