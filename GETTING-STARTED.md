# Getting Sage running 🌿

Written for a non-developer. Follow it top to bottom; it takes about fifteen
minutes, most of which is waiting.

---

## 1. Put it on the internet (Render)

1. Go to **[render.com](https://render.com)** and sign in with GitHub.
2. Click **New +** → **Blueprint**.
3. Pick this repository. Render reads `render.yaml` and sets everything up.
4. Click **Apply**.

Render creates the web service and a 1 GB disk that holds the database. The
first build takes a few minutes.

## 2. Turn on the thinking layer (recommended)

Without this, Sage still works — capture falls back to simple rules, and
every view, routine, and trigger behaves exactly the same. With it, Sage can
understand "we're going to the lake Friday" and "I paid Terminix."

1. Get an API key:
   - **Anthropic** — [console.anthropic.com](https://console.anthropic.com) → API Keys
   - or **OpenAI** — [platform.openai.com](https://platform.openai.com) → API Keys
2. In Render: your service → **Environment** → **Add Environment Variable**
   - Key: `AI_API_KEY` · Value: the key you copied
   - That's the only thing to set. Sage works out which company the key
     belongs to, and picks the model itself — a quick one for sorting what
     you say, a stronger one for thinking with you.
3. **Save changes.** Render restarts on its own.

You can confirm it worked in **More → Settings → Thinking layer**, which
shows the models it chose.

Cost is a few cents a month at this usage. Set a spending limit in the
provider's console if that's reassuring.

## 3. Claim the app

1. Open your Render URL (something like `sage-xxxx.onrender.com`).
2. Enter name, email, and a password of 8+ characters. **Write the password
   down somewhere real.**
3. That's it — the first person to sign up owns the app, and signup then
   closes. Nobody else can get in.

Sage arrives already knowing the starter routines: summer morning, evening
closing, the lake departure checklist, weekly water run, patio kitchen
check, rain check, guest prep, Monday garbage, and home PT.

## 4. Put it on the home screen (do this — it matters)

On the iPhone, in **Safari**:

1. Open the Sage URL.
2. Tap the **Share** button (the square with the arrow).
3. Scroll and tap **Add to Home Screen** → **Add**.

Now it has an icon and opens full-screen with no browser bars, like any
other app. Voice capture works properly this way too.

## 5. Let Sage see your calendars

So Today and This Week show your real appointments — and so a PT appointment
switches off your home PT rounds by itself.

**Sage only reads. It never adds, changes or deletes anything.**

### iCloud

1. Go to **appleid.apple.com** and sign in.
2. **Sign-In and Security** → **App-Specific Passwords** → **+**
3. Name it **Sage**, and copy the password it gives you (four groups of four
   letters).
4. In Sage: **More** → **Settings** → **Connect iCloud**. Enter your Apple ID
   and paste that password.

Your real Apple password never goes into Sage. The app-specific password is
stored encrypted, used only to read, and you can cancel it from
appleid.apple.com any time.

### Google (and any other calendar)

No Google account setup, no permissions screen — just a link:

1. On a computer, open **Google Calendar**.
2. Hover the calendar's name on the left → **⋮** → **Settings and sharing**.
3. Scroll to **Integrate calendar**.
4. Copy **Secret address in iCal format** (it ends in `.ics`).
5. In Sage: **More** → **Settings** → **Add a calendar link**, and paste it.

Repeat for each Google calendar you want Sage to see. Keep those links
private — anyone with one can read that calendar — and you can reset a link
from the same Google screen at any time.

The same works for Outlook or any calendar that publishes an `.ics` link.

## 6. Subscribe to the calendar feed

So dated things show up on the real calendar and the Apple Watch:

1. In Sage: **More** → **Settings** → **Subscribe on this phone**.
2. Tap through the prompt Calendar shows.

Heads up: subscribed calendars refresh on the phone's own schedule (usually
a few times a day), so a brand-new date can take a little while to appear.

---

## Using it

**The one habit:** when a thought arrives, tap **Tell Sage** and say it.
That's the whole system. Everything else is Sage's job.

- *"Good morning Sage. 150.0."* → records weight, opens the morning view
- *"We're going to the lake Friday."* → wakes up trip planning and the
  departure checklist
- *"I paid Terminix."* → finds that task and marks it done
- *"Remind me to call the insurance company Tuesday."* → a dated task
- *"The windows need resurfacing but not until September."* → waits until
  September instead of nagging in July

**To let your ChatGPT Sage see this app** — **More → Settings → 🤖 ChatGPT**.
It gives you a link and a key to paste into your Sage GPT's *Actions* (on a
computer; about five minutes, once). After that you can ask ChatGPT "what's on
today?" or "did I write down the Terminix thing?" and it will actually know.

It can only **read**. It can never add, change or finish anything — that still
happens here, where you approve it. Disconnect any time from the same screen
and it stops working immediately.

**Staying signed in** is fine and intended — every time you open Sage the
session slides forward, so it won't log you out. Your phone's own lock (and
Face ID, in Settings) is what actually protects it. Signing out everywhere is
in Settings if you ever need it.

**When you want Sage to remember something** — just say *"remember that…"*,
or add it under **More → 🧠 What Sage knows**. That's for things that are
simply true about your life — a decision you reached, a preference, why
something matters — as opposed to things you have to do. Everything Sage
knows is listed there, and you can change or delete any of it.

**When Sage doesn't sound right** — **More → Settings → 🗣️ How Sage talks to
you**. Write it however you'd say it: *"be blunter with me"*, *"stop
reassuring me"*, *"shorter answers"*, *"more warmth in the morning"*. Your
words win. It changes tone only — the rules that keep Sage honest stay put.

**When Sage gets something wrong** — open the item and say what's wrong in
the box at the top: *"that isn't urgent, leave it until September"* or
*"that's for the lake."* No forms, no categories to learn.

**If Sage did something on its own** you'll see a strip at the top of Now
saying so, with an **Undo** button.

**Recent captures** (More → 📥) shows everything you said and what Sage made
of it. Useful in the first weeks while you're deciding whether to trust it.

---

## When something's weird

| Problem | Try this |
|---|---|
| Can't sign in | The password is the one you set at step 3. There's no reset link — that's the tradeoff of a private single-account app. |
| Capture is very literal | `AI_API_KEY` isn't set, or was refused. **More → Settings → Thinking layer** says which, in plain words. |
| "The key was refused" but you're sure it's right | You probably are right — a pasted key often carries an invisible trailing newline or space. Sage now strips those automatically, so re-paste it and save. |
| "Out of credit" | The key is fine; the provider account needs funds. Settings → Thinking layer links straight to billing. |
| Weather isn't showing | The coordinates for your places may need adjusting (More → Settings → Places). |
| Calendar dates aren't appearing | Subscribed calendars refresh slowly. Give it a few hours. |
| App seems asleep on first open | Render's starter plan sleeps when idle; the first open takes a few seconds. |

## Your data is yours

**More → Settings → Export everything** downloads the whole thing as a JSON
file, any time. Worth doing occasionally and keeping somewhere safe.
