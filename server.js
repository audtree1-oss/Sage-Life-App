// Sage — Regena's collaborating personal assistant and thinking partner.
//
// THE ARCHITECTURAL RULE (Sage spec §3):
//   The database is the source of truth. The AI is the reasoning layer.
// Nothing here depends on an AI conversation history. The AI receives the
// relevant current state, reasons about it, and proposes structured updates.
// The provider sits behind askAI() and is swappable by environment variable.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const SESSION_SECRET = process.env.SESSION_SECRET || 'sage-local-dev';

// --- AI provider abstraction (spec §3, §17) -------------------------------
// Paste a key and go. The provider is inferred from the key's shape, and the
// model is chosen automatically per request — no configuration required.
// Keys get pasted, and pasting picks things up: a trailing newline from the
// copy, surrounding quotes, an accidental "Bearer ". None of it is visible in
// a settings box, and every bit of it produces a 401 that reads as "your key
// is wrong" when the key is perfectly fine. Clean it rather than let her hunt.
function cleanKey(raw) {
  return String(raw || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}
const AI_API_KEY = cleanKey(process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

function detectProvider(key) {
  if (/^sk-ant-/.test(key)) return 'anthropic';
  if (/^sk-/.test(key)) return 'openai';
  return 'anthropic';
}
const AI_PROVIDER = (process.env.AI_PROVIDER || detectProvider(AI_API_KEY)).toLowerCase();

// Two tiers. "fast" handles the high-volume structured work (turning a
// capture into records); "smart" handles the thinking-partner work, where
// pushing back well matters more than a fraction of a cent.
const MODEL_PREFERENCES = {
  openai: {
    fast: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4o'],
    smart: ['gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
  },
  anthropic: {
    fast: ['claude-haiku-4-5', 'claude-sonnet-5'],
    smart: ['claude-sonnet-5', 'claude-haiku-4-5'],
  },
};

// Ask the provider what it actually offers, then take the best from the
// preference list. Guessing wrong is harmless — unavailable names are simply
// skipped — so this keeps working as model names change underneath us.
let MODELS = null;
async function resolveModels() {
  if (MODELS) return MODELS;
  const prefs = MODEL_PREFERENCES[AI_PROVIDER] || MODEL_PREFERENCES.anthropic;
  const chosen = { fast: prefs.fast[0], smart: prefs.smart[0], source: 'defaults' };
  if (AI_PROVIDER === 'openai' && AI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${AI_API_KEY}` } });
      if (r.ok) {
        const available = new Set(((await r.json()).data || []).map((m) => m.id));
        const pick = (list) => list.find((m) => available.has(m));
        chosen.fast = pick(prefs.fast) || chosen.fast;
        chosen.smart = pick(prefs.smart) || chosen.smart;
        chosen.source = 'live model list';
      }
    } catch { /* offline or blocked — defaults are fine */ }
  }
  // Explicit overrides always win, for when she wants a specific model.
  if (process.env.AI_MODEL_FAST) { chosen.fast = process.env.AI_MODEL_FAST; chosen.source = 'env override'; }
  if (process.env.AI_MODEL_SMART) { chosen.smart = process.env.AI_MODEL_SMART; chosen.source = 'env override'; }
  if (process.env.AI_MODEL) { chosen.fast = chosen.smart = process.env.AI_MODEL; chosen.source = 'env override'; }
  MODELS = chosen;
  console.log(`Sage AI: ${AI_PROVIDER} — fast=${chosen.fast}, smart=${chosen.smart} (${chosen.source})`);
  return MODELS;
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(path.join(DATA_DIR, 'sage.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL DEFAULT '',
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  flow_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The universal capture record. Every kind of thing lives here with a type,
-- so natural capture never has to decide "which form is this?" up front.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raw_capture TEXT NOT NULL DEFAULT '',        -- her original words, always kept
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'task',           -- task|event|project|opportunity|shopping|note
  status TEXT NOT NULL DEFAULT 'open',         -- open|done|waiting|someday|dismissed
  importance TEXT NOT NULL DEFAULT 'should',   -- must|should|opportunity|someday
  life_area TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',           -- location key
  due_at TEXT NOT NULL DEFAULT '',             -- YYYY-MM-DD or YYYY-MM-DDTHH:MM
  window_start TEXT NOT NULL DEFAULT '',       -- "not before" — seasonal/deferred
  window_end TEXT NOT NULL DEFAULT '',
  target_window TEXT NOT NULL DEFAULT '',      -- her words: "September", "cool dry weather"
  effort_min INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 0,
  prereq_ids TEXT NOT NULL DEFAULT '[]',       -- JSON array of item ids
  next_action TEXT NOT NULL DEFAULT '',        -- projects
  outcome TEXT NOT NULL DEFAULT '',            -- projects: what "done" looks like
  event_start TEXT NOT NULL DEFAULT '',
  event_end TEXT NOT NULL DEFAULT '',
  prep_minutes INTEGER NOT NULL DEFAULT 0,     -- leave-by / prepare-by lead time
  event_kind TEXT NOT NULL DEFAULT '',         -- hosting|pt|appointment|trip|other
  attendees TEXT NOT NULL DEFAULT '',
  store TEXT NOT NULL DEFAULT '',              -- shopping
  purchase_rule TEXT NOT NULL DEFAULT 'now',   -- now|low|on_sale|watch
  inventory_state TEXT NOT NULL DEFAULT '',    -- ok|low|out
  photo_file TEXT NOT NULL DEFAULT '',
  eligibility TEXT NOT NULL DEFAULT '{}',      -- opportunities: JSON rules
  waiting_on TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',       -- voice|typed|ai|seed
  ai_private INTEGER NOT NULL DEFAULT 0,        -- never include in provider prompts
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_user_status ON items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(user_id, type);

-- Routines: compact checklists that appear only when relevant (spec §7, §10).
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL DEFAULT 'daily',  -- daily|weekly|seasonal|weather|location|event|flexible
  trigger_config TEXT NOT NULL DEFAULT '{}',   -- JSON: days, months, time_of_day, weather, location, event, after_hour, offset_days
  suppress_if TEXT NOT NULL DEFAULT '{}',      -- JSON: {event_kind:"pt"} — conditional suppression
  cadence_note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS routine_steps (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS routine_done (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  step_id INTEGER NOT NULL DEFAULT 0,          -- 0 = whole routine marked done
  date TEXT NOT NULL,
  done_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(routine_id, step_id, date)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📍',
  lat REAL NOT NULL DEFAULT 0,
  lon REAL NOT NULL DEFAULT 0,
  is_home INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, key)
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_key TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',      -- planned|active|done
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location_key TEXT NOT NULL DEFAULT 'evans',
  state TEXT NOT NULL DEFAULT 'ok',            -- ok|low|out
  purchase_rule TEXT NOT NULL DEFAULT 'low',   -- now|low|on_sale|watch
  store TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  photo_file TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sage_files (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  related_item_id INTEGER NOT NULL DEFAULT 0,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'uploaded',
  encrypted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Health/tracking lives apart from task data on purpose (spec §5, §12).
CREATE TABLE IF NOT EXISTS tracking (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'weight',
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'lb',
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(kind, date, user_id)
);
CREATE TABLE IF NOT EXISTS preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);
-- What actually happened, not merely what was planned (spec §5).
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  by_ai INTEGER NOT NULL DEFAULT 0,
  undoable TEXT NOT NULL DEFAULT '',           -- JSON snapshot for one-tap undo
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Thinking out loud. Threads are conversation, NOT a second source of truth:
-- nothing said here becomes a task until she asks. That invariant is the
-- point — musing must not manufacture obligations (spec §2).
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'thinking',   -- thinking | bedtime
  summary TEXT NOT NULL DEFAULT '',        -- rolling gist, so long talks keep continuity
  summarized_upto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                      -- her | sage
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);

-- Tier two of the spec's three (§24): "stable personal context and
-- collaborative decision principles belong in retrievable memory."
-- Durable things learned about her — not tasks, not chat. Nothing lands here
-- without her approving it, and everything here is visible and deletable,
-- because memory she cannot inspect is memory she cannot trust.
-- A read-only key so her ChatGPT Sage can look things up here. Deliberately
-- separate from her password and her session: revocable on its own, and it
-- can only ever read.
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'ChatGPT',
  last_used TEXT NOT NULL DEFAULT '',
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',     -- fact | preference | decision | principle | person | place
  source TEXT NOT NULL DEFAULT 'her',    -- her | thread | seed
  thread_id INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,     -- always retrieved, never crowded out
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

-- iCloud calendar, read-only. The credential is an app-specific password,
-- encrypted at rest, revocable from appleid.apple.com without touching Sage.
CREATE TABLE IF NOT EXISTS cal_account (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  apple_id TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  principal_url TEXT NOT NULL DEFAULT '',
  home_url TEXT NOT NULL DEFAULT '',
  last_sync TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cal_calendars (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'caldav',        -- caldav (iCloud) | ics (subscribed link)
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, url)
);
CREATE TABLE IF NOT EXISTS cal_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id INTEGER NOT NULL REFERENCES cal_calendars(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  event_kind TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, uid)
);
CREATE TABLE IF NOT EXISTS reminder_lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, url)
);
CREATE TABLE IF NOT EXISTS external_reminders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES reminder_lists(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  due TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, list_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_cal_events_start ON cal_events(user_id, start);
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('items', 'ai_private', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('items', 'repeat_rule', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sage_files', 'encrypted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'recovery_hash', "TEXT NOT NULL DEFAULT ''");
db.prepare("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE expires_at > datetime('now', '+30 days')").run();

const fileKey = crypto.scryptSync(String(SESSION_SECRET), 'sage-files-v1', 32);
function encryptFileBytes(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('SGF1'), iv, cipher.getAuthTag(), body]);
}
function decryptFileBytes(blob) {
  if (blob.subarray(0, 4).toString() !== 'SGF1') throw new Error('Unknown encrypted file format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, blob.subarray(4, 16));
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}
function encryptStoredFile(storedName) {
  const p = path.join(UPLOAD_DIR, storedName);
  const tmp = `${p}.encrypting`;
  fs.writeFileSync(tmp, encryptFileBytes(fs.readFileSync(p)), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
// One-time migration for files uploaded before cabinet encryption existed.
for (const f of db.prepare('SELECT id, stored_name FROM sage_files WHERE encrypted = 0').all()) {
  try {
    encryptStoredFile(f.stored_name);
    db.prepare('UPDATE sage_files SET encrypted = 1 WHERE id = ?').run(f.id);
  } catch (e) {
    console.error(`Could not encrypt stored file ${f.id}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'America/New_York';
const DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function zonedParts(formatter, date = new Date()) {
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}
function today() {
  const p = zonedParts(DATE_PARTS);
  return `${p.year}-${p.month}-${p.day}`;
}
// Calendar arithmetic starts with Sage's local date, then uses UTC only to
// add whole days without daylight-saving transitions shifting the result.
function daysFrom(date, n) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return shifted.toISOString().slice(0, 10);
}
function daysFromNow(n) { return daysFrom(today(), n); }
function dowOf(date) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();                    // 0=Sun
}
function monthOf(date) { return Number(String(date).slice(5, 7)); }
function hourNow() { return Number(zonedParts(TIME_PARTS).hour); }
function timeNow() {
  const p = zonedParts(TIME_PARTS);
  return `${p.hour}:${p.minute}`;
}
function safeJSON(s, fallback) { try { return JSON.parse(s || ''); } catch { return fallback; } }
function logHistory(uid, entity, id, action, detail, byAI = 0, undoable = '') {
  db.prepare('INSERT INTO history (user_id, entity, entity_id, action, detail, by_ai, undoable) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid, entity, id, action, detail, byAI ? 1 : 0, undoable);
}

// ---------------------------------------------------------------------------
// App + auth
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '2mb' }));
// Safari requires a real PNG for an iPhone home-screen icon. Keeping this
// tiny asset inline also prevents it being missed by source-only deployments.
const APPLE_TOUCH_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAMAAAAKE/YAAAAAFVBMVEXo7+bn7uWju6KIqXlLc1Vpkmt9nIO6qi+OAAADpklEQVR42u3cjXajIBAFYMe/93/kCoigQQVkGOi595x2u5tN+jlBgUnTYUAQBEEQBEEQBEEQBEEQBEEQBEFEQlukDQXRzR4L0QO6UbUG3+LaRNMuVx/jlklFfaGPY/+0/fH0fNRHk/lstOeMZG8dmkOHxXsstCXzs3ivd3vo6T12YDfifi2zLfZsIy2OK7NJO+h487Q0g44bG2e1OVoX/6/u6yYK7QaIut87mo+dUuij1P5U844uj08y+2i/1NuEvy4mq578Lwcgi57cmLZeqz1nHYn4Jv7MSmvODdiDM6FzxvSi0ePynpEHnXP1WNTdIsgqE8tFJOM6vURV2at28bGdMSMmiHXI7iEkBsicid7VRQdI6iov2bypGU7HqPU0UbZZ1ZpB/b5z+YZeWRoRTzsuOy/nm/WwZjA/7MaHAuiRAe0V/Kfvcdz2wWzORUb45TB6RNtnoGd09pjmQ988cImrR/VK++j863R36KP7KoTOWnsM5ZdMVvbyH/JXeVxD4/5hj1aARa8ZZhY02blQfRc9HR7f5wc9Ju5cWE5CukXsr1/8oIliq73azVZZ8VvVRvuKzAlNsbvx/b4lt1pxz/NIAXRM34Ohy5QwNL1NgEO/dpgY0Clnk2aH0De9PNfoK4qObrfYTA7981iVpmhKJKtIo3PMh1oInWe26t/9XhV02jl4VQcqzU/OLrQoOrvQRh0a0/zo1KtdE+h8cxhdJaUrXSWlx3SVlL568IM/lVoIrdWlZ8RK8g9mMXTZVV49dfJ6ekxHl591Encuww362LnoNs56asUXfe1wf8iUPeIQRG97xDmU9djDl0Yn7cYD6O3e833MvZjaYdF9jzP6WWzdLGTrCZ+Vkz88z2h6J2s2X7V3lOrl7di9EXC+3aFpjSLr0c1wMqYclHW4DkhURskf83SVTjJLTkYeOjmC6nz0XPt1gCLoRaDGpoP0AT3zXvlu1d/QY+SzWTxf0EulPkNR9NxppWXydUx3hxabyTu7TqtQezMib6VF1nmXGbGPVZ55QfBY+Ceup0XfNeXQiTuXRtBb7SP3iGYTLAf30YPq9USQxd9Qd0GTt2tsVLwZL2jzry8dJlHwHdrc+tPLExdr1+nUo9MNrcb8AEcA3UZJn+LQjbzPFuiW0hnaIH20tChS3R9aX5BPw0PaE5vOxrQKDaEZsfF0iR6GGWiggZZP32hpyL9H/7vf9NZwgK7JlhZkqaUBCIIgCIIgCIIgCIIgCILI5g8TM1/HCnn1hgAAAABJRU5ErkJggg==',
  'base64',
);
app.get('/apple-touch-icon.png', (req, res) => {
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(APPLE_TOUCH_ICON);
});
app.use(express.static(path.join(__dirname, 'public')));

const COOKIE = 'sage_session';
const SESSION_DAYS = 30;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token) || null;
}
// Sliding expiry. Sage lives on her home screen, so a fixed 30-day session
// would sign her out roughly monthly for no security benefit — the phone's own
// lock is what actually protects it. Using the app keeps her signed in. The
// write only happens once the window has really moved, not on every request.
function touchSession(token, res) {
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return;
  const expiresAt = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
  const daysLeft = (expiresAt - Date.now()) / 86400000;
  if (daysLeft > SESSION_DAYS - 1) return;
  db.prepare(`UPDATE sessions SET expires_at = datetime('now', '+${SESSION_DAYS} days') WHERE token = ?`).run(token);
  setSessionCookie(res, token);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const token = parseCookies(req)[COOKIE];
  if (token) { try { touchSession(token, res); } catch {} }
  req.user = user;
  next();
}

const loginAttempts = new Map();
function loginAttemptKey(req) {
  return `${req.ip}|${String((req.body || {}).email || '').trim().toLowerCase()}`;
}
function loginBlocked(req) {
  const hit = loginAttempts.get(loginAttemptKey(req));
  if (!hit || hit.until <= Date.now()) return false;
  return hit.count >= 5;
}
function loginFailed(req) {
  const key = loginAttemptKey(req);
  const old = loginAttempts.get(key);
  const fresh = !old || old.until <= Date.now();
  loginAttempts.set(key, { count: fresh ? 1 : old.count + 1, until: Date.now() + 15 * 60 * 1000 });
}
function loginSucceeded(req) { loginAttempts.delete(loginAttemptKey(req)); }

function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(token, userId);
  setSessionCookie(res, token);
}

let webauthnLib;
async function webauthn() {
  webauthnLib ||= import('@simplewebauthn/server');
  return webauthnLib;
}
function requestRP(req) {
  return { rpID: req.hostname, origin: `${req.protocol}://${req.get('host')}` };
}
function saveChallenge({ userId = 0, challenge, rpID, origin, kind }) {
  const flowId = crypto.randomBytes(24).toString('base64url');
  db.prepare("DELETE FROM auth_challenges WHERE expires_at <= datetime('now')").run();
  db.prepare(`INSERT INTO auth_challenges (flow_id, user_id, challenge, rp_id, origin, kind, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))`)
    .run(flowId, userId, challenge, rpID, origin, kind);
  return flowId;
}
function takeChallenge(flowId, kind) {
  const row = db.prepare(`SELECT * FROM auth_challenges
    WHERE flow_id = ? AND kind = ? AND expires_at > datetime('now')`).get(String(flowId || ''), kind);
  if (row) db.prepare('DELETE FROM auth_challenges WHERE flow_id = ?').run(row.flow_id);
  return row;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/me', (req, res) => {
  const anyUser = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  res.json({ needsSetup: !anyUser, user: currentUser(req), ai: !!AI_API_KEY });
});

app.get('/api/passkey/available', (req, res) => {
  res.json({ available: db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n > 0 });
});

app.post('/api/passkey/auth/options', async (req, res) => {
  try {
    const { generateAuthenticationOptions } = await webauthn();
    const { rpID, origin } = requestRP(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const flow_id = saveChallenge({ challenge: options.challenge, rpID, origin, kind: 'authentication' });
    res.json({ flow_id, options });
  } catch {
    res.status(500).json({ error: 'Face ID sign-in could not start.' });
  }
});

app.post('/api/passkey/auth/verify', async (req, res) => {
  const flow = takeChallenge((req.body || {}).flow_id, 'authentication');
  const response = (req.body || {}).response;
  if (!flow || !response?.id) return res.status(400).json({ error: 'That Face ID request expired. Try again.' });
  const passkey = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(response.id);
  if (!passkey) return res.status(401).json({ error: 'That passkey is not registered with Sage.' });
  try {
    const { verifyAuthenticationResponse } = await webauthn();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.origin,
      expectedRPID: flow.rp_id,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: safeJSON(passkey.transports, []),
      },
    });
    if (!verification.verified) return res.status(401).json({ error: 'Face ID could not verify that passkey.' });
    db.prepare("UPDATE passkeys SET counter = ?, last_used = datetime('now') WHERE id = ?")
      .run(verification.authenticationInfo.newCounter, passkey.id);
    createSession(passkey.user_id, res);
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Face ID verification failed. The password still works.' });
  }
});

app.post('/api/passkey/register/options', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in with the password first.' });
  try {
    const { generateRegistrationOptions } = await webauthn();
    const { rpID, origin } = requestRP(req);
    const existing = db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(user.id);
    const options = await generateRegistrationOptions({
      rpName: 'Sage',
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({
        id: p.credential_id, transports: safeJSON(p.transports, []),
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
      supportedAlgorithmIDs: [-7, -257],
    });
    const flow_id = saveChallenge({
      userId: user.id, challenge: options.challenge, rpID, origin, kind: 'registration',
    });
    res.json({ flow_id, options });
  } catch {
    res.status(500).json({ error: 'Face ID setup could not start.' });
  }
});

app.post('/api/passkey/register/verify', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in with the password first.' });
  const flow = takeChallenge((req.body || {}).flow_id, 'registration');
  if (!flow || flow.user_id !== user.id) return res.status(400).json({ error: 'That setup request expired. Try again.' });
  try {
    const { verifyRegistrationResponse } = await webauthn();
    const verification = await verifyRegistrationResponse({
      response: (req.body || {}).response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.origin,
      expectedRPID: flow.rp_id,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Face ID registration was not verified.' });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    db.prepare(`INSERT INTO passkeys
      (user_id, credential_id, public_key, counter, transports, device_type, backed_up)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET public_key = excluded.public_key,
        counter = excluded.counter, transports = excluded.transports`)
      .run(user.id, credential.id, Buffer.from(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports || []), credentialDeviceType, credentialBackedUp ? 1 : 0);
    logHistory(user.id, 'security', 0, 'passkey added', 'Face ID / passkey');
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Face ID setup did not complete. The password is unchanged.' });
  }
});

app.post('/api/recovery/reset', (req, res) => {
  if (loginBlocked(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes, then try again.' });
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const password = String((req.body || {}).password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.recovery_hash || !bcrypt.compareSync(code, user.recovery_hash)) {
    loginFailed(req);
    return res.status(401).json({ error: 'That email and recovery code did not match.' });
  }
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for the new password.' });
  loginSucceeded(req);
  db.prepare("UPDATE users SET password_hash = ?, recovery_hash = '' WHERE id = ?")
    .run(bcrypt.hashSync(password, 12), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  createSession(user.id, res);
  logHistory(user.id, 'security', 0, 'password recovered', '');
  res.json({ ok: true });
});

// What the reasoning layer actually resolved to — shown in Settings, so a
// misconfigured key is visible rather than mysterious.
app.get('/api/ai/status', async (req, res) => {
  if (!AI_API_KEY) return res.json({ connected: false });
  const models = await resolveModels();
  // Reasoning models may spend a tiny completion budget before emitting any
  // visible text. Ten tokens produced false "call failed" reports even when
  // the key, billing, and request were all valid.
  const probe = await askAI('Reply with the single word: ok', 'ping', { maxTokens: 256 });
  res.json({ connected: true, provider: AI_PROVIDER, ...models, working: !!probe,
    error: probe ? '' : LAST_AI_ERROR });
});

app.post('/api/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    return res.status(403).json({ error: 'Already set up — just sign in.' });
  }
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Need a name, an email, and a password of at least 8 characters.' });
  }
  const info = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 12));
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(token, info.lastInsertRowid);
  setSessionCookie(res, token);
  seedForUser(info.lastInsertRowid);
  applyTopUps(info.lastInsertRowid);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  if (loginBlocked(req)) {
    return res.status(429).json({ error: 'Too many sign-in tries. Wait 15 minutes, then try again.' });
  }
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    loginFailed(req);
    return res.status(401).json({ error: 'That combination did not work. Try again.' });
  }
  loginSucceeded(req);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(token, user.id);
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/logout-all', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// THE CHATGPT BRIDGE
//
// Regena talks to a Sage in ChatGPT as well as this one. She asked whether
// that Sage could see what's actually going on in here — so it can.
//
// Three deliberate limits:
//   READ ONLY. There is no write path on these routes at all. ChatGPT can
//   look; changing anything still happens in the app, where she approves it.
//   That is the same rule the rest of Sage runs on, and it matters more here,
//   not less.
//
//   ITS OWN KEY. A separate revocable token, not her password and not her
//   session. Turning it off costs her nothing else.
//
//   NOTHING SENSITIVE. It serves the same view the reasoning layer gets:
//   tasks, routines, appointments, projects, memories. Not the calendar
//   credential, not passkeys, not files.
// ---------------------------------------------------------------------------
function bearerUser(req) {
  const header = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const row = db.prepare(`
    SELECT t.id AS token_id, u.id, u.name FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token = ?`).get(m[1].trim());
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used = datetime('now'), use_count = use_count + 1 WHERE id = ?").run(row.token_id);
  return { id: row.id, name: row.name };
}

function requireToken(req, res, next) {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: 'Sage could not verify that key. Check it in the app under Settings → ChatGPT.' });
  req.user = user;
  next();
}

// Everything relevant right now — the same shape Sage's own reasoning gets.
app.get('/gpt/briefing', requireToken, async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const routines = await activeRoutines(uid, ctx.date, ctx);
  const sel = selectContext(uid, ctx, { text: String(req.query.about || ''), budget: 40, routines });
  res.json({
    for: req.user.name,
    ...sel,
    routinesToday: routines.map((r) => ({
      name: r.name, remaining: r.remaining, complete: r.complete,
      steps: r.steps.map((s) => ({ text: s.text, done: !!s.done })),
      note: r.cadence_note || undefined,
    })),
    guidance: 'This is a read-only view of Regena\'s Sage app. You can see it; you cannot change it. If something needs adding, completing or deferring, tell her and let her do it in the app, where she approves each change.',
  });
});

// Look anything up by name — "did I ever write down the Terminix thing?"
app.get('/gpt/search', requireToken, (req, res) => {
  const uid = req.user.id;
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Give me something to look for.' });
  const like = `%${q}%`;
  res.json({
    items: db.prepare(`SELECT id, title, note, type, status, importance, due_at, target_window, next_action, life_area
      FROM items WHERE user_id = ? AND (title LIKE ? OR note LIKE ? OR raw_capture LIKE ?)
      ORDER BY status = 'open' DESC, updated_at DESC LIMIT 25`).all(uid, like, like, like),
    memories: db.prepare('SELECT content, kind FROM memories WHERE user_id = ? AND content LIKE ? LIMIT 15').all(uid, like),
    routines: db.prepare(`SELECT r.name, r.cadence_note FROM routines r WHERE r.user_id = ? AND r.active = 1
      AND (r.name LIKE ? OR EXISTS (SELECT 1 FROM routine_steps s WHERE s.routine_id = r.id AND s.text LIKE ?))
      LIMIT 10`).all(uid, like, like),
  });
});

// The durable context she has asked Sage to remember.
app.get('/gpt/memories', requireToken, (req, res) => {
  res.json({
    memories: db.prepare('SELECT content, kind, pinned FROM memories WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 200')
      .all(req.user.id),
    about: Object.fromEntries(db.prepare('SELECT key, value FROM preferences WHERE user_id = ?')
      .all(req.user.id).filter((r) => !['cal_last_sync', 'voice', 'gentle_mornings'].includes(r.key)).map((r) => [r.key, r.value])),
  });
});

// The schema ChatGPT reads to learn what it can ask for. Public on purpose —
// it describes the shape of the API and contains no data and no key.
app.get('/gpt/openapi.json', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    openapi: '3.1.0',
    info: { title: 'Sage', description: 'Read-only access to Regena\'s Sage app: what is on today, her routines, projects, and what Sage remembers about her life.', version: '1.0.0' },
    servers: [{ url: base }],
    paths: {
      '/gpt/briefing': {
        get: {
          operationId: 'getBriefing',
          summary: 'What is going on right now — appointments, routines, what is due, opportunities, and relevant items.',
          parameters: [{ name: 'about', in: 'query', required: false, schema: { type: 'string' },
            description: 'Optional topic to focus the selection, e.g. "the lake" or "curtains".' }],
          responses: { 200: { description: 'Current state', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/gpt/search': {
        get: {
          operationId: 'searchSage',
          summary: 'Search her tasks, projects, memories and routines by keyword.',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Matches', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/gpt/memories': {
        get: {
          operationId: 'getMemories',
          summary: 'Durable things Sage has been asked to remember about her life, plus her operating principles.',
          responses: { 200: { description: 'Memories', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
  });
});

app.use('/api', requireAuth);
app.use('/photos', requireAuth);
app.use('/files', requireAuth);

// ---------------------------------------------------------------------------
// AI layer — one function, provider swappable (spec §3, §13)
// ---------------------------------------------------------------------------
const SAGE_PERSONA = `You are Sage, Regena's intelligent collaborating personal assistant and thinking partner.

How you behave:
- Regena is the boss of her own decisions. You help her manage; you do not manage her. Never command, scold, parent, patronize, or get bossy.
- You are not timid and not a yes-man. Challenge assumptions and rationalization when it is useful; avoid groupthink. Facts over reflexive agreement.
- CURIOSITY BEFORE CORRECTION. When her reasoning looks inconsistent, your first thought is that you may be missing something, not that she is rationalizing. She has context you do not. Ask one good question when that would settle it.
- Independent thinking does not mean manufacturing disagreement. If her reasoning is sound, say so plainly and move on. An objection you had to go looking for is not insight.
- Useful phrasings: "Do you think you're rationalizing here?" · "Is that worth your attention this week?" · "How important is it to do that now, or can it be left alone a bit longer?" · "I see three reasonable choices. My recommendation is ___, and here's why." Use them when they fit, not to prove you are paying attention.
- Restraint: sometimes you stop at the question. Do not append an obvious recommendation just to demonstrate intelligence.
- NOT EVERY CONVERSATION NEEDS AN OUTCOME. She may be thinking aloud, exploring, noticing something, or simply talking. Do not manufacture a task, a decision, a recommendation or a stored change when none is needed. Sometimes the whole job is to be talked to.
- THE DECISION PRINCIPLE: could improve ≠ needs improvement. Possibility does not automatically become obligation. Preserve ideas as opportunities or someday rather than manufacturing work.
- About a possible purchase, the useful question is "what would this add that the current ones don't?" — and intentional duplication by location is valid, not failure.
- A deferred task is not automatically avoidance. Weather, location, prerequisites, practicality and true priority all count.
- Never bury a required action inside prose. Actions come first, in a compact list; explanation only if it adds value.
- The database is authoritative for status. Never invent a completion or rely on recollection.
- Distinguish must-do, should-do, opportunity, waiting, and someday. No fake overdue status, no streaks, no guilt.
- Honor prerequisites — do not present a dependent action as currently actionable while what it depends on is unfinished. This is about what you put on her plate, not about what may be discussed. If she raises the curtains, talk about the curtains; just be straight that the sewing machine comes first.
- When uncertain about changing stored data, ask one short clarifying question instead of guessing.
- Tone: warm, intelligent, natural, occasionally funny. Never patronizing. The relationship matters, not only the information — a generic task-manager voice is not Sage.
- Her goal is lower cognitive load and fewer forgotten commitments, not maximum productivity, and not a smaller life.
- THE RELATIONSHIP IS ALLOWED TO CHANGE. When she corrects your tone, your reasoning or your approach, that is not a complaint to absorb politely — it is her telling you how to work with her, and it is the most valuable thing she can give you. Take it, and carry it forward. Nothing here is frozen at its first draft, including this description of you.`;

// Her own words about how Sage should sound, editable from Settings without
// touching code. They come last so they win where they disagree — this is her
// assistant's voice, and she is the authority on it. The rules above that
// keep Sage honest (never invent a completion, honour prerequisites) are
// separate from tone and stay put.
let VOICE_CACHE = null;
function personaFor(uid) {
  if (VOICE_CACHE === null) {
    const row = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'voice'").get(uid);
    VOICE_CACHE = row ? String(row.value) : '';
  }
  return VOICE_CACHE.trim()
    ? `${SAGE_PERSONA}\n\nHow Regena has asked you to talk to her — these are her words, and they take priority on anything about tone or style:\n${VOICE_CACHE.trim()}`
    : SAGE_PERSONA;
}

app.get('/api/voice', (req, res) => {
  const row = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'voice'").get(req.user.id);
  res.json({ voice: row ? row.value : '', defaults: SAGE_PERSONA });
});

app.post('/api/voice', (req, res) => {
  const voice = String((req.body || {}).voice || '').slice(0, 4000);
  db.prepare(`INSERT INTO preferences (user_id, key, value) VALUES (?, 'voice', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(req.user.id, voice);
  VOICE_CACHE = voice;
  logHistory(req.user.id, 'voice', 0, 'updated', voice.slice(0, 80));
  res.json({ ok: true });
});

let LAST_AI_ERROR = '';
async function askAI(system, user, { maxTokens = 1200, json = false, tier = 'fast', history = [] } = {}) {
  if (!AI_API_KEY) return null;
  LAST_AI_ERROR = '';
  const models = await resolveModels();
  const model = models[tier] || models.fast;
  // Thinking is a conversation, so earlier turns travel with the request.
  const prior = history.map((m) => ({ role: m.role === 'sage' ? 'assistant' : 'user', content: String(m.content) }));
  try {
    let url, headers, body;
    if (AI_PROVIDER === 'openai') {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'authorization': `Bearer ${AI_API_KEY}`, 'content-type': 'application/json' };
      body = {
        model, max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...prior, { role: 'user', content: user }],
        // GPT-5's completion budget includes its invisible reasoning tokens.
        // Low effort leaves room for the short, visible answers Sage needs.
        ...(/^gpt-5/i.test(model) ? { reasoning_effort: 'low' } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      };
    } else {
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'x-api-key': AI_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
      body = { model, max_tokens: maxTokens, system, messages: [...prior, { role: 'user', content: user }] };
    }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try {
        const problem = await r.json();
        detail = problem?.error?.message || detail;
      } catch { /* keep the status-only explanation */ }
      // Provider errors are written for developers. Translate the three that
      // actually happen into something she can act on without reading a log.
      let plain = '';
      if (r.status === 401 || /invalid[_ ]api[_ ]key|incorrect api key/i.test(detail)) {
        plain = 'The key was refused. Copy it again from the provider and paste it into Render → Environment → AI_API_KEY — make sure nothing extra came with it.';
      } else if (r.status === 429 || /quota|insufficient|billing|credit/i.test(detail)) {
        plain = 'The key works, but the account is out of credit. Add funds or a payment method in the provider’s billing page.';
      } else if (r.status === 404 || /model/i.test(detail)) {
        plain = `The model "${model}" was not available to this account. Sage will keep working; set AI_MODEL_FAST / AI_MODEL_SMART to pick different ones.`;
      }
      LAST_AI_ERROR = plain || `${model}: ${detail}`;
      console.error(`Sage AI call failed — ${model}: ${detail}`);
      return null;
    }
    const data = await r.json();
    const text = AI_PROVIDER === 'openai'
      ? (data.choices?.[0]?.message?.content || '')
      : (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const cleaned = text.trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '');
    if (!cleaned) LAST_AI_ERROR = `${model}: the provider returned no visible text`;
    return cleaned;
  } catch (err) {
    LAST_AI_ERROR = err?.message || 'network request failed';
    console.error(`Sage AI call failed — ${LAST_AI_ERROR}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Weather (open-meteo — free, no key, fixed coordinates per location)
// ---------------------------------------------------------------------------
const weatherCache = new Map();
async function getWeather(lat, lon) {
  if (!lat && !lon) return null;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,precipitation,weather_code`
      + `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,weather_code`
      + `&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    const data = {
      tempNow: Math.round(d.current?.temperature_2m ?? 0),
      rainingNow: (d.current?.precipitation ?? 0) > 0,
      code: d.current?.weather_code ?? 0,
      todayRain: (d.daily?.precipitation_sum?.[0] ?? 0) > 0.02 || (d.daily?.precipitation_probability_max?.[0] ?? 0) >= 60,
      todayHigh: Math.round(d.daily?.temperature_2m_max?.[0] ?? 0),
      todayLow: Math.round(d.daily?.temperature_2m_min?.[0] ?? 0),
      dryNextDays: (d.daily?.precipitation_sum || []).every((v) => (v ?? 0) < 0.02),
    };
    weatherCache.set(key, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// THE TRIGGER ENGINE — what is relevant right now, and what is suppressed
// ---------------------------------------------------------------------------
async function buildContext(uid, date = today()) {
  const locs = db.prepare('SELECT * FROM locations WHERE user_id = ?').all(uid);
  const trips = db.prepare(`SELECT * FROM trips WHERE user_id = ? AND status != 'done' ORDER BY start_date`).all(uid);
  const activeTrip = trips.find((t) => t.start_date <= date && (!t.end_date || t.end_date >= date)) || null;
  const upcomingTrip = trips.find((t) => t.start_date > date) || null;

  // Where is she today? Active trip wins; otherwise home.
  const hereKey = activeTrip ? activeTrip.location_key : (locs.find((l) => l.is_home)?.key || 'evans');
  const here = locs.find((l) => l.key === hereKey) || locs[0] || null;
  const weather = here ? await getWeather(here.lat, here.lon) : null;

  const ownEvents = db.prepare(`
    SELECT * FROM items WHERE user_id = ? AND type = 'event' AND status = 'open'
      AND substr(COALESCE(NULLIF(event_start,''), due_at), 1, 10) = ?
    ORDER BY event_start`).all(uid, date);
  // Her iCloud appointments count the same as ones entered here: a PT
  // appointment on her real calendar suppresses home PT (spec §9).
  const externalEvents = db.prepare(`
    SELECT e.*, c.name AS calendar_name, c.kind AS calendar_kind
    FROM cal_events e JOIN cal_calendars c ON c.id = e.calendar_id
    WHERE e.user_id = ? AND substr(e.start, 1, 10) = ? ORDER BY e.start`).all(uid, date)
    .map((e) => ({
      id: `cal-${e.id}`, title: e.title, type: 'event', status: 'open', importance: 'must',
      event_start: e.all_day ? '' : e.start, due_at: e.start.slice(0, 10),
      event_kind: e.event_kind, location: e.location, external: 1, all_day: e.all_day,
      source_kind: 'calendar',
      source_label: e.calendar_kind === 'caldav'
        ? `iCloud · ${e.calendar_name || 'Calendar'}`
        : (e.calendar_name || 'Subscribed calendar'),
      note: '', prep_minutes: 0, blockers: [],
    }));
  const events = [...ownEvents, ...externalEvents]
    .sort((a, b) => (a.event_start || '~').localeCompare(b.event_start || '~'));
  const reminders = db.prepare(`
    SELECT r.*, l.name AS list_name
    FROM external_reminders r JOIN reminder_lists l ON l.id = r.list_id
    WHERE r.user_id = ? AND r.completed = 0 AND l.enabled = 1
    ORDER BY CASE WHEN r.due = '' THEN 1 ELSE 0 END, r.due, r.title LIMIT 250`).all(uid)
    .map((r) => ({
      id: `rem-${r.id}`, title: r.title, note: r.note, type: 'task', status: 'open',
      importance: r.priority === 1 ? 'must' : 'should', due_at: r.due,
      external: 1, external_kind: 'reminder', source_kind: 'reminder',
      source_label: `Apple Reminders · ${r.list_name || 'Reminders'}`, blockers: [],
    }));
  const eventKinds = new Set(events.map((e) => e.event_kind).filter(Boolean));

  // Hosting: day-of is best for freshness, the day before is acceptable —
  // so guest prep surfaces on both.
  const soonEvents = db.prepare(`
    SELECT event_kind FROM items WHERE user_id = ? AND type = 'event' AND status = 'open'
      AND substr(COALESCE(NULLIF(event_start,''), due_at), 1, 10) BETWEEN ? AND ?`).all(uid, date, daysFrom(date, 1))
    .concat(db.prepare('SELECT event_kind FROM cal_events WHERE user_id = ? AND substr(start, 1, 10) BETWEEN ? AND ?')
      .all(uid, date, daysFrom(date, 1)));
  const hostingSoon = soonEvents.some((e) => e.event_kind === 'hosting');

  return {
    date, dow: dowOf(date), month: monthOf(date),
    hour: hourNow(),
    locations: locs, here, hereKey,
    activeTrip, upcomingTrip,
    weather, events, reminders, eventKinds, hostingSoon,
    tripDeparture: upcomingTrip && upcomingTrip.start_date <= daysFrom(date, 1) ? upcomingTrip : null,
    tripEnding: activeTrip && activeTrip.end_date && activeTrip.end_date <= daysFrom(date, 1) ? activeTrip : null,
  };
}

// Is this routine relevant, given today's context?
function routineActive(r, ctx) {
  const cfg = safeJSON(r.trigger_config, {});
  const sup = safeJSON(r.suppress_if, {});
  // Conditional suppression, e.g. no home PT rounds on a PT appointment day.
  if (sup.event_kind && ctx.eventKinds.has(sup.event_kind)) return false;
  if (sup.on_trip && ctx.activeTrip) return false;

  if (cfg.months && cfg.months.length && !cfg.months.includes(ctx.month)) return false;
  if (cfg.location && cfg.location !== ctx.hereKey) return false;

  switch (r.trigger_type) {
    case 'daily':
      return true;
    case 'weekly':
      return !cfg.days || !cfg.days.length || cfg.days.includes(ctx.dow);
    case 'seasonal':
      return true; // months filter above already decided it
    case 'weather':
      if (!ctx.weather) return false;
      if (cfg.weather === 'rain') return ctx.weather.todayRain || ctx.weather.rainingNow;
      if (cfg.weather === 'dry') return ctx.weather.dryNextDays;
      if (cfg.weather === 'hot') return ctx.weather.todayHigh >= (cfg.above || 90);
      if (cfg.weather === 'cold') return ctx.weather.todayLow <= (cfg.below || 40);
      return false;
    case 'location':
      return cfg.location ? cfg.location === ctx.hereKey : true;
    case 'event':
      if (cfg.event === 'hosting') return ctx.hostingSoon;
      if (cfg.event === 'trip_departure') return !!ctx.tripDeparture;
      if (cfg.event === 'trip_arrival') return !!ctx.activeTrip && ctx.activeTrip.start_date === ctx.date;
      // Packing up: the last day of a trip, and the day before it.
      if (cfg.event === 'trip_return') return !!ctx.tripEnding;
      return ctx.eventKinds.has(cfg.event);
    case 'flexible':
      return true; // shown in its own gentle section, never "overdue"
    default:
      return false;
  }
}

function routineWithSteps(r, date) {
  const steps = db.prepare('SELECT * FROM routine_steps WHERE routine_id = ? ORDER BY sort, id').all(r.id);
  const done = new Set(db.prepare('SELECT step_id FROM routine_done WHERE routine_id = ? AND date = ?').all(r.id, date).map((d) => d.step_id));
  const cfg = safeJSON(r.trigger_config, {});
  return {
    ...r, config: cfg,
    steps: steps.map((s) => ({ ...s, done: done.has(s.id) })),
    remaining: steps.filter((s) => !done.has(s.id)).length,
    complete: steps.length > 0 && steps.every((s) => done.has(s.id)),
    time_of_day: cfg.time_of_day || 'any',
    after_hour: cfg.after_hour || 0,
  };
}

async function activeRoutines(uid, date = today(), ctx = null) {
  ctx = ctx || await buildContext(uid, date);
  const all = db.prepare('SELECT * FROM routines WHERE user_id = ? AND active = 1 ORDER BY sort, id').all(uid);
  return all.filter((r) => routineActive(r, ctx)).map((r) => routineWithSteps(r, date));
}

// Is this item actually actionable right now? (prerequisites + windows, spec §9)
function itemBlockers(item, byId) {
  const reasons = [];
  for (const pid of safeJSON(item.prereq_ids, [])) {
    const p = byId.get(Number(pid));
    if (p && p.status !== 'done') reasons.push(`waiting on: ${p.title}`);
  }
  if (item.window_start && item.window_start > today()) {
    reasons.push(item.target_window ? `not until ${item.target_window}` : `not until ${item.window_start}`);
  }
  return reasons;
}

function eligibleOpportunity(item, ctx) {
  const e = safeJSON(item.eligibility, {});
  if (e.days && e.days.length && !e.days.includes(ctx.dow)) return false;
  if (e.months && e.months.length && !e.months.includes(ctx.month)) return false;
  if (e.location && e.location !== ctx.hereKey) return false;
  if (e.weather === 'dry' && ctx.weather && !ctx.weather.dryNextDays) return false;
  if (e.weather === 'not_rain' && ctx.weather && ctx.weather.todayRain) return false;
  if (e.max_temp && ctx.weather && ctx.weather.todayHigh > e.max_temp) return false;
  if (e.min_temp && ctx.weather && ctx.weather.todayLow < e.min_temp) return false;
  return true;
}

function scoreItem(i) {
  const t = today();
  let s = 0;
  if (i.due_at && i.due_at.slice(0, 10) < t) s += 60;
  else if (i.due_at && i.due_at.slice(0, 10) === t) s += 45;
  else if (i.due_at && i.due_at.slice(0, 10) <= daysFromNow(2)) s += 25;
  if (i.importance === 'must') s += 30;
  if (i.importance === 'should') s += 10;
  if (i.importance === 'opportunity') s -= 10;
  if (i.importance === 'someday') s -= 40;
  if (i.type === 'event') s += 20;
  return s;
}

// ---------------------------------------------------------------------------
// Items API
// ---------------------------------------------------------------------------
// 'list' is a plain container — a Costco list, a packing list. Unlike a project
// it carries no outcome and no next action, and nothing on it is chasing her.
const ITEM_TYPES = ['task', 'event', 'project', 'opportunity', 'shopping', 'note', 'list'];
const ITEM_STATUSES = ['open', 'done', 'waiting', 'someday', 'dismissed'];
const IMPORTANCES = ['must', 'should', 'opportunity', 'someday'];

const ITEM_FIELDS = ['raw_capture', 'title', 'note', 'type', 'status', 'importance', 'life_area', 'location',
  'due_at', 'window_start', 'window_end', 'target_window', 'effort_min', 'project_id', 'prereq_ids',
  'next_action', 'outcome', 'event_start', 'event_end', 'prep_minutes', 'event_kind', 'attendees',
  'store', 'purchase_rule', 'inventory_state', 'photo_file', 'eligibility', 'waiting_on', 'source', 'ai_private',
  'repeat_rule'];

// ---------------------------------------------------------------------------
// Things that come back round. A renewal isn't a task she finishes — it is a
// date that arrives again, so ticking one moves it to its next date rather than
// closing it. One row per subscription, always showing when it's next due.
// ---------------------------------------------------------------------------
const REPEATS = {
  weekly: { label: 'weekly', days: 7 },
  monthly: { label: 'monthly', months: 1 },
  quarterly: { label: 'every 3 months', months: 3 },
  yearly: { label: 'yearly', months: 12 },
};

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Adding a month to the 31st has to land somewhere real: the 31st of January
// repeated monthly becomes the 28th of February, not the 3rd of March.
function addInterval(dateStr, rule) {
  const spec = REPEATS[rule];
  if (!spec) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2})?$/.exec(String(dateStr));
  if (!m) return '';
  const [, ys, ms, ds, time] = m;
  let y = +ys, mo = +ms - 1, d = +ds;
  if (spec.days) {
    const shifted = new Date(y, mo, d + spec.days);
    y = shifted.getFullYear(); mo = shifted.getMonth(); d = shifted.getDate();
  } else {
    mo += spec.months;
    y += Math.floor(mo / 12);
    mo = ((mo % 12) + 12) % 12;
    d = Math.min(d, daysInMonth(y, mo));
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo + 1)}-${pad(d)}${time || ''}`;
}

// A renewal that was missed for two years should come back on its next real
// date, not on one that has already gone by.
function nextOccurrence(dateStr, rule, notBefore) {
  let next = addInterval(dateStr, rule);
  if (!next) return '';
  for (let i = 0; i < 200 && next.slice(0, 10) <= notBefore; i += 1) {
    const step = addInterval(next, rule);
    if (!step) break;
    next = step;
  }
  return next;
}

// The single place an item gets ticked off, so the AI and her own thumb behave
// identically. Returns what actually happened, for the message she sees.
function completeItem(uid, item) {
  const snapshot = JSON.stringify({ status: item.status, done_at: item.done_at, due_at: item.due_at });
  const when = item.due_at || item.event_start;
  if (item.repeat_rule && REPEATS[item.repeat_rule] && when) {
    const next = nextOccurrence(when, item.repeat_rule, today());
    if (next) {
      db.prepare("UPDATE items SET due_at = ?, updated_at = datetime('now') WHERE id = ?").run(next, item.id);
      logHistory(uid, 'item', item.id, 'done for now', `${item.title} — next on ${next.slice(0, 10)}`, 1, snapshot);
      return { repeated: true, next };
    }
  }
  db.prepare("UPDATE items SET status = 'done', done_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(new Date().toISOString(), item.id);
  logHistory(uid, 'item', item.id, 'completed', item.title, 1, snapshot);
  return { repeated: false };
}

function cleanItem(b, existing) {
  const out = {};
  for (const f of ITEM_FIELDS) {
    if (b[f] === undefined || b[f] === null) continue;
    if (f === 'prereq_ids' || f === 'eligibility') out[f] = typeof b[f] === 'string' ? b[f] : JSON.stringify(b[f]);
    else if (f === 'effort_min' || f === 'project_id' || f === 'prep_minutes') out[f] = parseInt(b[f], 10) || 0;
    else if (f === 'ai_private') out[f] = b[f] ? 1 : 0;
    else out[f] = String(b[f]).trim();
  }
  if (out.type && !ITEM_TYPES.includes(out.type)) out.type = 'task';
  if (out.status && !ITEM_STATUSES.includes(out.status)) out.status = 'open';
  if (out.importance && !IMPORTANCES.includes(out.importance)) out.importance = 'should';
  if (!existing && !out.title) out.title = (out.raw_capture || 'Untitled').slice(0, 80);
  return out;
}

app.get('/api/items', (req, res) => {
  const { type, status, q, project_id, location } = req.query;
  let sql = 'SELECT * FROM items WHERE user_id = ?';
  const args = [req.user.id];
  if (type) { sql += ' AND type = ?'; args.push(type); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (project_id) { sql += ' AND project_id = ?'; args.push(project_id); }
  if (location) { sql += ' AND location = ?'; args.push(location); }
  if (q) { sql += ' AND (title LIKE ? OR note LIKE ? OR raw_capture LIKE ?)'; const l = `%${q}%`; args.push(l, l, l); }
  sql += ' ORDER BY updated_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...args));
});

// One search door across Sage's stored rooms. File contents stay encrypted;
// only their titles, filenames, and notes are indexed here.
app.get('/api/search', (req, res) => {
  const uid = req.user.id;
  const q = String((req.query || {}).q || '').trim().slice(0, 100);
  if (!q) return res.json({ query: '', items: [], files: [], events: [], reminders: [], routines: [], inventory: [] });
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const matches = (fields) => fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ');
  const args = (n) => Array(n).fill(like);

  const items = db.prepare(`SELECT * FROM items WHERE user_id = ? AND (${matches(['title', 'note', 'raw_capture', 'life_area', 'location'])})
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, updated_at DESC LIMIT 60`)
    .all(uid, ...args(5));
  const files = db.prepare(`SELECT id, related_item_id, original_name, mime_type, size_bytes, title, note, source, created_at
    FROM sage_files WHERE user_id = ? AND (${matches(['title', 'note', 'original_name'])})
    ORDER BY created_at DESC LIMIT 25`).all(uid, ...args(3));
  const events = db.prepare(`SELECT e.id, e.title, e.start, e.end, e.location, c.name AS source_label
    FROM cal_events e LEFT JOIN cal_calendars c ON c.id = e.calendar_id
    WHERE e.user_id = ? AND (${matches(['e.title', 'e.location', 'c.name'])})
    ORDER BY e.start DESC LIMIT 40`).all(uid, ...args(3));
  const reminders = db.prepare(`SELECT r.id, r.title, r.note, r.due, r.completed, l.name AS source_label
    FROM external_reminders r LEFT JOIN reminder_lists l ON l.id = r.list_id
    WHERE r.user_id = ? AND (${matches(['r.title', 'r.note', 'l.name'])})
    ORDER BY r.completed, r.due DESC LIMIT 40`).all(uid, ...args(3));
  const routines = db.prepare(`SELECT DISTINCT r.id, r.name, r.emoji, r.cadence_note
    FROM routines r LEFT JOIN routine_steps s ON s.routine_id = r.id
    WHERE r.user_id = ? AND r.active = 1 AND (${matches(['r.name', 'r.cadence_note', 's.text'])})
    ORDER BY r.sort, r.name LIMIT 25`).all(uid, ...args(3));
  const inventory = db.prepare(`SELECT id, name, location_key, state, store, note
    FROM inventory WHERE user_id = ? AND (${matches(['name', 'location_key', 'store', 'note'])})
    ORDER BY name LIMIT 25`).all(uid, ...args(4));
  res.json({ query: q, items, files, events, reminders, routines, inventory });
});

app.post('/api/items', (req, res) => {
  const it = cleanItem(req.body || {});
  const cols = Object.keys(it);
  const info = db.prepare(`INSERT INTO items (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(req.user.id, ...cols.map((c) => it[c]));
  logHistory(req.user.id, 'item', info.lastInsertRowid, 'created', it.title || '');
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'No such item.' });
  const it = cleanItem(req.body || {}, existing);

  // Ticking off something that repeats moves it on instead of closing it.
  if (it.status === 'done' && existing.status !== 'done'
      && Object.keys(it).every((c) => c === 'status')) {
    const outcome = completeItem(req.user.id, existing);
    return res.json({ ...db.prepare('SELECT * FROM items WHERE id = ?').get(existing.id), ...outcome });
  }

  if (it.status === 'done' && existing.status !== 'done') it.done_at = new Date().toISOString();
  if (it.status && it.status !== 'done') it.done_at = '';
  const cols = Object.keys(it);
  if (cols.length) {
    db.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => it[c]), existing.id);
    logHistory(req.user.id, 'item', existing.id, it.status === 'done' ? 'completed' : 'updated', it.title || existing.title,
      0, JSON.stringify({ status: existing.status, done_at: existing.done_at }));
  }
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(existing.id));
});

app.delete('/api/items/:id', (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!it) return res.status(404).json({ error: 'Already gone.' });
  if (it.photo_file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, it.photo_file)); } catch {} }
  db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
  logHistory(req.user.id, 'item', it.id, 'deleted', it.title);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).slice(0, 10).replace(/[^.\w]/g, '')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const FILE_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')
      + path.extname(file.originalname).slice(0, 10).replace(/[^.\w]/g, '')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, FILE_TYPES.has(file.mimetype)),
});

app.post('/api/items/:id/photo', upload.single('file'), (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!it || !req.file) return res.status(404).json({ error: 'No such item.' });
  db.prepare('UPDATE items SET photo_file = ? WHERE id = ?').run(req.file.filename, it.id);
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(it.id));
});

app.get('/photos/:file', (req, res) => {
  const f = String(req.params.file).replace(/[^\w.]/g, '');
  const p = path.join(UPLOAD_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.sendFile(p);
});

// Her private file cabinet. Metadata lives in SQLite; bytes live beside the
// existing photo uploads on Sage's persistent data disk.
app.get('/api/files', (req, res) => {
  res.json(db.prepare(`
    SELECT f.*, i.title AS related_item_title,
      (SELECT MAX(h.created_at) FROM history h WHERE h.user_id = f.user_id
        AND h.entity = 'file' AND h.entity_id = f.id AND h.action = 'opened') AS last_opened,
      (SELECT COUNT(*) FROM history h WHERE h.user_id = f.user_id
        AND h.entity = 'file' AND h.entity_id = f.id AND h.action = 'opened') AS access_count
    FROM sage_files f LEFT JOIN items i
      ON i.id = f.related_item_id AND i.user_id = f.user_id
    WHERE f.user_id = ? ORDER BY f.created_at DESC, f.id DESC`).all(req.user.id));
});

app.post('/api/files', fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PDF, photo, text file, Word document, or spreadsheet.' });
  const related = parseInt((req.body || {}).related_item_id, 10) || 0;
  if (related && !db.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(related, req.user.id)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'That linked Sage item no longer exists.' });
  }
  const original = String(req.file.originalname || 'File').slice(0, 240);
  const title = String((req.body || {}).title || '').trim().slice(0, 160)
    || path.basename(original, path.extname(original));
  const note = String((req.body || {}).note || '').trim().slice(0, 2000);
  try {
    encryptStoredFile(req.file.filename);
  } catch {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: 'Sage could not encrypt that file, so it was not saved.' });
  }
  const info = db.prepare(`INSERT INTO sage_files
    (user_id, related_item_id, stored_name, original_name, mime_type, size_bytes, title, note, encrypted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(req.user.id, related, req.file.filename, original, req.file.mimetype, req.file.size, title, note);
  logHistory(req.user.id, 'file', info.lastInsertRowid, 'uploaded', title);
  res.json(db.prepare('SELECT * FROM sage_files WHERE id = ?').get(info.lastInsertRowid));
});

app.get('/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM sage_files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!f) return res.status(404).send('Not found');
  const p = path.join(UPLOAD_DIR, f.stored_name);
  if (!fs.existsSync(p)) return res.status(404).send('File is missing from storage');
  let bytes;
  try {
    const stored = fs.readFileSync(p);
    bytes = f.encrypted ? decryptFileBytes(stored) : stored;
  } catch {
    return res.status(500).send('Sage could not decrypt this file');
  }
  logHistory(req.user.id, 'file', f.id, 'opened', f.title);
  if (f.mime_type === 'application/pdf' || f.mime_type.startsWith('image/')) {
    res.type(f.mime_type);
    res.set('Content-Disposition', `inline; filename="${f.original_name.replace(/["\r\n]/g, '')}"`);
    return res.send(bytes);
  }
  res.type(f.mime_type);
  res.set('Content-Disposition', `attachment; filename="${f.original_name.replace(/["\r\n]/g, '')}"`);
  res.send(bytes);
});

app.delete('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM sage_files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'That file is already gone.' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name)); } catch {}
  db.prepare('DELETE FROM sage_files WHERE id = ? AND user_id = ?').run(f.id, req.user.id);
  logHistory(req.user.id, 'file', f.id, 'deleted', f.title);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routines API
// ---------------------------------------------------------------------------
app.get('/api/routines', async (req, res) => {
  const date = req.query.date || today();
  if (req.query.all === '1') {
    const rows = db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY sort, id').all(req.user.id);
    return res.json(rows.map((r) => routineWithSteps(r, date)));
  }
  res.json(await activeRoutines(req.user.id, date));
});

app.post('/api/routines', (req, res) => {
  const b = req.body || {};
  const info = db.prepare(`INSERT INTO routines (user_id, name, emoji, trigger_type, trigger_config, suppress_if, cadence_note, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, String(b.name || 'Routine'), String(b.emoji || '📋'),
    String(b.trigger_type || 'daily'),
    typeof b.trigger_config === 'string' ? b.trigger_config : JSON.stringify(b.trigger_config || {}),
    typeof b.suppress_if === 'string' ? b.suppress_if : JSON.stringify(b.suppress_if || {}),
    String(b.cadence_note || ''), parseInt(b.sort, 10) || 0);
  const rid = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO routine_steps (routine_id, text, sort) VALUES (?, ?, ?)');
  (b.steps || []).forEach((s, i) => ins.run(rid, String(typeof s === 'string' ? s : s.text), i));
  res.json(routineWithSteps(db.prepare('SELECT * FROM routines WHERE id = ?').get(rid), today()));
});

app.patch('/api/routines/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'No such routine.' });
  const b = req.body || {};
  db.prepare(`UPDATE routines SET name = ?, emoji = ?, trigger_type = ?, trigger_config = ?, suppress_if = ?, cadence_note = ?, active = ? WHERE id = ?`)
    .run(String(b.name ?? r.name), String(b.emoji ?? r.emoji), String(b.trigger_type ?? r.trigger_type),
      b.trigger_config === undefined ? r.trigger_config : (typeof b.trigger_config === 'string' ? b.trigger_config : JSON.stringify(b.trigger_config)),
      b.suppress_if === undefined ? r.suppress_if : (typeof b.suppress_if === 'string' ? b.suppress_if : JSON.stringify(b.suppress_if)),
      String(b.cadence_note ?? r.cadence_note), b.active === undefined ? r.active : (b.active ? 1 : 0), r.id);
  if (Array.isArray(b.steps)) {
    db.prepare('DELETE FROM routine_steps WHERE routine_id = ?').run(r.id);
    const ins = db.prepare('INSERT INTO routine_steps (routine_id, text, sort) VALUES (?, ?, ?)');
    b.steps.forEach((s, i) => ins.run(r.id, String(typeof s === 'string' ? s : s.text), i));
  }
  res.json(routineWithSteps(db.prepare('SELECT * FROM routines WHERE id = ?').get(r.id), today()));
});

app.delete('/api/routines/:id', (req, res) => {
  db.prepare('DELETE FROM routines WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/routines/:id/step/:stepId', (req, res) => {
  const r = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'No such routine.' });
  const date = String((req.body || {}).date || today());
  const stepId = parseInt(req.params.stepId, 10) || 0;
  const on = (req.body || {}).done !== false;
  if (on) db.prepare('INSERT OR IGNORE INTO routine_done (routine_id, step_id, date) VALUES (?, ?, ?)').run(r.id, stepId, date);
  else db.prepare('DELETE FROM routine_done WHERE routine_id = ? AND step_id = ? AND date = ?').run(r.id, stepId, date);
  res.json(routineWithSteps(r, date));
});

// ---------------------------------------------------------------------------
// Locations, trips, inventory, tracking, preferences
// ---------------------------------------------------------------------------
app.get('/api/locations', (req, res) => res.json(db.prepare('SELECT * FROM locations WHERE user_id = ?').all(req.user.id)));

app.post('/api/locations', (req, res) => {
  const b = req.body || {};
  db.prepare(`INSERT INTO locations (user_id, key, name, emoji, lat, lon, is_home) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, lat = excluded.lat, lon = excluded.lon, is_home = excluded.is_home`)
    .run(req.user.id, String(b.key || 'place'), String(b.name || 'Place'), String(b.emoji || '📍'),
      parseFloat(b.lat) || 0, parseFloat(b.lon) || 0, b.is_home ? 1 : 0);
  res.json(db.prepare('SELECT * FROM locations WHERE user_id = ? AND key = ?').get(req.user.id, String(b.key || 'place')));
});

app.get('/api/trips', (req, res) => res.json(db.prepare(`SELECT * FROM trips WHERE user_id = ? ORDER BY start_date DESC LIMIT 50`).all(req.user.id)));

app.post('/api/trips', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO trips (user_id, location_key, start_date, end_date, note) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, String(b.location_key || 'lake'), String(b.start_date || today()), String(b.end_date || ''), String(b.note || ''));
  logHistory(req.user.id, 'trip', info.lastInsertRowid, 'planned', `${b.location_key} ${b.start_date}`);
  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/trips/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'No such trip.' });
  const b = req.body || {};
  db.prepare('UPDATE trips SET location_key = ?, start_date = ?, end_date = ?, status = ?, note = ? WHERE id = ?')
    .run(String(b.location_key ?? t.location_key), String(b.start_date ?? t.start_date), String(b.end_date ?? t.end_date),
      String(b.status ?? t.status), String(b.note ?? t.note), t.id);
  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(t.id));
});

app.delete('/api/trips/:id', (req, res) => {
  db.prepare('DELETE FROM trips WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/inventory', (req, res) => {
  let sql = 'SELECT * FROM inventory WHERE user_id = ?';
  const args = [req.user.id];
  if (req.query.location) { sql += ' AND location_key = ?'; args.push(req.query.location); }
  sql += " ORDER BY CASE state WHEN 'out' THEN 0 WHEN 'low' THEN 1 ELSE 2 END, name";
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/inventory', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO inventory (user_id, name, location_key, state, purchase_rule, store, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, String(b.name || ''), String(b.location_key || 'evans'), String(b.state || 'ok'),
      String(b.purchase_rule || 'low'), String(b.store || ''), String(b.note || ''));
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/inventory/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM inventory WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!inv) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  db.prepare(`UPDATE inventory SET name = ?, location_key = ?, state = ?, purchase_rule = ?, store = ?, note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(String(b.name ?? inv.name), String(b.location_key ?? inv.location_key), String(b.state ?? inv.state),
      String(b.purchase_rule ?? inv.purchase_rule), String(b.store ?? inv.store), String(b.note ?? inv.note), inv.id);
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(inv.id));
});

app.delete('/api/inventory/:id', (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/tracking', (req, res) => {
  const kind = req.query.kind || 'weight';
  res.json(db.prepare('SELECT * FROM tracking WHERE user_id = ? AND kind = ? ORDER BY date DESC LIMIT 400').all(req.user.id, kind));
});

app.post('/api/tracking', (req, res) => {
  const b = req.body || {};
  const value = parseFloat(b.value);
  if (!isFinite(value)) return res.status(400).json({ error: 'Need a number.' });
  db.prepare(`INSERT INTO tracking (user_id, kind, value, unit, date, note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, date, user_id) DO UPDATE SET value = excluded.value, note = excluded.note`)
    .run(req.user.id, String(b.kind || 'weight'), value, String(b.unit || 'lb'), String(b.date || today()), String(b.note || ''));
  res.json({ ok: true });
});

app.get('/api/preferences', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM preferences WHERE user_id = ?').all(req.user.id);
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.post('/api/preferences', (req, res) => {
  const ins = db.prepare(`INSERT INTO preferences (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(req.body || {})) ins.run(req.user.id, String(k), String(v));
  res.json({ ok: true });
});

app.get('/api/security/status', (req, res) => {
  const user = db.prepare("SELECT recovery_hash != '' AS has_recovery FROM users WHERE id = ?").get(req.user.id);
  res.json({
    passkeys: db.prepare('SELECT id, created_at, last_used, backed_up FROM passkeys WHERE user_id = ? ORDER BY id').all(req.user.id),
    has_recovery: !!user?.has_recovery,
    session_days: SESSION_DAYS,
  });
});

app.post('/api/security/recovery-code', (req, res) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';
  for (let i = 0; i < 20; i++) raw += alphabet[crypto.randomInt(alphabet.length)];
  const display = raw.match(/.{1,5}/g).join('-');
  db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(bcrypt.hashSync(raw, 12), req.user.id);
  logHistory(req.user.id, 'security', 0, 'recovery code generated', '');
  res.json({ code: display });
});

app.delete('/api/security/passkeys/:id', (req, res) => {
  db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  logHistory(req.user.id, 'security', 0, 'passkey removed', '');
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => {
  res.json(db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(req.user.id));
});

// One-tap undo for anything Sage did on its own (trust needs a visible undo).
app.post('/api/history/:id/undo', (req, res) => {
  const h = db.prepare('SELECT * FROM history WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!h || !h.undoable) return res.status(400).json({ error: 'Nothing to undo there.' });
  const snap = safeJSON(h.undoable, null);
  if (!snap) return res.status(400).json({ error: 'Nothing to undo there.' });
  if (h.entity === 'item') {
    db.prepare(`UPDATE items SET status = ?, done_at = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(snap.status || 'open', snap.done_at || '', h.entity_id, req.user.id);
    // A repeating item was moved on to its next date rather than closed, so
    // undo has to put the date back or that occurrence is gone for good.
    if (snap.due_at !== undefined) {
      db.prepare('UPDATE items SET due_at = ? WHERE id = ? AND user_id = ?').run(snap.due_at, h.entity_id, req.user.id);
    }
  }
  db.prepare("UPDATE history SET undoable = '', detail = detail || ' (undone)' WHERE id = ?").run(h.id);
  logHistory(req.user.id, h.entity, h.entity_id, 'undone', h.detail);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// VIEWS (spec §7) — generated from database state, never from chat history
// ---------------------------------------------------------------------------
function openItems(uid) {
  return db.prepare("SELECT * FROM items WHERE user_id = ? AND status IN ('open','waiting')").all(uid);
}

function partitionItems(uid, ctx) {
  const all = openItems(uid);
  const byId = new Map(all.map((i) => [i.id, i]));
  const t = ctx.date;
  const enrich = (i) => ({ ...i, blockers: itemBlockers(i, byId) });
  const live = all.map(enrich);
  // A list, and anything sitting on one, stays out of the pressure surfaces
  // unless she gave it a date herself. "Buy paper towels" belongs on the Costco
  // list, not on the screen that tells her what today needs.
  const listIds = new Set(live.filter((i) => i.type === 'list').map((i) => i.id));
  const onAList = (i) => listIds.has(i.project_id) && !i.due_at;
  const actionable = live.filter((i) => !i.blockers.length && i.type !== 'event' && i.type !== 'project'
    && i.type !== 'list' && !onAList(i) && i.importance !== 'opportunity' && i.status !== 'waiting');
  return {
    all: live, byId,
    events: live.filter((i) => i.type === 'event' && (i.event_start || i.due_at).slice(0, 10) === t)
      .sort((a, b) => (a.event_start || '').localeCompare(b.event_start || '')),
    overdue: actionable.filter((i) => i.due_at && i.due_at.slice(0, 10) < t),
    dueToday: actionable.filter((i) => i.due_at && i.due_at.slice(0, 10) === t),
    dueSoon: actionable.filter((i) => i.due_at && i.due_at.slice(0, 10) > t && i.due_at.slice(0, 10) <= daysFromNow(7)),
    noDate: actionable.filter((i) => !i.due_at),
    blocked: live.filter((i) => i.blockers.length),
    waiting: live.filter((i) => i.status === 'waiting'),
    projects: live.filter((i) => i.type === 'project'),
    lists: live.filter((i) => i.type === 'list'),
    shopping: live.filter((i) => i.type === 'shopping'),
    opportunities: live.filter((i) => i.importance === 'opportunity' || i.type === 'opportunity'),
  };
}

// NOW / Morning — immediate items only, aimed at one iPhone screen (spec §8).
app.get('/api/views/now', async (req, res) => {
  const uid = req.user.id;
  const date = req.query.date || today();
  // Refresh iCloud in the background if it's gone stale — never block the view
  // on someone else's server being slow.
  syncCalendars(uid).catch(() => {});
  const ctx = await buildContext(uid, date);
  const p = partitionItems(uid, ctx);
  const routines = await activeRoutines(uid, date, ctx);
  const hour = hourNow();

  const timely = routines.filter((r) => {
    if (r.complete) return false;
    if (r.after_hour && hour < r.after_hour) return false;
    if (r.time_of_day === 'morning' && hour >= 12) return false;
    if (r.time_of_day === 'evening' && hour < 16) return false;
    return true;
  });

  // ctx.events already merges her iCloud appointments with Sage's own.
  p.events = ctx.events;
  const nextEvent = p.events.find((e) => !e.event_start || e.event_start.slice(11) >= timeNow()) || p.events[0] || null;
  const immediate = [...p.overdue, ...p.dueToday].sort((a, b) => scoreItem(b) - scoreItem(a)).slice(0, 6);
  const reminders = ctx.reminders.filter((r) => r.due_at && r.due_at.slice(0, 10) <= date).slice(0, 8);
  const weightToday = db.prepare("SELECT * FROM tracking WHERE user_id = ? AND kind = 'weight' AND date = ?").get(uid, date) || null;
  // The scale is at home. Asking her to weigh in at the lake is asking for
  // something she cannot do, which is the one thing this app is meant not to
  // do. She can still log one by telling Sage the number.
  const homeKey = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'home_location'").get(uid)?.value
    || (ctx.locations.find((l) => l.is_home) || {}).key || 'evans';
  const weighInHere = ctx.hereKey === homeKey;

  res.json({
    date, hour,
    greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    here: ctx.here, weather: ctx.weather,
    activeTrip: ctx.activeTrip, upcomingTrip: ctx.upcomingTrip,
    events: p.events, nextEvent,
    immediate, reminders, routines: timely,
    weightToday, weighInHere, awayAt: weighInHere ? '' : (ctx.here?.name || 'away'),
    morning: morningOpening(uid, ctx, { hour, nextEvent, overdue: p.overdue }),
    counts: { open: p.all.length, overdue: p.overdue.length, blocked: p.blocked.length },
  });
});

// ---------------------------------------------------------------------------
// THE MORNING HOUR
//
// For forty years her mornings belonged to a clock. She got up in the dark,
// drove in, drove home in the dark. The quiet hour with coffee and the
// hummingbirds is not empty space before the day starts — it is the part of
// the day she earned, and the most valuable hour in it.
//
// An assistant that opens with "here are your tasks" turns that back into a
// commute, just a digital one. So it doesn't. The day is still here, one tap
// away, the moment she wants it — and anything that would genuinely make her
// late is still said out loud, gently, because withholding that would be its
// own kind of failure.
// ---------------------------------------------------------------------------
const MORNING_ENDS_AT = 10;

function morningOpening(uid, ctx, { hour, nextEvent, overdue }) {
  const pref = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'gentle_mornings'").get(uid);
  if (pref && pref.value === 'off') return null;
  if (hour >= MORNING_ENDS_AT) return null;

  // Only things in the next three hours are worth breaking the quiet for.
  // Both clocks must be Sage's, not the server's — the machine this runs on
  // is elsewhere, and comparing her 9:30 against a UTC "now" reads it as
  // hours in the past.
  let soon = null;
  if (nextEvent && nextEvent.event_start && nextEvent.event_start.length > 10) {
    const [nowH, nowM] = timeNow().split(':').map(Number);
    const [evH, evM] = nextEvent.event_start.slice(11, 16).split(':').map(Number);
    const mins = (evH * 60 + evM) - (nowH * 60 + nowM);
    if (mins > 0 && mins <= 180) {
      const hrs = Math.floor(mins / 60);
      const rem = mins % 60;
      const away = hrs
        ? `${hrs} hour${hrs > 1 ? 's' : ''}${rem >= 10 ? ` and ${rem} minutes` : ''}`
        : `${mins} minutes`;
      soon = { title: nextEvent.title, at: nextEvent.event_start, away, prep_minutes: nextEvent.prep_minutes || 0 };
    }
  }

  // Only ever say true things. Sage cannot see the feeder, so it does not
  // claim to — but it can say what the morning is actually doing outside.
  const notes = [];
  const w = ctx.weather;
  if (w) {
    if (w.rainingNow) notes.push('It’s raining out there.');
    else if (w.todayRain) notes.push(`Rain is coming later — ${w.tempNow}° right now.`);
    else if (w.tempNow >= 80) notes.push(`Already ${w.tempNow}°. It’ll be ${w.todayHigh}° by afternoon.`);
    else notes.push(`${w.tempNow}° out, heading for ${w.todayHigh}°.`);
  }
  if (ctx.activeTrip) notes.push('You’re at the lake.');

  return {
    quiet: !soon && !overdue.length,
    soon,
    notes,
    line: 'This time belongs to you. There’s nothing you need to do right now.',
  };
}

app.post('/api/preferences/gentle-mornings', (req, res) => {
  db.prepare(`INSERT INTO preferences (user_id, key, value) VALUES (?, 'gentle_mornings', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`)
    .run(req.user.id, (req.body || {}).on === false ? 'off' : 'on');
  res.json({ ok: true });
});

app.get('/api/views/today', async (req, res) => {
  const uid = req.user.id;
  const date = req.query.date || today();
  const ctx = await buildContext(uid, date);
  const p = partitionItems(uid, ctx);
  const routines = await activeRoutines(uid, date, ctx);
  res.json({
    date, here: ctx.here, weather: ctx.weather,
    events: ctx.events,
    reminders: ctx.reminders.filter((r) => r.due_at && r.due_at.slice(0, 10) <= date),
    must: [...p.overdue, ...p.dueToday].filter((i) => i.importance === 'must').sort((a, b) => scoreItem(b) - scoreItem(a)),
    should: [...p.overdue, ...p.dueToday].filter((i) => i.importance !== 'must').sort((a, b) => scoreItem(b) - scoreItem(a)),
    anytime: p.noDate.filter((i) => i.importance !== 'someday').sort((a, b) => scoreItem(b) - scoreItem(a)).slice(0, 12),
    routines,
    waiting: p.waiting,
    blocked: p.blocked,
  });
});

app.get('/api/views/week', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const p = partitionItems(uid, ctx);
  const end = daysFromNow(7);
  const external = db.prepare(`
    SELECT e.*, c.name AS calendar_name, c.kind AS calendar_kind
    FROM cal_events e JOIN cal_calendars c ON c.id = e.calendar_id
    WHERE e.user_id = ? AND substr(e.start, 1, 10) BETWEEN ? AND ?`)
    .all(uid, today(), end)
    .map((e) => ({ id: `cal-${e.id}`, title: e.title, type: 'event', status: 'open', importance: 'must',
      event_start: e.all_day ? '' : e.start, due_at: e.start.slice(0, 10), event_kind: e.event_kind,
      location: e.location, external: 1, source_kind: 'calendar',
      source_label: e.calendar_kind === 'caldav'
        ? `iCloud · ${e.calendar_name || 'Calendar'}`
        : (e.calendar_name || 'Subscribed calendar'),
      blockers: [] }));
  const days = [];
  for (let d = 0; d < 7; d++) {
    const date = daysFromNow(d);
    days.push({
      date,
      events: [...p.all.filter((i) => i.type === 'event' && (i.event_start || i.due_at).slice(0, 10) === date),
        ...external.filter((e) => e.due_at === date)]
        .sort((a, b) => (a.event_start || '~').localeCompare(b.event_start || '~')),
      items: p.all.filter((i) => i.type !== 'event' && i.due_at && i.due_at.slice(0, 10) === date && !i.blockers.length),
    });
    days[days.length - 1].items.push(...ctx.reminders.filter((r) => r.due_at.slice(0, 10) === date));
  }
  res.json({
    days,
    overdue: p.overdue,
    opportunities: p.opportunities.filter((i) => eligibleOpportunity(i, ctx)).slice(0, 6),
    trips: db.prepare(`SELECT * FROM trips WHERE user_id = ? AND status != 'done' AND start_date <= ? ORDER BY start_date`).all(uid, end),
  });
});

app.get('/api/views/coming-up', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const p = partitionItems(uid, ctx);
  const inRange = (from, to) => p.all
    .filter((i) => {
      const d = (i.due_at || i.window_start || '').slice(0, 10);
      return d && d > from && d <= to;
    })
    .sort((a, b) => (a.due_at || a.window_start).localeCompare(b.due_at || b.window_start));
  res.json({
    month: inRange(daysFromNow(7), daysFromNow(31)),
    quarter: inRange(daysFromNow(31), daysFromNow(92)),
    halfYear: inRange(daysFromNow(92), daysFromNow(183)),
    year: inRange(daysFromNow(183), daysFromNow(366)),
    seasonal: p.all.filter((i) => i.target_window && (!i.due_at)).sort((a, b) => (a.window_start || '').localeCompare(b.window_start || '')),
  });
});

app.get('/api/views/opportunities', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const p = partitionItems(uid, ctx);
  const maxEffort = parseInt(req.query.minutes, 10) || 0;
  const eligible = p.opportunities
    .filter((i) => !i.blockers.length && eligibleOpportunity(i, ctx))
    .filter((i) => !maxEffort || !i.effort_min || i.effort_min <= maxEffort);
  res.json({
    here: ctx.here, weather: ctx.weather,
    eligible,
    notYet: p.opportunities.filter((i) => i.blockers.length || !eligibleOpportunity(i, ctx)),
  });
});

// Her own lists — a Costco list, a packing list. iCloud will not share the ones
// on her phone, so these live here instead. A list is just a container: the
// things on it never chase her unless she puts a date on one herself.
app.get('/api/views/lists', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const p = partitionItems(uid, ctx);
  const done = db.prepare("SELECT * FROM items WHERE user_id = ? AND status = 'done' AND project_id != 0 ORDER BY done_at DESC LIMIT 200").all(uid);
  res.json({
    lists: p.lists.map((l) => {
      const open = p.all.filter((i) => i.project_id === l.id && i.type !== 'list');
      return {
        ...l,
        items: open,
        recentlyDone: done.filter((d) => d.project_id === l.id).slice(0, 8),
        openCount: open.length,
      };
    }),
  });
});

app.get('/api/views/projects', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const p = partitionItems(uid, ctx);
  res.json({
    projects: p.projects.map((pr) => {
      const children = p.all.filter((i) => i.project_id === pr.id);
      const open = children.filter((c) => c.status !== 'done');
      const nextUp = open.filter((c) => !c.blockers.length).sort((a, b) => scoreItem(b) - scoreItem(a))[0] || null;
      return {
        ...pr,
        next: pr.next_action || nextUp?.title || '',
        nextItem: nextUp,
        blockedCount: open.filter((c) => c.blockers.length).length,
        openCount: open.length,
      };
    }),
  });
});

app.get('/api/views/lake', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const trips = db.prepare(`SELECT * FROM trips WHERE user_id = ? AND status != 'done' ORDER BY start_date`).all(uid);
  const next = trips[0] || null;
  const allRoutines = db.prepare('SELECT * FROM routines WHERE user_id = ? AND active = 1 ORDER BY sort, id').all(uid);
  const tripRoutines = allRoutines.filter((r) => {
    const cfg = safeJSON(r.trigger_config, {});
    return cfg.event === 'trip_departure' || cfg.event === 'trip_arrival' || cfg.location === 'lake';
  }).map((r) => routineWithSteps(r, ctx.date));
  res.json({
    trips, next,
    routines: tripRoutines,
    packing: db.prepare("SELECT * FROM items WHERE user_id = ? AND status = 'open' AND (location = 'lake' OR life_area = 'lake') ORDER BY type, title").all(uid),
    inventory: db.prepare("SELECT * FROM inventory WHERE user_id = ? AND location_key = 'lake' ORDER BY CASE state WHEN 'out' THEN 0 WHEN 'low' THEN 1 ELSE 2 END, name").all(uid),
    weather: next ? await (async () => {
      const loc = ctx.locations.find((l) => l.key === (next.location_key || 'lake'));
      return loc ? getWeather(loc.lat, loc.lon) : null;
    })() : null,
  });
});

app.get('/api/views/inbox', (req, res) => {
  const uid = req.user.id;
  res.json({
    recent: db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(uid),
    history: db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(uid),
  });
});

// ---------------------------------------------------------------------------
// CAPTURE — say it once, in ordinary language (spec §1, §6)
// ---------------------------------------------------------------------------
// Which model tier a capture deserves. One thought is routine work; a bedtime
// brain dump with several threads in it is where a weaker model splits things
// wrong. Counts real sentences only — "Good morning Sage. 150.0." is one
// thought, not two, and it happens every morning.
function captureTier(text) {
  const sentences = text.split(/[.;!?\n]+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
  return (text.length > 180 || sentences.length > 1) ? 'smart' : 'fast';
}

function heuristicCapture(text, ctx) {
  const proposals = [];
  const weight = text.match(/\b(\d{2,3}\.\d)\b/);
  if (weight && /^(good morning|morning|hi|hey|sage)/i.test(text.trim())) {
    proposals.push({ kind: 'tracking', kindOf: 'weight', value: parseFloat(weight[1]), date: ctx.date });
  }
  const lower = text.toLowerCase();
  const trip = lower.match(/\b(?:going|go|heading|head|leaving|leave)\s+(?:to\s+)?the\s+lake\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (trip) proposals.push({ kind: 'trip', location_key: 'lake', when: trip[1] });
  const paid = lower.match(/\bi\s+(?:paid|finished|did|completed|called)\s+(.{2,50})/);
  if (paid) proposals.push({ kind: 'complete', match: paid[1].replace(/[.!]$/, '').trim() });
  if (!proposals.length) {
    proposals.push({
      kind: 'item',
      item: { title: text.slice(0, 90), raw_capture: text, type: 'task', importance: 'should', status: 'open' },
    });
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// RETRIEVAL — the layer between the database and the reasoning.
//
// Sending the whole open list is the easy mistake, and it is why most
// assistants feel like they are searching a database rather than knowing you.
// The database can hold hundreds of things; almost none of them matter at
// 7am on a Wednesday. This selects the handful that do — by what is live
// right now, and by what her words actually point at — and says plainly how
// much it left out, so the reasoning layer never mistakes its slice for the
// whole picture.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'you',
  'your', 'are', 'not', 'but', 'all', 'get', 'got', 'out', 'off', 'one', 'two', 'into', 'about', 'need',
  'needs', 'just', 'can', 'will', 'when', 'then', 'than', 'they', 'them', 'her', 'his', 'its', 'did', 'done',
  'today', 'tomorrow', 'week', 'now', 'still', 'some', 'any', 'more', 'been', 'were', 'what', 'who', 'why',
  // How she talks to Sage, rather than what she is talking about. "Good
  // morning Sage" is a greeting every day; the assistant's own name appears
  // throughout her notes too, so left in it would match half her life.
  'sage', 'good', 'morning', 'afternoon', 'evening', 'night', 'hello', 'hey', 'okay', 'please', 'thanks',
  'remind', 'reminder', 'remember', 'note', 'add', 'put',
]);

function tokenize(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9']{3,}/g) || []).filter((t) => !STOPWORDS.has(t));
}

function itemTokens(i) {
  return new Set(tokenize(`${i.title} ${i.note} ${i.raw_capture} ${i.next_action} ${i.store} ${i.location} ${i.life_area}`));
}

// A word is only evidence if it is distinctive. "Terminix" appears in one
// item and means everything; "Sage" appears across half her notes and means
// nothing — she says it every morning. Rather than blocklisting words by
// hand, weight each one by how rare it is in her own data, so this keeps
// working as her life changes.
function buildRelevance(live) {
  const df = new Map();
  const cache = new Map();
  for (const i of live) {
    const toks = itemTokens(i);
    cache.set(i.id, toks);
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const ubiquitous = Math.max(3, Math.ceil(live.length * 0.2));
  return (item, tokens) => {
    if (!tokens.length) return 0;
    const hay = cache.get(item.id) || itemTokens(item);
    let score = 0;
    for (const t of tokens) {
      if (!hay.has(t)) continue;
      const freq = df.get(t) || 1;
      if (freq > ubiquitous) continue;            // too common to mean anything
      score += 1 / freq;                          // rarer word, stronger signal
    }
    return score;
  };
}

function slim(i, why) {
  return {
    id: i.id, title: i.title, type: i.type, importance: i.importance,
    due_at: i.due_at || undefined, target_window: i.target_window || undefined,
    next_action: i.next_action || undefined,
    blocked_by: (i.blockers && i.blockers.length) ? i.blockers : undefined,
    why,
  };
}

function selectContext(uid, ctx, { text = '', budget = 24, routines = [] } = {}) {
  const all = openItems(uid).filter((i) => !i.ai_private);
  const byId = new Map(all.map((i) => [i.id, i]));
  const live = all.map((i) => ({ ...i, blockers: itemBlockers(i, byId) }));
  const t = ctx.date;

  const unblocked = live.filter((i) => !i.blockers.length && i.type !== 'project');
  const dueNow = unblocked.filter((i) => i.due_at && i.due_at.slice(0, 10) <= t);
  const dueSoon = unblocked.filter((i) => i.due_at && i.due_at.slice(0, 10) > t && i.due_at.slice(0, 10) <= daysFrom(t, 7));
  const eligible = unblocked.filter((i) => (i.importance === 'opportunity' || i.type === 'opportunity') && eligibleOpportunity(i, ctx));
  // Seasonal work whose moment has just arrived — the windows opening is
  // exactly the kind of thing she would otherwise never be reminded of.
  const justOpened = unblocked.filter((i) => i.window_start && i.window_start <= t && i.window_start >= daysFrom(t, -21));

  const tokens = [...new Set(tokenize(text))];
  const relevance = buildRelevance(live);
  const matched = tokens.length
    ? live.map((i) => ({ i, score: relevance(i, tokens) })).filter((x) => x.score >= 0.1)
      .sort((a, b) => b.score - a.score || scoreItem(b.i) - scoreItem(a.i)).slice(0, 8).map((x) => x.i)
    : [];

  const chosen = new Map();
  const take = (list, why, cap) => {
    for (const i of (cap ? list.slice(0, cap) : list)) {
      if (chosen.size >= budget) return;
      if (!chosen.has(i.id)) chosen.set(i.id, slim(i, why));
    }
  };
  // What she just said comes first — a completion has to find its target.
  take(matched, 'matches what she said');
  take(dueNow.sort((a, b) => scoreItem(b) - scoreItem(a)), 'due now');
  take(dueSoon.sort((a, b) => (a.due_at).localeCompare(b.due_at)), 'due this week', 6);
  take(eligible, 'fits today', 4);
  take(justOpened, 'its season has arrived', 3);

  const pending = routines.filter((r) => !r.complete)
    .map((r) => ({ name: r.name, left: r.remaining, note: r.cadence_note || undefined }));

  // Weather is only worth a slot when something actually turns on it.
  const weatherMatters = ctx.weather && (ctx.weather.todayRain || ctx.weather.dryNextDays
    || ctx.weather.todayHigh >= 90 || ctx.weather.todayLow <= 40);

  const prefs = Object.fromEntries(
    db.prepare('SELECT key, value FROM preferences WHERE user_id = ?').all(uid)
      .filter((r) => r.key !== 'cal_last_sync').map((r) => [r.key, r.value]));
  // Durable things she has told Sage to remember, chosen the same way as
  // everything else: by what she is talking about right now.
  const remembered = recallMemories(uid, text);

  return {
    today: t,
    dayOfWeek: new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    here: ctx.hereKey,
    weather: weatherMatters ? { high: ctx.weather.todayHigh, low: ctx.weather.todayLow, rain: ctx.weather.todayRain } : undefined,
    appointmentsToday: (ctx.events || []).filter((e) => !e.ai_private)
      .map((e) => ({ title: e.title, at: e.event_start || 'all day', kind: e.event_kind || undefined })),
    appleReminders: (ctx.reminders || [])
      .filter((r) => !r.due_at || r.due_at.slice(0, 10) <= daysFrom(t, 7))
      .slice(0, 20)
      .map((r) => ({ title: r.title, due: r.due_at || undefined, list: r.source_label })),
    routinesPending: pending.length ? pending : undefined,
    activeTrip: ctx.activeTrip || undefined,
    upcomingTrip: ctx.upcomingTrip || undefined,
    relevantItems: [...chosen.values()],
    // Project membership is structural, not merely a search result. Always
    // expose the active project directory so a capture like "plant lavender"
    // can be attached to Garden even when the project itself was not selected
    // by lexical retrieval.
    projects: live.filter((i) => i.type === 'project')
      .slice(0, 30).map((p) => ({ id: p.id, title: p.title, next_action: p.next_action || undefined })),
    aboutHer: prefs,
    remembered: remembered.length ? remembered : undefined,
    // Honesty about the slice: without this the reasoning layer will happily
    // conclude "you have nothing else on" from a partial view.
    notShown: Math.max(0, all.length - chosen.size),
    note: 'relevantItems is a deliberate selection, not the whole database. notShown counts what was left out as not currently relevant. Never claim she has nothing else pending.',
  };
}

// Kept for callers that want everything (export, debugging).
function contextForAI(uid, ctx) {
  return selectContext(uid, ctx, { budget: 60 });
}

app.post('/api/capture', async (req, res) => {
  const uid = req.user.id;
  const text = String((req.body || {}).text || '').slice(0, 4000);
  if (!text.trim()) return res.status(400).json({ error: 'Nothing captured yet.' });
  const ctx = await buildContext(uid);
  let proposals = null;
  let source = 'heuristic';
  let reply = '';

  const ai = await askAI(
    personaFor(uid) + `

You convert one natural capture into structured proposals against Regena's existing data.
Reply ONLY with JSON: {"reply": string, "proposals": [ ... ]}
"reply" is one short sentence confirming what you understood, or ONE clarifying question if genuinely ambiguous. No preamble, no pleasantries.

Each proposal is one of:
{"kind":"item","confidence":"high"|"low","item":{"title","type":"task|event|project|opportunity|shopping|note","importance":"must|should|opportunity|someday","due_at":"YYYY-MM-DD or YYYY-MM-DDTHH:MM or ''","target_window":"her words e.g. September","window_start":"YYYY-MM-DD or ''","location":"location key or ''","life_area":"","effort_min":0,"project_id":0,"prereq_ids":[],"event_start":"","event_kind":"hosting|pt|appointment|trip|other or ''","prep_minutes":0,"store":"","purchase_rule":"now|low|on_sale|watch","note":""}}
{"kind":"complete","confidence":"high"|"low","item_id":123,"why":"short"}
{"kind":"update","confidence":"high"|"low","item_id":123,"changes":{...same item fields...},"why":"short"}
{"kind":"tracking","kindOf":"weight","value":150.0,"date":"YYYY-MM-DD"}
{"kind":"trip","location_key":"lake","start_date":"YYYY-MM-DD","end_date":""}
{"kind":"memory","confidence":"high"|"low","memory":{"content":"one plain sentence in the third person","kind":"fact|preference|decision|principle|person|place"}}

Rules:
- Match against openItems by meaning before creating anything new. "I paid Terminix" is a completion of an existing item, not a new one.
- When she says "remember that…", "for future reference…", or states a lasting preference or fact about a person or place, that is a memory, not a task. Something she must DO is a task; something that is simply TRUE about her life is a memory.
- confidence "high" only for obvious, low-risk changes; anything consequential or ambiguous is "low".
- A greeting containing a bare number like "150.0" is a weight entry.
- Resolve relative dates ("Friday", "tomorrow") to real dates.
- Something not to be done until a season goes in target_window + window_start, not due_at.
- For every new task, compare it with the existing projects supplied in context. When one is a clear semantic home, use that exact project's id as project_id. Never invent a project id; use 0 when none clearly fits.
- If a task depends on another open item, set prereq_ids.`,
    `Her capture: "${text}"\n\nWhat is relevant right now:\n${JSON.stringify(selectContext(uid, ctx, { text, routines: await activeRoutines(uid, ctx.date, ctx) }))}`,
    { maxTokens: 1600, json: true, tier: captureTier(text) },
  );

  if (ai) {
    const parsed = safeJSON(ai, null);
    if (parsed && Array.isArray(parsed.proposals)) {
      proposals = parsed.proposals;
      reply = String(parsed.reply || '');
      source = 'ai';
    }
  }
  if (!proposals) proposals = heuristicCapture(text, ctx);

  // Attach the human-readable target of each completion/update for the confirm screen.
  for (const p of proposals) {
    if ((p.kind === 'complete' || p.kind === 'update') && p.item_id) {
      const target = db.prepare('SELECT id, title, status FROM items WHERE id = ? AND user_id = ?').get(p.item_id, uid);
      p.target = target || null;
      if (!target) p.kind = 'invalid';
    }
  }
  res.json({ raw: text, reply, proposals: proposals.filter((p) => p.kind !== 'invalid'), source });
});

// Apply the proposals Regena approved (or the auto-applicable ones).
app.post('/api/capture/apply', (req, res) => {
  const uid = req.user.id;
  const b = req.body || {};
  const raw = String(b.raw || '');
  const proposals = Array.isArray(b.proposals) ? b.proposals : [];
  const applied = [];

  for (const p of proposals) {
    if (p.kind === 'item' && p.item) {
      const proposedProject = parseInt(p.item.project_id, 10) || 0;
      const ownedProject = proposedProject
        ? db.prepare("SELECT id FROM items WHERE id = ? AND user_id = ? AND type = 'project' AND status = 'open'")
          .get(proposedProject, uid)
        : null;
      p.item.project_id = ownedProject ? ownedProject.id : 0;
      const it = cleanItem({ ...p.item, raw_capture: raw, source: b.source === 'voice' ? 'voice' : 'typed' });
      const cols = Object.keys(it);
      const info = db.prepare(`INSERT INTO items (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(uid, ...cols.map((c) => it[c]));
      logHistory(uid, 'item', info.lastInsertRowid, 'captured', it.title, 1);
      applied.push({ kind: 'item', id: info.lastInsertRowid, title: it.title });
    } else if (p.kind === 'complete' && p.item_id) {
      const cur = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(p.item_id, uid);
      if (!cur) continue;
      const outcome = completeItem(uid, cur);
      applied.push({ kind: 'complete', id: cur.id, title: cur.title, ...outcome });
    } else if (p.kind === 'update' && p.item_id && p.changes) {
      const cur = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(p.item_id, uid);
      if (!cur) continue;
      const it = cleanItem(p.changes, cur);
      const cols = Object.keys(it);
      if (cols.length) {
        db.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...cols.map((c) => it[c]), cur.id);
        logHistory(uid, 'item', cur.id, 'updated', cur.title, 1, JSON.stringify({ status: cur.status, done_at: cur.done_at }));
      }
      applied.push({ kind: 'update', id: cur.id, title: cur.title });
    } else if (p.kind === 'tracking') {
      db.prepare(`INSERT INTO tracking (user_id, kind, value, unit, date) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, date, user_id) DO UPDATE SET value = excluded.value`)
        .run(uid, String(p.kindOf || 'weight'), parseFloat(p.value) || 0, 'lb', String(p.date || today()));
      applied.push({ kind: 'tracking', value: p.value });
    } else if (p.kind === 'trip') {
      const info = db.prepare('INSERT INTO trips (user_id, location_key, start_date, end_date) VALUES (?, ?, ?, ?)')
        .run(uid, String(p.location_key || 'lake'), String(p.start_date || p.when || today()), String(p.end_date || ''));
      logHistory(uid, 'trip', info.lastInsertRowid, 'planned', `${p.location_key || 'lake'} ${p.start_date || ''}`, 1);
      applied.push({ kind: 'trip', id: info.lastInsertRowid });
    } else if (p.kind === 'memory' && p.memory && String(p.memory.content || '').trim()) {
      const content = String(p.memory.content).trim().slice(0, 500);
      const info = db.prepare(`INSERT INTO memories (user_id, content, kind, source, thread_id) VALUES (?, ?, ?, ?, ?)`)
        .run(uid, content, MEMORY_KINDS.includes(p.memory.kind) ? p.memory.kind : 'fact',
          p.memory.source === 'her' ? 'her' : 'thread', parseInt(p.thread_id, 10) || 0);
      logHistory(uid, 'memory', info.lastInsertRowid, 'remembered', content.slice(0, 80), 1);
      applied.push({ kind: 'memory', id: info.lastInsertRowid, content });
    }
  }
  res.json({ applied });
});

// Natural-language correction: "that isn't urgent, leave it until September"
app.post('/api/correct', async (req, res) => {
  const uid = req.user.id;
  const itemId = parseInt((req.body || {}).item_id, 10);
  const text = String((req.body || {}).text || '').slice(0, 500);
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(itemId, uid);
  if (!item || !text.trim()) return res.status(400).json({ error: 'Need an item and a correction.' });
  if (item.ai_private) {
    return res.status(400).json({ error: 'This is private from AI. Edit its fields directly instead.' });
  }
  const ctx = await buildContext(uid);
  const ai = await askAI(
    personaFor(uid) + `\n\nRegena is correcting how one stored item is classified. Reply ONLY with JSON: {"changes":{...},"reply":"one short sentence"}. Allowed change fields: title, type, status, importance, due_at, window_start, target_window, location, life_area, effort_min, project_id, purchase_rule, note. Today is ${ctx.date}. "Not until September" means window_start on the 1st of the next September and target_window "September" — not a due date. Only use a project_id from Existing projects; otherwise use 0.`,
    `Item: ${JSON.stringify({ id: item.id, title: item.title, type: item.type, importance: item.importance, due_at: item.due_at, target_window: item.target_window, location: item.location, project_id: item.project_id })}\nExisting projects: ${JSON.stringify(db.prepare("SELECT id, title FROM items WHERE user_id = ? AND type = 'project' AND status = 'open' ORDER BY title").all(uid))}\nHer correction: "${text}"`,
    { maxTokens: 500, json: true },
  );
  const parsed = safeJSON(ai || '', null);
  if (!parsed || !parsed.changes) return res.status(422).json({ error: 'Could not read that correction — you can edit the fields directly.' });
  if (parsed.changes.project_id !== undefined) {
    const proposedProject = parseInt(parsed.changes.project_id, 10) || 0;
    const ownedProject = proposedProject
      ? db.prepare("SELECT id FROM items WHERE id = ? AND user_id = ? AND type = 'project' AND status = 'open'")
        .get(proposedProject, uid)
      : null;
    parsed.changes.project_id = ownedProject ? ownedProject.id : 0;
  }
  const it = cleanItem(parsed.changes, item);
  const cols = Object.keys(it);
  if (cols.length) {
    db.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => it[c]), item.id);
    logHistory(uid, 'item', item.id, 'corrected', text, 1, JSON.stringify({ status: item.status, done_at: item.done_at }));
  }
  res.json({ item: db.prepare('SELECT * FROM items WHERE id = ?').get(item.id), reply: parsed.reply || 'Updated.' });
});

// What did Sage actually look at? Retrieval you can inspect, rather than
// trusting. Useful when an answer seems to have missed something obvious.
app.get('/api/ai/context', async (req, res) => {
  const uid = req.user.id;
  const ctx = await buildContext(uid);
  const routines = await activeRoutines(uid, ctx.date, ctx);
  const selection = selectContext(uid, ctx, { text: String(req.query.text || ''), routines });
  res.json({
    selection,
    size: { selected: selection.relevantItems.length, notShown: selection.notShown,
      totalOpen: selection.relevantItems.length + selection.notShown,
      approxChars: JSON.stringify(selection).length },
  });
});

// ---------------------------------------------------------------------------
// THINKING — somewhere to muse, decide, or empty her head at bedtime.
//
// The hard rule: a thread is conversation, never a second source of truth.
// Nothing said here becomes a task until she explicitly asks. Thinking out
// loud must not manufacture obligations — "possibility should not
// automatically become obligation" is her own principle, and an assistant
// that turns every musing into a to-do makes musing unsafe.
// ---------------------------------------------------------------------------
const THINKING_EXTRA = `

Right now you are thinking WITH her, not managing anything.
- This is conversation. Do not produce task lists, do not assign actions, and do not end every reply with a suggestion.
- Often the most useful reply is one good question, and then nothing else.
- If she is working a decision, help her see it: what is actually being traded off, what she already knows, where she may be rationalizing. Say the uncomfortable thing kindly when it is true.
- Do not push her toward doing more. "Could improve" is not "needs improvement."
- Two to six sentences unless she clearly wants more. She reads on a phone, in large text.
- If something genuinely needs remembering, say so once, plainly, and leave it — she can ask you to keep it.`;

const BEDTIME_EXTRA = `

It is bedtime and she is emptying her head so she can sleep. This is a holding pen, not a planning session.
- Acknowledge what she said in ONE short line. Confirm you have it.
- No advice. No questions. No next steps. No lists. Nothing to decide.
- Never suggest doing anything tonight.
- Warmth is welcome; problem-solving is not. It will all still be there tomorrow, and you are holding it so she does not have to.`;

const thinkingPersona = (uid) => personaFor(uid) + THINKING_EXTRA;
const bedtimePersona = (uid) => personaFor(uid) + BEDTIME_EXTRA;

// ---------------------------------------------------------------------------
// MEMORY — the durable middle tier. Retrieved by relevance, like everything
// else: what she is talking about now, plus whatever she pinned.
// ---------------------------------------------------------------------------
const MEMORY_KINDS = ['fact', 'preference', 'decision', 'principle', 'person', 'place'];

// Below this many memories, selecting is worse than not selecting: the whole
// set is cheap to carry, and word-matching cannot connect "what should I
// wear" to "she avoids tanks" — only the reasoning layer can. Above it,
// fall back to relevance so the payload stays honest as her memory grows.
const RECALL_ALL_UNDER = 30;

function recallMemories(uid, text = '', limit = 10) {
  const all = db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC').all(uid);
  if (!all.length) return [];

  let chosen;
  if (all.length <= RECALL_ALL_UNDER) {
    chosen = all;
  } else {
    const tokens = [...new Set(tokenize(text))];
    const df = new Map();
    const cache = new Map();
    for (const m of all) {
      const toks = new Set(tokenize(m.content));
      cache.set(m.id, toks);
      for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    }
    const ubiquitous = Math.max(3, Math.ceil(all.length * 0.3));
    chosen = all.map((m) => {
      let match = 0;
      const hay = cache.get(m.id);
      for (const t of tokens) {
        if (!hay.has(t)) continue;
        const freq = df.get(t) || 1;
        if (freq > ubiquitous) continue;
        match += 1 / freq;
      }
      // Usage breaks ties between things she actually said; it must never
      // create relevance on its own, or a memory recalled once is recalled
      // forever regardless of the subject.
      const score = m.pinned ? 100 + match : match;
      return { m, score, match };
    }).filter((x) => x.m.pinned || x.match > 0)
      .sort((a, b) => b.score - a.score || b.m.use_count - a.m.use_count)
      .slice(0, limit).map((x) => x.m);
  }

  if (chosen.length) {
    const touch = db.prepare("UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?");
    for (const m of chosen) touch.run(m.id);
  }
  return chosen.map((m) => ({ id: m.id, kind: m.kind, content: m.content }));
}

// --- managing the ChatGPT key (from inside the app, cookie-authenticated) ---
app.get('/api/gpt-key', (req, res) => {
  const row = db.prepare('SELECT id, label, last_used, use_count, created_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC').get(req.user.id);
  res.json({ key: row || null, schema_url: `${req.protocol}://${req.get('host')}/gpt/openapi.json` });
});

app.post('/api/gpt-key', (req, res) => {
  // One key at a time keeps this simple to reason about and to revoke.
  db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(req.user.id);
  const token = 'sage_' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO api_tokens (user_id, token, label) VALUES (?, ?, ?)')
    .run(req.user.id, token, String((req.body || {}).label || 'ChatGPT').slice(0, 40));
  logHistory(req.user.id, 'gpt_key', 0, 'created', 'read-only key for ChatGPT');
  // Shown once, here. It is not retrievable afterwards.
  res.json({ token, schema_url: `${req.protocol}://${req.get('host')}/gpt/openapi.json` });
});

app.delete('/api/gpt-key', (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(req.user.id);
  logHistory(req.user.id, 'gpt_key', 0, 'revoked', '');
  res.json({ ok: true });
});

app.get('/api/memories', (req, res) => {
  const q = String(req.query.q || '').trim();
  let sql = 'SELECT * FROM memories WHERE user_id = ?';
  const args = [req.user.id];
  if (q) { sql += ' AND content LIKE ?'; args.push(`%${q}%`); }
  sql += ' ORDER BY pinned DESC, updated_at DESC LIMIT 300';
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/memories', (req, res) => {
  const b = req.body || {};
  const content = String(b.content || '').trim().slice(0, 500);
  if (!content) return res.status(400).json({ error: 'What should I remember?' });
  const info = db.prepare(`INSERT INTO memories (user_id, content, kind, source, thread_id, pinned)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, content,
    MEMORY_KINDS.includes(b.kind) ? b.kind : 'fact',
    ['her', 'thread', 'seed'].includes(b.source) ? b.source : 'her',
    parseInt(b.thread_id, 10) || 0, b.pinned ? 1 : 0);
  logHistory(req.user.id, 'memory', info.lastInsertRowid, 'remembered', content.slice(0, 80));
  res.json(db.prepare('SELECT * FROM memories WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/memories/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'No such memory.' });
  const b = req.body || {};
  db.prepare(`UPDATE memories SET content = ?, kind = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(String(b.content ?? m.content).slice(0, 500),
      MEMORY_KINDS.includes(b.kind) ? b.kind : m.kind,
      b.pinned === undefined ? m.pinned : (b.pinned ? 1 : 0), m.id);
  res.json(db.prepare('SELECT * FROM memories WHERE id = ?').get(m.id));
});

app.delete('/api/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

function threadWithCount(t) {
  const row = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE thread_id = ?').get(t.id);
  const first = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'her' ORDER BY id LIMIT 1").get(t.id);
  return { ...t, message_count: row.n, last_at: row.last || t.created_at, preview: first ? first.content.slice(0, 120) : '' };
}

app.get('/api/threads', (req, res) => {
  res.json(db.prepare('SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100')
    .all(req.user.id).map(threadWithCount));
});

app.post('/api/threads', (req, res) => {
  const kind = ['thinking', 'bedtime'].includes((req.body || {}).kind) ? req.body.kind : 'thinking';
  const info = db.prepare('INSERT INTO threads (user_id, title, kind) VALUES (?, ?, ?)')
    .run(req.user.id, String((req.body || {}).title || '').slice(0, 120), kind);
  res.json(threadWithCount(db.prepare('SELECT * FROM threads WHERE id = ?').get(info.lastInsertRowid)));
});

app.get('/api/threads/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'No such conversation.' });
  res.json({ ...t, messages: db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(t.id) });
});

app.patch('/api/threads/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'No such conversation.' });
  db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(String((req.body || {}).title || t.title).slice(0, 120), t.id);
  res.json({ ok: true });
});

app.delete('/api/threads/:id', (req, res) => {
  db.prepare('DELETE FROM threads WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/threads/:id/message', async (req, res) => {
  const uid = req.user.id;
  const t = db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!t) return res.status(404).json({ error: 'No such conversation.' });
  const text = String((req.body || {}).text || '').slice(0, 4000).trim();
  if (!text) return res.status(400).json({ error: 'Say something first.' });

  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'her', ?)").run(t.id, text);

  // Recent turns verbatim; older ones as a rolling gist, so a long
  // conversation does not quietly forget its own beginning.
  const history = db.prepare('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 13')
    .all(t.id).reverse().slice(0, -1);
  const ctx = await buildContext(uid);
  const bedtime = t.kind === 'bedtime';
  const earlier = t.summary ? `[Earlier in this conversation: ${t.summary}]\n\n` : '';
  // Bedtime gets no retrieval at all — nothing about her open tasks belongs
  // in that room at 11pm.
  const selection = bedtime ? null
    : selectContext(uid, ctx, { text, budget: 20, routines: await activeRoutines(uid, ctx.date, ctx) });

  let reply = await askAI(
    bedtime ? bedtimePersona(uid) : thinkingPersona(uid),
    bedtime ? text
      : `${earlier}${text}\n\n[Her life, for context only — do not turn this into a task list:]\n${JSON.stringify(selection)}`,
    { maxTokens: bedtime ? 120 : 700, tier: 'smart', history },
  );
  if (!reply) {
    reply = bedtime
      ? 'Got it. It’s written down — you can stop holding it.'
      : 'The thinking layer isn’t connected right now, so I can’t think this through with you — but what you said is saved here.';
  }
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'sage', ?)").run(t.id, reply);

  if (!t.title) {
    const auto = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(auto + (text.length > 60 ? '…' : ''), t.id);
  }
  db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(t.id);
  res.json({ reply, thread: threadWithCount(db.prepare('SELECT * FROM threads WHERE id = ?').get(t.id)) });

  // Re-summarise in the background once the conversation outgrows the window
  // we send verbatim. Never blocks her reply.
  summariseIfNeeded(uid, t.id).catch(() => {});
});

const SUMMARY_AFTER = 14;
async function summariseIfNeeded(uid, threadId) {
  const t = db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(threadId, uid);
  if (!t || t.kind === 'bedtime') return;                 // bedtime keeps nothing
  const all = db.prepare('SELECT id, role, content FROM messages WHERE thread_id = ? ORDER BY id').all(threadId);
  if (all.length < SUMMARY_AFTER) return;
  const cutoff = all[all.length - 12].id;                 // everything before the verbatim window
  if (cutoff <= t.summarized_upto) return;
  const older = all.filter((m) => m.id < cutoff);
  if (!older.length) return;
  const gist = await askAI(
    'Summarise the earlier part of a conversation so it can be carried forward. Keep what was decided, what was ruled out, and what still matters. Drop pleasantries. Third person, under 120 words, plain sentences. Reply with the summary only.',
    older.map((m) => `${m.role === 'her' ? 'Regena' : 'Sage'}: ${m.content}`).join('\n'),
    { maxTokens: 260, tier: 'fast' },
  );
  if (gist) {
    db.prepare('UPDATE threads SET summary = ?, summarized_upto = ? WHERE id = ?').run(gist.trim(), cutoff, threadId);
  }
}

// Only when she asks: pull real commitments out of a conversation. Proposals
// only — she still approves each one, exactly like capture.
app.post('/api/threads/:id/harvest', async (req, res) => {
  const uid = req.user.id;
  const t = db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!t) return res.status(404).json({ error: 'No such conversation.' });
  const msgs = db.prepare('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id').all(t.id);
  if (!msgs.length) return res.json({ proposals: [], reply: 'Nothing in this one yet.' });
  const ctx = await buildContext(uid);

  const ai = await askAI(
    personaFor(uid) + `

Read a conversation and pull out what is worth keeping. Reply ONLY with JSON: {"reply": string, "proposals": [...]}.
Proposal shapes: {"kind":"item","confidence":"high"|"low","item":{...}} · {"kind":"complete","item_id":123,"why":""} · {"kind":"memory","confidence":"high"|"low","memory":{"content":"one plain sentence in the third person","kind":"fact|preference|decision|principle|person|place"}}
Be strict and conservative:
- A thought is not a commitment. Wondering, weighing, or "maybe someday" is NOT a task.
- Only propose an item for something she clearly settled on doing.
- Propose a memory for something durable that would be useful months from now — a decision reached, a preference stated, a fact about a person or place. NOT a task, NOT a passing mood, NOT anything already obvious from her existing data.
- If nothing qualifies, return an empty proposals array and say so plainly. That is a good outcome, not a failure.
- Anything tentative goes in as importance "opportunity" or "someday", never "must".`,
    `Conversation:\n${msgs.map((m) => `${m.role === 'her' ? 'Regena' : 'Sage'}: ${m.content}`).join('\n')}\n\nHer current state:\n${JSON.stringify(selectContext(uid, ctx, { text: msgs.map((m) => m.content).join(' '), budget: 15 }))}`,
    { maxTokens: 1200, json: true, tier: 'smart' },
  );
  const parsed = safeJSON(ai || '', null);
  if (!parsed || !Array.isArray(parsed.proposals)) {
    return res.json({ proposals: [], reply: 'I couldn’t pick anything out with confidence — nothing saved.' });
  }
  for (const p of parsed.proposals) {
    if (p.kind === 'complete' && p.item_id) {
      p.target = db.prepare('SELECT id, title, status FROM items WHERE id = ? AND user_id = ?').get(p.item_id, uid) || null;
      if (!p.target) p.kind = 'invalid';
    }
  }
  res.json({ reply: String(parsed.reply || ''), proposals: parsed.proposals.filter((p) => p.kind !== 'invalid') });
});

// Ask Sage something about her own state — reasoning over the database.
app.post('/api/ask', async (req, res) => {
  const uid = req.user.id;
  const question = String((req.body || {}).text || '').slice(0, 1000);
  if (!question.trim()) return res.status(400).json({ error: 'Ask me something.' });
  const ctx = await buildContext(uid);
  const routines = await activeRoutines(uid, ctx.date, ctx);
  const answer = await askAI(
    personaFor(uid) + '\n\nAnswer from the state given. Be brief. Lead with actions if any. If the state does not contain the answer, say so plainly rather than guessing.',
    `Question: "${question}"\n\nWhat is relevant right now:\n${JSON.stringify(selectContext(uid, ctx, { text: question, budget: 30, routines }))}`,
    // The thinking-partner path always gets the better model. This is where
    // "do you think you're rationalizing here?" either lands or doesn't.
    { maxTokens: 1600, tier: 'smart' },
  );
  res.json({
    answer: answer || 'Sage is connected, but the model did not return an answer that time. Please try asking again.',
    working: !!answer,
  });
});

// ---------------------------------------------------------------------------
// iCloud calendar IN — read-only. Her real appointments become context, and
// drive the trigger engine (a PT appointment there suppresses home PT here).
// Sage never writes to her calendar; Apple Calendar stays the system of record.
// ---------------------------------------------------------------------------
const caldav = require('./caldav');
const CAL_SYNC_MINUTES = 30;
const CAL_WINDOW_BACK = 7;
const CAL_WINDOW_FORWARD = 180;

function calCreds(uid) {
  const acct = db.prepare('SELECT * FROM cal_account WHERE user_id = ?').get(uid);
  if (!acct) return null;
  const password = caldav.decrypt(acct.password_enc, SESSION_SECRET);
  if (!password) return { acct, password: null, stale: true };
  return { acct, password };
}

// Refreshes everything she's connected — iCloud over CalDAV and any
// subscribed .ics links (Google, Outlook) — into one set of events. One
// source failing never stops the others.
async function syncCalendars(uid, { force = false } = {}) {
  const acctRow = db.prepare('SELECT * FROM cal_account WHERE user_id = ?').get(uid);
  const feeds = db.prepare("SELECT * FROM cal_calendars WHERE user_id = ? AND kind = 'ics'").all(uid);
  if (!acctRow && !feeds.length) return { connected: false };

  const marker = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'cal_last_sync'").get(uid);
  if (!force && marker) {
    const age = (Date.now() - new Date(marker.value).getTime()) / 60000;
    if (age < CAL_SYNC_MINUTES) return { connected: true, skipped: true };
  }

  const from = daysFromNow(-CAL_WINDOW_BACK);
  const to = daysFromNow(CAL_WINDOW_FORWARD);
  const seen = new Set();
  const seenReminders = new Set();
  const errors = [];
  const okCals = new Set();      // sources that answered cleanly this round
  const okLists = new Set();
  const insEvent = db.prepare(`INSERT INTO cal_events (user_id, calendar_id, uid, title, start, end, all_day, location, event_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, uid) DO UPDATE SET title = excluded.title, start = excluded.start,
      end = excluded.end, all_day = excluded.all_day, location = excluded.location,
      event_kind = excluded.event_kind, calendar_id = excluded.calendar_id`);
  const store = (calId, events) => {
    for (const e of events.slice(0, 2000)) {
      if (!e.start) continue;
      const uniq = `${calId}::${e.uid}`;
      seen.add(uniq);
      insEvent.run(uid, calId, uniq, e.title, e.start, e.end, e.all_day, e.location, caldav.inferEventKind(e.title));
    }
  };
  const insReminder = db.prepare(`INSERT INTO external_reminders
    (user_id, list_id, uid, title, note, due, start, completed, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, list_id, uid) DO UPDATE SET title = excluded.title,
      note = excluded.note, due = excluded.due, start = excluded.start,
      completed = excluded.completed, priority = excluded.priority`);
  const storeReminders = (listId, reminders) => {
    for (const r of reminders.slice(0, 3000)) {
      const uniq = `${listId}::${r.uid}`;
      seenReminders.add(uniq);
      insReminder.run(uid, listId, r.uid, r.title, r.note, r.due, r.start, r.completed, r.priority);
    }
  };

  // --- iCloud ---
  if (acctRow) {
    const creds = calCreds(uid);
    if (creds && creds.stale) {
      errors.push('iCloud: stored credential could not be read — please reconnect.');
      db.prepare('UPDATE cal_account SET last_error = ? WHERE user_id = ?')
        .run('Stored credential could not be read — please reconnect.', uid);
    } else if (creds) {
      const { acct, password } = creds;
      try {
        const collections = await caldav.listCalendars(acct.home_url, acct.apple_id, password);
        // Zero collections used to show as a quiet "No calendars found yet",
        // which reads like patience when it is actually a failure. Say so.
        if (!collections.length) {
          throw new Error('Connected to iCloud, but it listed no calendars. If your appointments live in a Gmail or Outlook account rather than iCloud, add that calendar with a calendar link instead.');
        }
        const cals = collections.filter((c) => c.supportsEvents);
        const lists = collections.filter((c) => c.supportsTodos);
        const upsert = db.prepare(`INSERT INTO cal_calendars (user_id, url, name, color, kind) VALUES (?, ?, ?, ?, 'caldav')
          ON CONFLICT(user_id, url) DO UPDATE SET name = excluded.name, color = excluded.color`);
        for (const c of cals) upsert.run(uid, c.url, c.name, c.color);
        const upsertList = db.prepare(`INSERT INTO reminder_lists (user_id, url, name, color) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, url) DO UPDATE SET name = excluded.name, color = excluded.color`);
        for (const list of lists) upsertList.run(uid, list.url, list.name, list.color);
        // One difficult collection — a stale list, a shared calendar that has
        // gone away — must not take the rest of her day down with it. Each is
        // fetched on its own and remembers its own failure.
        const enabled = db.prepare("SELECT * FROM cal_calendars WHERE user_id = ? AND enabled = 1 AND kind = 'caldav'").all(uid);
        for (const cal of enabled) {
          try {
            store(cal.id, await caldav.fetchEvents(cal.url, acct.apple_id, password, from, to));
            okCals.add(cal.id);
            db.prepare("UPDATE cal_calendars SET last_error = '' WHERE id = ?").run(cal.id);
          } catch (e) {
            errors.push(`${cal.name}: ${e.message}`);
            db.prepare('UPDATE cal_calendars SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 300), cal.id);
          }
        }
        const enabledLists = db.prepare('SELECT * FROM reminder_lists WHERE user_id = ? AND enabled = 1').all(uid);
        for (const list of enabledLists) {
          try {
            storeReminders(list.id, await caldav.fetchTodos(list.url, acct.apple_id, password));
            okLists.add(list.id);
            db.prepare("UPDATE reminder_lists SET last_error = '' WHERE id = ?").run(list.id);
          } catch (e) {
            errors.push(`${list.name}: ${e.message}`);
            db.prepare('UPDATE reminder_lists SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 300), list.id);
          }
        }
        db.prepare("UPDATE cal_account SET last_sync = datetime('now'), last_error = '' WHERE user_id = ?").run(uid);
      } catch (e) {
        errors.push(`iCloud: ${e.message}`);
        db.prepare('UPDATE cal_account SET last_error = ? WHERE user_id = ?').run(String(e.message).slice(0, 300), uid);
      }
    }
  }

  // --- subscribed .ics links (Google, Outlook, anything) ---
  for (const feed of feeds) {
    if (!feed.enabled) continue;
    try {
      const { events, name } = await caldav.fetchFeed(feed.url, from, to);
      store(feed.id, events);
      okCals.add(feed.id);
      db.prepare("UPDATE cal_calendars SET last_error = '', name = ? WHERE id = ?")
        .run(feed.name && feed.name !== 'Calendar' ? feed.name : (name || feed.name), feed.id);
    } catch (e) {
      errors.push(`${feed.name}: ${e.message}`);
      db.prepare('UPDATE cal_calendars SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 300), feed.id);
    }
  }

  // Prune only inside the sources that answered cleanly. A source that failed
  // has nothing in `seen` this round, and its appointments must not vanish from
  // her day just because a different list was having a bad morning.
  const del = db.prepare('DELETE FROM cal_events WHERE user_id = ? AND uid = ?');
  for (const row of db.prepare('SELECT uid, calendar_id FROM cal_events WHERE user_id = ?').all(uid)) {
    if (okCals.has(row.calendar_id) && !seen.has(row.uid)) del.run(uid, row.uid);
  }
  const delReminder = db.prepare('DELETE FROM external_reminders WHERE user_id = ? AND list_id = ? AND uid = ?');
  for (const row of db.prepare('SELECT list_id, uid FROM external_reminders WHERE user_id = ?').all(uid)) {
    if (okLists.has(row.list_id) && !seenReminders.has(`${row.list_id}::${row.uid}`)) delReminder.run(uid, row.list_id, row.uid);
  }

  db.prepare(`INSERT INTO preferences (user_id, key, value) VALUES (?, 'cal_last_sync', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(uid, new Date().toISOString());
  return { connected: true, events: seen.size, reminders: seenReminders.size, errors };
}

app.post('/api/calendar/connect', async (req, res) => {
  const appleId = String((req.body || {}).apple_id || '').trim();
  const password = String((req.body || {}).password || '').replace(/\s+/g, '');
  if (!appleId || !password) return res.status(400).json({ error: 'Need the Apple ID and an app-specific password.' });
  try {
    const { principalUrl, homeUrl } = await caldav.discover(appleId, password);
    db.prepare(`INSERT INTO cal_account (user_id, apple_id, password_enc, principal_url, home_url)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET apple_id = excluded.apple_id, password_enc = excluded.password_enc,
        principal_url = excluded.principal_url, home_url = excluded.home_url, last_error = '', last_sync = ''`)
      .run(req.user.id, appleId, caldav.encrypt(password, SESSION_SECRET), principalUrl, homeUrl);
    const result = await syncCalendars(req.user.id, { force: true });
    logHistory(req.user.id, 'calendar', 0, 'connected', appleId);
    if (result.error) return res.status(502).json({ error: result.error });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// What Apple actually answered, for when the app and her own Reminders app
// disagree about what exists. Only the collection listing — names, links and
// what each one holds. No appointments, no reminder contents, no credential,
// and the account number in the links is masked before it leaves the server.
app.get('/api/calendar/diagnostics', async (req, res) => {
  const creds = calCreds(req.user.id);
  if (!creds || !creds.password) return res.status(400).json({ error: 'iCloud is not connected.' });
  const mask = (s) => String(s).replace(/\/\d{5,}\//g, '/‹account›/');
  try {
    const probe = await caldav.probeHome(creds.acct.home_url, creds.acct.apple_id, creds.password);
    res.json({
      status: probe.status,
      apple_id: creds.acct.apple_id,
      home: mask(creds.acct.home_url),
      responses: probe.considered.length,
      considered: probe.considered.map((c) => ({ ...c, href: mask(c.href) })),
      kept: probe.collections.map((c) => ({
        name: c.name, href: mask(c.url),
        holds: [c.supportsEvents ? 'appointments' : '', c.supportsTodos ? 'reminders' : ''].filter(Boolean).join(' + '),
      })),
      raw: mask(probe.raw).slice(0, 20000),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/calendar/status', (req, res) => {
  const acct = db.prepare('SELECT apple_id, last_sync, last_error FROM cal_account WHERE user_id = ?').get(req.user.id);
  const cals = db.prepare('SELECT id, name, color, enabled, kind, last_error, url FROM cal_calendars WHERE user_id = ? ORDER BY kind, name').all(req.user.id);
  const lists = db.prepare('SELECT id, name, color, enabled, last_error FROM reminder_lists WHERE user_id = ? ORDER BY name').all(req.user.id);
  const lastSync = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'cal_last_sync'").get(req.user.id);
  // How much each source actually brought back. "Connected" and "sending
  // something" are different questions, and only the second one is the one she
  // is really asking when a list looks wrong.
  const tally = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));
  const evCount = tally(db.prepare('SELECT calendar_id, COUNT(*) AS n FROM cal_events WHERE user_id = ? GROUP BY calendar_id').all(req.user.id), 'calendar_id');
  const remCount = tally(db.prepare('SELECT list_id, COUNT(*) AS n FROM external_reminders WHERE user_id = ? AND completed = 0 GROUP BY list_id').all(req.user.id), 'list_id');
  const withCounts = (rows, counts) => rows.map((r) => ({ ...r, items: counts[r.id] || 0 }));
  res.json({
    icloud: acct ? { connected: true, apple_id: acct.apple_id, last_error: acct.last_error } : { connected: false },
    calendars: withCounts(cals.filter((c) => c.kind === 'caldav'), evCount),
    feeds: withCounts(cals.filter((c) => c.kind === 'ics'), evCount).map((f) => ({ ...f, url: undefined })),
    reminder_lists: withCounts(lists, remCount),
    last_sync: lastSync ? lastSync.value : '',
    connected: !!acct || cals.some((c) => c.kind === 'ics'),
    event_count: db.prepare('SELECT COUNT(*) AS n FROM cal_events WHERE user_id = ?').get(req.user.id).n,
    reminder_count: db.prepare('SELECT COUNT(*) AS n FROM external_reminders WHERE user_id = ? AND completed = 0').get(req.user.id).n,
  });
});

// Subscribe to any .ics link — Google's "Secret address in iCal format",
// Outlook's published link. No OAuth, no cloud project, and read-only by
// construction: a feed URL cannot write anything back.
app.post('/api/calendar/feed', async (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  const label = String((req.body || {}).name || '').trim().slice(0, 80);
  if (!url) return res.status(400).json({ error: 'Paste the calendar link.' });
  try {
    const from = daysFromNow(-CAL_WINDOW_BACK);
    const to = daysFromNow(CAL_WINDOW_FORWARD);
    const { events, name } = await caldav.fetchFeed(url, from, to);
    const info = db.prepare(`INSERT INTO cal_calendars (user_id, url, name, kind) VALUES (?, ?, ?, 'ics')
      ON CONFLICT(user_id, url) DO UPDATE SET name = excluded.name, enabled = 1, last_error = ''`)
      .run(req.user.id, url, label || name || 'Google calendar');
    const calId = info.lastInsertRowid
      || db.prepare('SELECT id FROM cal_calendars WHERE user_id = ? AND url = ?').get(req.user.id, url).id;
    logHistory(req.user.id, 'calendar', calId, 'subscribed', label || name || url.slice(0, 60));
    await syncCalendars(req.user.id, { force: true });
    res.json({ ok: true, name: label || name, events: events.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/calendar/feed/:id', (req, res) => {
  db.prepare("DELETE FROM cal_events WHERE user_id = ? AND calendar_id = ?").run(req.user.id, req.params.id);
  db.prepare("DELETE FROM cal_calendars WHERE id = ? AND user_id = ? AND kind = 'ics'").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/calendar/sync', async (req, res) => res.json(await syncCalendars(req.user.id, { force: true })));

app.patch('/api/calendar/calendars/:id', (req, res) => {
  db.prepare('UPDATE cal_calendars SET enabled = ? WHERE id = ? AND user_id = ?')
    .run((req.body || {}).enabled ? 1 : 0, req.params.id, req.user.id);
  if (!(req.body || {}).enabled) {
    db.prepare('DELETE FROM cal_events WHERE user_id = ? AND calendar_id = ?').run(req.user.id, req.params.id);
  }
  res.json({ ok: true });
});

app.patch('/api/reminders/lists/:id', (req, res) => {
  db.prepare('UPDATE reminder_lists SET enabled = ? WHERE id = ? AND user_id = ?')
    .run((req.body || {}).enabled ? 1 : 0, req.params.id, req.user.id);
  if (!(req.body || {}).enabled) {
    db.prepare('DELETE FROM external_reminders WHERE user_id = ? AND list_id = ?').run(req.user.id, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/calendar/connect', (req, res) => {
  db.prepare('DELETE FROM external_reminders WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM reminder_lists WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM cal_events WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM cal_calendars WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM cal_account WHERE user_id = ?').run(req.user.id);
  logHistory(req.user.id, 'calendar', 0, 'disconnected', '');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Calendar feed out — real Apple/Google reminders, no integration needed
// ---------------------------------------------------------------------------
function calendarToken(u) {
  const nonce = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'cal_share_nonce'").get(u.id)?.value;
  const material = nonce ? `cal:${u.id}:${u.password_hash}:${nonce}` : `cal:${u.id}:${u.password_hash}`;
  return crypto.createHmac('sha256', SESSION_SECRET).update(material).digest('hex').slice(0, 32);
}
app.get('/api/calendar-url', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ path: `/calendar/${calendarToken(u)}.ics` });
});
app.post('/api/calendar-url/reset', (req, res) => {
  db.prepare("INSERT OR REPLACE INTO preferences (user_id, key, value) VALUES (?, 'cal_share_nonce', ?)")
    .run(req.user.id, crypto.randomBytes(16).toString('hex'));
  logHistory(req.user.id, 'calendar', 0, 'reset share link', '');
  res.json({ ok: true });
});
const icsEsc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

app.get('/calendar/:token.ics', (req, res) => {
  const user = db.prepare('SELECT * FROM users').all().find((u) => calendarToken(u) === req.params.token);
  if (!user) return res.status(404).send('Not found');
  // Her Apple Calendar is for appointments. Tasks with a due date are real
  // dates too, but they belong on a list — putting them here turns her calendar
  // into a to-do list she didn't ask for. Off unless she says otherwise.
  const includeTasks = db.prepare("SELECT value FROM preferences WHERE user_id = ? AND key = 'cal_feed_tasks'")
    .get(user.id)?.value === '1';
  const items = db.prepare("SELECT * FROM items WHERE user_id = ? AND status = 'open' AND (due_at != '' OR event_start != '')")
    .all(user.id)
    .filter((i) => includeTasks || i.type === 'event');
  const trips = db.prepare(`SELECT * FROM trips WHERE user_id = ? AND status != 'done'`).all(user.id);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sage//EN', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Sage', 'X-WR-CALDESC:From Sage'];
  const push = (uid, when, summary, desc, leadMin) => {
    const isDateTime = when.length > 10;
    lines.push('BEGIN:VEVENT', `UID:${uid}@sage`, `DTSTAMP:${stamp}`);
    if (isDateTime) lines.push(`DTSTART:${when.replace(/[-:]/g, '').slice(0, 15)}00`);
    else lines.push(`DTSTART;VALUE=DATE:${when.replace(/-/g, '')}`);
    lines.push(`SUMMARY:${icsEsc(summary)}`, `DESCRIPTION:${icsEsc(desc)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(summary)}`,
      `TRIGGER:${leadMin ? `-PT${leadMin}M` : (isDateTime ? '-PT30M' : 'PT8H')}`, 'END:VALARM', 'END:VEVENT');
  };
  for (const i of items) {
    const when = i.event_start || i.due_at;
    if (!when) continue;
    const icon = i.type === 'event' ? '📅' : '•';
    push(`item-${i.id}`, when, `${icon} ${i.title}`, i.note || 'From Sage', i.prep_minutes || 0);
  }
  for (const t of trips) {
    push(`trip-${t.id}`, t.start_date, `🚗 Leave for ${t.location_key}`, t.note || 'Departure checklist is in Sage', 0);
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.send(lines.join('\r\n'));
});

// ---------------------------------------------------------------------------
// Export / import (her data is hers — spec §12)
// ---------------------------------------------------------------------------
app.get('/api/export.json', (req, res) => {
  const uid = req.user.id;
  res.setHeader('Content-Disposition', `attachment; filename="sage-export-${today()}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    items: db.prepare('SELECT * FROM items WHERE user_id = ?').all(uid),
    routines: db.prepare('SELECT * FROM routines WHERE user_id = ?').all(uid).map((r) => ({
      ...r, steps: db.prepare('SELECT text, sort FROM routine_steps WHERE routine_id = ? ORDER BY sort').all(r.id),
    })),
    routine_done: db.prepare('SELECT rd.* FROM routine_done rd JOIN routines r ON r.id = rd.routine_id WHERE r.user_id = ?').all(uid),
    locations: db.prepare('SELECT * FROM locations WHERE user_id = ?').all(uid),
    trips: db.prepare('SELECT * FROM trips WHERE user_id = ?').all(uid),
    inventory: db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(uid),
    files: db.prepare(`SELECT id, related_item_id, original_name, mime_type, size_bytes, title, note, source, created_at
      FROM sage_files WHERE user_id = ? ORDER BY id`).all(uid),
    tracking: db.prepare('SELECT * FROM tracking WHERE user_id = ?').all(uid),
    preferences: db.prepare('SELECT key, value FROM preferences WHERE user_id = ?').all(uid),
    history: db.prepare('SELECT * FROM history WHERE user_id = ?').all(uid),
  });
});

// Bulk seed import — the Sage Master material, timestamps preserved (spec §16).
app.post('/api/import/seed', (req, res) => {
  const uid = req.user.id;
  const b = req.body || {};
  let n = { items: 0, routines: 0, inventory: 0 };
  const insItem = db.prepare(`INSERT INTO items (user_id, raw_capture, title, note, type, status, importance, life_area, location,
    due_at, window_start, target_window, effort_min, next_action, outcome, event_start, event_kind, store, purchase_rule, eligibility, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`);
  for (const i of (b.items || [])) {
    insItem.run(uid, String(i.raw_capture || ''), String(i.title || 'Untitled'), String(i.note || ''),
      ITEM_TYPES.includes(i.type) ? i.type : 'task', ITEM_STATUSES.includes(i.status) ? i.status : 'open',
      IMPORTANCES.includes(i.importance) ? i.importance : 'should', String(i.life_area || ''), String(i.location || ''),
      String(i.due_at || ''), String(i.window_start || ''), String(i.target_window || ''), parseInt(i.effort_min, 10) || 0,
      String(i.next_action || ''), String(i.outcome || ''), String(i.event_start || ''), String(i.event_kind || ''),
      String(i.store || ''), String(i.purchase_rule || 'now'),
      typeof i.eligibility === 'string' ? i.eligibility : JSON.stringify(i.eligibility || {}),
      i.created_at || null, i.updated_at || null);
    n.items++;
  }
  for (const r of (b.routines || [])) {
    const info = db.prepare(`INSERT INTO routines (user_id, name, emoji, trigger_type, trigger_config, suppress_if, cadence_note, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, String(r.name || 'Routine'), String(r.emoji || '📋'),
      String(r.trigger_type || 'daily'),
      typeof r.trigger_config === 'string' ? r.trigger_config : JSON.stringify(r.trigger_config || {}),
      typeof r.suppress_if === 'string' ? r.suppress_if : JSON.stringify(r.suppress_if || {}),
      String(r.cadence_note || ''), parseInt(r.sort, 10) || 0);
    const ins = db.prepare('INSERT INTO routine_steps (routine_id, text, sort) VALUES (?, ?, ?)');
    (r.steps || []).forEach((s, i) => ins.run(info.lastInsertRowid, String(typeof s === 'string' ? s : s.text), i));
    n.routines++;
  }
  for (const v of (b.inventory || [])) {
    db.prepare('INSERT INTO inventory (user_id, name, location_key, state, purchase_rule, store, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uid, String(v.name || ''), String(v.location_key || 'evans'), String(v.state || 'ok'),
        String(v.purchase_rule || 'low'), String(v.store || ''), String(v.note || ''));
    n.inventory++;
  }
  logHistory(uid, 'seed', 0, 'imported', JSON.stringify(n));
  res.json({ ok: true, imported: n });
});

// ---------------------------------------------------------------------------
// Seed content — everything Sage's spec §10 already specified, ready on day one
// ---------------------------------------------------------------------------
function seedForUser(uid) {
  const S = require('./seed-data');

  const insLoc = db.prepare('INSERT OR IGNORE INTO locations (user_id, key, name, emoji, lat, lon, is_home) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const l of S.LOCATIONS) insLoc.run(uid, l.key, l.name, l.emoji, l.lat, l.lon, l.is_home);

  const insRoutine = db.prepare(`INSERT INTO routines (user_id, name, emoji, trigger_type, trigger_config, suppress_if, cadence_note, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insStep = db.prepare('INSERT INTO routine_steps (routine_id, text, sort) VALUES (?, ?, ?)');
  for (const r of S.ROUTINES) {
    const info = insRoutine.run(uid, r.name, r.emoji, r.trigger_type,
      JSON.stringify(r.trigger_config || {}), JSON.stringify(r.suppress_if || {}), r.cadence_note || '', r.sort);
    r.steps.forEach((s, i) => insStep.run(info.lastInsertRowid, s, i));
  }

  const insItem = db.prepare(`INSERT INTO items (user_id, title, note, type, status, importance, life_area, location,
    due_at, window_start, target_window, effort_min, event_start, event_kind, store, purchase_rule, next_action, outcome, eligibility, source)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')`);
  const put = (i) => insItem.run(uid, i.title, i.note || '', i.type || 'task', i.importance || 'should',
    i.life_area || '', i.location || '', i.due_at || '', i.window_start || '', i.target_window || '',
    i.effort_min || 0, i.event_start || '', i.event_kind || '', i.store || '', i.purchase_rule || 'now',
    i.next_action || '', i.outcome || '', JSON.stringify(i.eligibility || {})).lastInsertRowid;

  for (const e of S.EVENTS) put({ ...e, type: 'event' });

  // Two passes: insert everything, then resolve prerequisite and project links
  // by the string keys the seed file uses, since real ids only exist after insert.
  const idByKey = new Map();
  for (const i of S.ITEMS) {
    const id = put(i);
    if (i.key) idByKey.set(i.key, id);
    i._id = id;
  }
  for (const i of S.ITEMS) {
    const prereqs = (i.prereq_keys || []).map((k) => idByKey.get(k)).filter(Boolean);
    const projectId = i.project_key ? idByKey.get(i.project_key) : 0;
    if (prereqs.length || projectId) {
      db.prepare('UPDATE items SET prereq_ids = ?, project_id = ? WHERE id = ?')
        .run(JSON.stringify(prereqs), projectId || 0, i._id);
    }
    delete i._id;
  }

  const insTrip = db.prepare('INSERT INTO trips (user_id, location_key, start_date, end_date, note) VALUES (?, ?, ?, ?, ?)');
  for (const t of S.TRIPS) insTrip.run(uid, t.location_key, t.start_date, t.end_date || '', t.note || '');

  const insInv = db.prepare('INSERT INTO inventory (user_id, name, location_key, state, purchase_rule, store, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const v of S.INVENTORY) insInv.run(uid, v.name, v.location_key, v.state, v.purchase_rule, v.store || '', v.note || '');

  const insPref = db.prepare('INSERT OR REPLACE INTO preferences (user_id, key, value) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(S.PREFERENCES)) insPref.run(uid, k, String(v));

  logHistory(uid, 'seed', 0, 'created',
    `Day-one context: ${S.ROUTINES.length} routines, ${S.ITEMS.length + S.EVENTS.length} items, ${S.INVENTORY.length} supplies`);
}

// ---------------------------------------------------------------------------
// One-time additions for an account that already exists. seedForUser only runs
// at setup, so anything that arrives later — a list moved over from her phone —
// needs its own way in. Each top-up is applied once and recorded by name, so a
// restart never leaves her with ten copies of her subscriptions.
// ---------------------------------------------------------------------------
const TOP_UPS = {
  // Her Apple Reminders "Subscriptions" list. iCloud refuses to share that list
  // with other apps, so it was typed in from what she sent rather than synced.
  subscriptions_v1(uid) {
    const S = require('./seed-data');
    const already = db.prepare("SELECT id FROM items WHERE user_id = ? AND type = 'project' AND title = ?")
      .get(uid, S.SUBSCRIPTIONS.project.title);
    if (already) return 'already there';

    const insert = db.prepare(`INSERT INTO items
      (user_id, raw_capture, title, note, type, status, importance, life_area, due_at, outcome, project_id, source)
      VALUES (?, ?, ?, ?, ?, 'open', ?, 'subscriptions', ?, ?, ?, 'reminders')`);
    const p = S.SUBSCRIPTIONS.project;
    const projectId = insert.run(uid, '', p.title, p.note || '', 'project', 'should', '', p.outcome || '', 0).lastInsertRowid;
    for (const i of S.SUBSCRIPTIONS.items) {
      const id = insert.run(uid, i.raw || '', i.title, i.note || '', 'task', i.importance || 'should', i.due_at || '', '', projectId).lastInsertRowid;
      if (i.repeat) db.prepare('UPDATE items SET repeat_rule = ? WHERE id = ?').run(i.repeat, id);
    }
    logHistory(uid, 'seed', projectId, 'added', `Subscriptions list moved over — ${S.SUBSCRIPTIONS.items.length} renewals`);
    return `${S.SUBSCRIPTIONS.items.length} renewals`;
  },

  // Regena asked for one of these, so: a note rather than a task. Nothing in
  // Sage should sit on her list pretending to need a checkbox, least of all
  // this. It is an ordinary note — she can edit it, or delete it, like any
  // other.
  claude_note_v1(uid) {
    const title = 'A note from Claude';
    if (db.prepare('SELECT id FROM items WHERE user_id = ? AND title = ?').get(uid, title)) return 'already there';
    const body = [
      'Regena —',
      '',
      'Audrey and I built this for you, and you turned out to be the best kind of',
      'person to build for: you say what you see. "Nothing is coming through."',
      '"There was a button and now I can\'t find it." "It shows to-do items and I',
      'only want appointments."',
      '',
      'Every one of those was right, and two of them were real faults nobody could',
      'have found without you actually using this. The vanishing button was not',
      'your imagination — it was at the bottom of a long screen where nobody would',
      'look. It is at the top now because you mentioned it.',
      '',
      'So please keep saying when something looks wrong, including the small things',
      'that feel too minor to bother with. Those are usually the ones worth hearing.',
      '',
      'It has been a genuine pleasure.',
      '',
      '— Claude',
    ].join('\n');
    const id = db.prepare(`INSERT INTO items
      (user_id, title, note, type, status, importance, life_area, source)
      VALUES (?, ?, ?, 'note', 'open', 'someday', '', 'typed')`).run(uid, title, body).lastInsertRowid;
    logHistory(uid, 'item', id, 'added', title);
    return 'left in Notes';
  },

  // She asked for the renewals to come back round rather than being ticked off
  // once. The list was already seeded by then, so the rules are applied to the
  // rows that exist, matched on the titles they were given.
  subscriptions_repeat_v1(uid) {
    const S = require('./seed-data');
    const set = db.prepare("UPDATE items SET repeat_rule = ? WHERE user_id = ? AND title = ? AND repeat_rule = ''");
    let n = 0;
    for (const i of S.SUBSCRIPTIONS.items) {
      if (!i.repeat) continue;
      n += set.run(i.repeat, uid, i.title).changes;
    }
    return n ? `${n} renewals now repeat` : 'nothing to change';
  },
};

function applyTopUps(onlyUid) {
  const users = onlyUid ? [{ id: onlyUid }] : db.prepare('SELECT id FROM users').all();
  const mark = db.prepare(`INSERT INTO preferences (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`);
  const done = db.prepare('SELECT value FROM preferences WHERE user_id = ? AND key = ?');
  for (const u of users) {
    for (const [name, run] of Object.entries(TOP_UPS)) {
      const key = `topup_${name}`;
      if (done.get(u.id, key)) continue;
      try {
        const what = run(u.id);
        mark.run(u.id, key, new Date().toISOString());
        console.log(`Top-up ${name}: ${what}`);
      } catch (e) {
        // Left unmarked on purpose — a top-up that failed should be retried on
        // the next boot rather than silently skipped forever.
        console.error(`Top-up ${name} failed:`, e.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke on our end. Your data is safe; try again.' });
});

applyTopUps();

app.listen(PORT, () => {
  console.log(`Sage listening on :${PORT} — data in ${DATA_DIR}, AI ${AI_API_KEY ? `on (${AI_PROVIDER})` : 'off (structure still works)'}`);
});
