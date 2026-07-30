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
| **Display test** | ✅ verified | Large text is the default; long checklists collapse to a single tappable line — over three steps on Now, over five on Today — so the immediate list stays scannable. |
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
| MVP-6 Calendar read + notifications | ✅ done — feed **out** (real phone/watch alerts with prep lead times) and read **in** from **both iCloud and Google**, read-only. Her appointments drive the trigger engine. |
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
| AI abstraction | One `askAI()` interface. The **provider is detected from the key's shape** and the **model is chosen automatically** per request from the provider's live model list — nothing to configure but the key. Context is chosen by the retrieval layer — typically 9 of 51 open items, each with a reason — never the whole database. |
| Apple Calendar/Reminders | Both directions, and **both her calendar systems**. Feed **out** (subscribe once, real alerts, prep lead times); read **in** from iCloud over CalDAV and from Google via its private `.ics` link — read-only. Reminders deliberately untouched: they work, and duplicating them would only add noise. |
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

## The calendar link — iCloud and Google

She uses **both**, so both are supported, feeding one merged set of events.

- **iCloud** over CalDAV, with an Apple ID and an app-specific password
  (about a minute to create; her real Apple password never reaches this app,
  and access is revocable from Apple's side without touching Sage).
- **Google** — and Outlook, or anything publishing iCalendar — by pasting the
  calendar's private `.ics` link. No OAuth, no Google Cloud project, no
  consent screen, and read-only by construction: a feed URL cannot write.

- **Read-only. Not one write request exists in the code.** Apple Calendar
  stays the system of record — §11's "complement, don't replace."
- **Her appointments drive the trigger engine.** A PT appointment on her
  iCloud calendar suppresses home PT in Sage with no data entry at all.
  Verified: PT rounds gone on the day of an iCloud PT event, back the next.
- Recurrence: iCloud expands it server-side via CalDAV `<C:expand>`. A
  subscribed `.ics` feed does not, so `ical.js` expands it here — DAILY,
  WEEKLY, MONTHLY and YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (including
  "third Sunday" and "last Friday"), BYMONTHDAY, EXDATE exceptions, and
  edited single occurrences via RECURRENCE-ID.
- Per-calendar toggles — she chooses which ones Sage sees.
- **A failing source never deletes her appointments.** Pruning only runs when
  every source succeeded, so a dropped connection cannot empty her day.
- The credential is AES-256-GCM encrypted at rest with a key derived from
  `SESSION_SECRET`, never logged, and stored apart from ordinary records.
  Verified: the stored blob contains no plaintext, decrypts correctly, and
  fails closed under the wrong secret (prompting a reconnect rather than
  breaking).
- Events refresh in the background every 30 minutes, never blocking a view.

Verified end to end:

| Check | Result |
|---|---|
| iCloud PT appointment suppresses home PT | ✅ gone that day, back the next |
| **Google** PT appointment does the same | ✅ same behaviour, different source |
| Both sources visible on one day, no collisions | ✅ |
| A source going down does **not** erase her appointments | ✅ 34 kept through a failed refresh |
| Recurrence expansion (12 patterns) | ✅ weekly, every-other-week with COUNT, third Sunday, last Friday, yearly all-day birthday, UNTIL, EXDATE, edited occurrence, monthly-31st skipping short months, window clipping |
| iCalendar parsing | ✅ timed events keep local time, all-day stays date-only, folded lines rejoin, cancellations dropped |
| "PT" inferred, "Joe Ward Birthday" correctly left alone | ✅ |


## The retrieval layer

Sage (the GPT) made the sharpest critique of this build, and it was right:

> There are really three layers, not two. Database → **Retrieval** → AI.
> Most assistants fail at layer 2. They either retrieve almost nothing, or
> they retrieve everything.

The first version retrieved everything — every open item on every request.
With 51 seeded items that is already noise, and it grows with her life. It
is also the exact failure that makes an assistant feel like it is searching
a database rather than knowing you.

`selectContext()` now chooses. Two questions decide what the reasoning layer
sees:

**What is live right now** — today's appointments (from either calendar),
routines still pending, anything due now or this week, opportunities eligible
today, and seasonal work whose window has just opened. Weather is included
only when something actually turns on it.

**What her words point at** — items scored by how *distinctive* the matching
words are. Terminix appears in one item and means everything; "Sage" appears
across half her notes and means nothing, because she says it every morning.
Rarity is measured against her own data rather than a hand-written list, so
it keeps working as her life changes. Conversational framing — greetings, the
assistant's name, "remind me" — is dropped before scoring.

Every selected item carries **why** it was chosen, and the payload states how
many items were left out, so the reasoning layer can never mistake its slice
for the whole picture and tell her she has nothing else on.

| Capture | Selected | Word-matched |
|---|---|---|
| "I paid Terminix" | 7 of 51 | **Pay Terminix** — the one right thing |
| "Good morning Sage. 150.0." | 7 of 51 | nothing spurious |
| "we're going to the lake Friday" | 14 of 51 | the lake trip, the lake hosting date, lake supplies |
| "what about the curtains" | 8 of 51 | **Hem the pink bedroom curtains** |
| "did I ever call about the August 24th thing" | 9 of 51 | **Call to change the August 24 appointment** |
| "I bought jewelry organizers" | 9 of 51 | the jewelry project and its next action |

Average: **9 of 51 items**. Inspectable at any time via `GET /api/ai/context`
— retrieval you can check rather than trust.

## Memory — the middle tier

The spec (§24) describes three tiers, and the first build had two:

> Structured facts belong in the database; **stable personal context and
> collaborative decision principles belong in retrievable memory**; recent
> conversation supplies immediate context.

Tasks lived in the database and chat lived in threads, but nothing carried a
decision from one conversation to the next. Start a new thread and Sage had
forgotten everything she'd ever settled.

`memories` is that tier: facts, preferences, decisions, principles, people
and places — durable, deliberately **not** tasks and **not** chat.

- **Nothing lands silently.** Sage proposes a memory the same way it proposes
  a task — from a capture ("remember that…") or when she harvests a thread —
  and she ticks it before it is kept.
- **All of it is visible and editable** under *What Sage knows*, searchable,
  with one-tap delete. Memory she cannot inspect is memory she cannot trust.
- **Pinned memories** travel into every conversation. Her decision principle
  lives there.
- **Recall scales.** Under thirty memories the whole set travels, because
  selecting is worse than not selecting at that size — word-matching cannot
  connect "what should I wear" to "she avoids tanks", but the reasoning layer
  can. Above thirty it falls back to relevance plus pinned, bounded at ten.
- **Long threads keep a rolling gist**, summarised in the background past the
  verbatim window, so a conversation doesn't forget its own beginning.

**Bug found and fixed here:** usage count was added to the relevance score, so
a memory recalled once scored above zero forever and came back on every
unrelated query — "I paid Terminix" was dragging along the silver tea set.
Usage now only breaks ties between things that already matched.

Verified at both scales: with four memories all four travel; with forty, the
tea-set query recalls the two tea-set memories plus the pinned principle,
and "I paid Terminix" carries the pinned principle alone.

## The persona, revised by Sage

Regena asked for this one specifically, and Sage (the GPT) wrote the critique.
It was right on every count, and all of it is in.

**Four additions:**

- **Curiosity before correction.** When her reasoning looks inconsistent, the
  first thought is that Sage may be missing context — she has information it
  does not. Ask one good question rather than assume she is rationalizing.
- **No manufactured disagreement.** Independent thinking is not an obligation
  to object. If her reasoning is sound, say so and move on; an objection you
  had to go looking for is not insight.
- **Not every conversation needs an outcome.** She may be thinking aloud,
  noticing something, or simply talking. Do not produce a task, a decision or
  a stored change when none is wanted.
- **The relationship is allowed to change.** Her corrections to Sage's tone
  and reasoning are calibration, not complaints — to be carried forward
  rather than politely absorbed. Nothing is frozen at its first draft,
  including the description of Sage itself.

**And one line softened.** The original read *"do not surface something whose
prerequisite is unfinished"* — too absolute. As Sage put it: if she says she
wants the curtains done this week, it should not be forbidden from discussing
the curtains because the sewing machine isn't set up.

Now: *"do not present a dependent action as currently actionable while what it
depends on is unfinished. This is about what you put on her plate, not about
what may be discussed."*

Worth noting: **the code was already doing the right thing.** Verified that
when she raises the curtains, they reach Sage tagged with what they're waiting
on, while never appearing in her actionable work unprompted. The behaviour was
correct; the prompt was describing it too strictly.

## The morning hour

Sage (the GPT) raised this after talking with Regena about her mornings, and
it is the sharpest design note in the whole build:

> For over 40 years, mornings weren't hers. They belonged to the clock… The
> temptation with an intelligent assistant is to greet her every morning with
> *here are your tasks, here are your reminders, here are your priorities.*
> But for her, that would be taking one of the best gifts of retirement and
> replacing it with another commute — just a digital one.

He was right, and the app was doing exactly that: greeting, then straight
into appointments and a task list.

Before 10am, **Now opens with presence instead**. Her name, one true line
about what the morning is actually doing outside, and:

> *This time belongs to you. There's nothing you need to do right now.*

The day is one tap away — *"When you're ready, let's look at the day →"* — and
once she opens it, it stays open for the rest of that day. Weight logging
stays, because that greeting is her own ritual. It can be switched off
entirely with the `gentle_mornings` preference.

**Two things it will not do.** It will not hide something that would make her
late: an appointment inside three hours is said plainly, with its lead time,
followed by *"Nothing else needs you yet."* And it will not invent
atmosphere. Sage cannot see the feeder, so it never claims the hummingbirds
have arrived — it says what it actually knows, which is the weather and where
she is.

**Bug found here and fixed:** the "how long until this?" calculation compared
her wall-clock appointment against the *server's* clock. The server is in a
different timezone from Evans, so a 9:30 appointment read as almost three
hours in the past and was silently dropped from the morning. Both clocks are
now Sage's own.

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
