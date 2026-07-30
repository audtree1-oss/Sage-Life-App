// Read-only iCloud calendar access over CalDAV.
//
// Two deliberate constraints, both from the spec:
//   §11 "complement — do not casually replace — systems that already work"
//        → Sage never writes to her calendar. Not one request. Read only.
//   §12 "do not store passwords in ordinary Sage records"
//        → the app-specific password is encrypted at rest with a key derived
//          from SESSION_SECRET, lives in its own table, is never logged, and
//          is revocable from appleid.apple.com at any time without touching
//          this app. It is an integration credential, not stored content.
//
// Recurring events are expanded by iCloud itself via CalDAV's <C:expand>,
// rather than by re-implementing RRULE here — the server already knows the
// answer and gets it right.

const crypto = require('crypto');

const CALDAV_ROOT = 'https://caldav.icloud.com';

// --- credential encryption -------------------------------------------------
function keyFrom(secret) {
  return crypto.scryptSync(String(secret), 'sage-caldav-v1', 32);
}
function encrypt(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decrypt(blob, secret) {
  try {
    const [iv, tag, data] = String(blob).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // usually means SESSION_SECRET changed — caller asks her to reconnect
  }
}

// --- tolerant XML helpers --------------------------------------------------
// Namespace prefixes vary between servers (D:, d:, none). Strip them and match
// on the local name only.
function stripNs(xml) {
  return String(xml).replace(/<\/?[a-zA-Z0-9_-]+:/g, (m) => (m[1] === '/' ? '</' : '<'));
}
// Match on the local name only, and only when the name actually ends there —
// `<calendar-color>` must not answer to `calendar`. Attributes are allowed,
// because iCloud writes `<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>`
// where other servers write `<C:calendar/>`.
function openTag(tag) {
  return `<${tag}(?:\\s[^>]*?)?(/?)\\s*>`;
}
function allBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`${openTag(tag)}([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === '/') continue; // self-closing: no content to collect
    out.push(m[2]);
  }
  return out;
}
function firstValue(xml, tag) {
  const s = String(xml);
  const open = new RegExp(openTag(tag), 'i').exec(s);
  if (!open) return '';
  if (open[1] === '/') return ''; // <displayname/> — present but empty
  const rest = s.slice(open.index + open[0].length);
  const close = new RegExp(`</${tag}\\s*>`, 'i').exec(rest);
  return close ? rest.slice(0, close.index).trim() : '';
}
// Is this element present at all? Used for resourcetype flags, which carry
// their meaning in the tag name rather than in any content.
function hasElement(xml, tag) {
  return new RegExp(openTag(tag), 'i').test(String(xml));
}
// Numeric references matter more than they look: iCloud sends the CRLF line
// endings inside <calendar-data> as `&#13;`, so leaving them undecoded leaves a
// stray "&#13;" glued to the end of every DTSTART — the date then fails to
// parse and the appointment is silently dropped.
function decodeEntities(s) {
  const codePoint = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" survives as "&lt;"
}
function resolve(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

// --- the one request function ----------------------------------------------
async function dav(url, { method, body, depth = '0', auth, contentType = 'application/xml; charset=utf-8' }) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: 'Basic ' + Buffer.from(auth).toString('base64'),
      'content-type': contentType,
      depth,
      'user-agent': 'Sage/1.0',
    },
    body,
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text, url: res.url || url };
}

const PROP_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

const PROP_HOME = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop></D:propfind>`;

const PROP_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname/><D:resourcetype/>
    <C:supported-calendar-component-set/><A:calendar-color/>
  </D:prop></D:propfind>`;

function icalStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function queryBody(fromISO, toISO) {
  const start = icalStamp(fromISO), end = icalStamp(toISO);
  return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-data>
      <C:expand start="${start}" end="${end}"/>
    </C:calendar-data>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

function todoQueryBody() {
  return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

// --- discovery -------------------------------------------------------------
async function discover(appleId, password) {
  const auth = `${appleId}:${password}`;

  const r1 = await dav(CALDAV_ROOT, { method: 'PROPFIND', body: PROP_PRINCIPAL, auth });
  if (r1.status === 401) throw new Error('Apple rejected that Apple ID or app-specific password.');
  if (!r1.ok) throw new Error(`Apple returned ${r1.status} while looking up the account.`);

  const x1 = stripNs(r1.text);
  const principalHref = firstValue(firstValue(x1, 'current-user-principal'), 'href');
  if (!principalHref) throw new Error('Could not find the account principal. (Is two-factor set up with an app-specific password?)');
  const principalUrl = resolve(r1.url, decodeEntities(principalHref));

  const r2 = await dav(principalUrl, { method: 'PROPFIND', body: PROP_HOME, auth });
  if (!r2.ok) throw new Error(`Apple returned ${r2.status} while looking up the calendar home.`);
  const homeHref = firstValue(firstValue(stripNs(r2.text), 'calendar-home-set'), 'href');
  if (!homeHref) throw new Error('Could not find the calendar home.');
  const homeUrl = resolve(r2.url, decodeEntities(homeHref));

  return { principalUrl, homeUrl };
}

async function listCalendars(homeUrl, appleId, password) {
  const auth = `${appleId}:${password}`;
  const r = await dav(homeUrl, { method: 'PROPFIND', body: PROP_CALENDARS, depth: '1', auth });
  if (!r.ok) throw new Error(`Apple returned ${r.status} while listing calendars.`);
  return parseCollections(r.text, homeUrl);
}

// The same PROPFIND, kept whole: what Apple sent, what was made of it, and what
// was skipped along the way. Diagnosing this integration by reasoning about
// what Apple *probably* returns has been wrong twice; this asks it instead.
async function probeHome(homeUrl, appleId, password) {
  const r = await dav(homeUrl, {
    method: 'PROPFIND', body: PROP_CALENDARS, depth: '1', auth: `${appleId}:${password}`,
  });
  const seen = [];
  const collections = r.ok ? parseCollections(r.text, homeUrl, seen) : [];
  return { status: r.status, raw: r.text, collections, considered: seen };
}

function parseCollections(xmlText, homeUrl, considered) {
  const out = [];
  for (const block of allBlocks(stripNs(xmlText), 'response')) {
    const href = decodeEntities(firstValue(block, 'href'));
    const rawName = decodeEntities(firstValue(block, 'displayname')).trim();
    const note = (why) => { if (considered) considered.push({ href, name: rawName, skipped: why }); };
    if (!href) { note('no href'); continue; }
    const rtype = firstValue(block, 'resourcetype');
    if (!hasElement(rtype, 'calendar')) { note(`not a calendar collection (${rtype.replace(/\s+/g, ' ').trim().slice(0, 120) || 'no resourcetype'})`); continue; }
    const comps = firstValue(block, 'supported-calendar-component-set');
    const supportsEvents = !comps || /name=["']?VEVENT["']?/i.test(comps);
    const supportsTodos = /name=["']?VTODO["']?/i.test(comps);
    if (!supportsEvents && !supportsTodos) { note(`holds neither events nor reminders (${comps.replace(/\s+/g, ' ').trim().slice(0, 120) || 'none listed'})`); continue; }
    note('');
    // Some collections come back with no name, or with a literal "null" that a
    // third-party app wrote years ago. Neither is a name a person can act on.
    // A name that merely *contains* those words is hers, and stays untouched.
    const nameless = !rawName || /^(null|undefined)$/i.test(rawName);
    out.push({
      url: resolve(homeUrl, href),
      name: nameless ? (supportsTodos && !supportsEvents ? 'Unnamed list' : 'Unnamed calendar') : rawName,
      color: (decodeEntities(firstValue(block, 'calendar-color')) || '').slice(0, 9),
      supportsEvents,
      supportsTodos,
    });
  }
  return out;
}

// --- iCalendar parsing -----------------------------------------------------
function unfold(ics) {
  // RFC 5545 folds long lines with CRLF + a space or tab.
  return String(ics).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}
function icalUnescape(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Returns an ISO-ish local string: YYYY-MM-DD for all-day, YYYY-MM-DDTHH:MM otherwise.
function parseIcalDate(raw, params) {
  const isDateOnly = /VALUE=DATE(?!-TIME)/i.test(params || '') || /^\d{8}$/.test(raw);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw.trim());
  if (!m) return { value: '', allDay: isDateOnly };
  const [, y, mo, d, hh, mm, , z] = m;
  if (isDateOnly || !hh) return { value: `${y}-${mo}-${d}`, allDay: true };
  if (z) {
    // UTC — convert to the server's local time, which is the timezone the
    // rest of the app reasons in.
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
    const pad = (n) => String(n).padStart(2, '0');
    return { value: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`, allDay: false };
  }
  // Floating or TZID-qualified: iCloud sends these already in the event's own
  // zone, and treating them as local is what a person reading their calendar
  // expects.
  return { value: `${y}-${mo}-${d}T${hh}:${mm}`, allDay: false };
}

function parseEvents(icsText) {
  const events = [];
  for (const block of unfold(icsText).split(/BEGIN:VEVENT/i).slice(1)) {
    const body = block.split(/END:VEVENT/i)[0];
    const get = (name) => {
      const re = new RegExp(`^${name}([^:\\r\\n]*):(.*)$`, 'im');
      const m = re.exec(body);
      return m ? { params: m[1], value: m[2].trim() } : null;
    };
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    if (!dtstart) continue;
    const dtend = get('DTEND');
    const status = get('STATUS');
    if (status && /CANCELLED/i.test(status.value)) continue;
    const start = parseIcalDate(dtstart.value, dtstart.params);
    const end = dtend ? parseIcalDate(dtend.value, dtend.params) : { value: '' };
    events.push({
      uid: (get('UID') || { value: '' }).value + '|' + start.value,
      title: icalUnescape((summary || { value: '(untitled)' }).value).slice(0, 200),
      start: start.value,
      end: end.value,
      all_day: start.allDay ? 1 : 0,
      location: icalUnescape((get('LOCATION') || { value: '' }).value).slice(0, 200),
    });
  }
  return events;
}

function parseTodos(icsText) {
  const todos = [];
  for (const block of unfold(icsText).split(/BEGIN:VTODO/i).slice(1)) {
    const body = block.split(/END:VTODO/i)[0];
    const get = (name) => {
      const m = new RegExp(`^${name}([^:\\r\\n]*):(.*)$`, 'im').exec(body);
      return m ? { params: m[1], value: m[2].trim() } : null;
    };
    const uid = get('UID');
    const summary = get('SUMMARY');
    const due = get('DUE');
    const start = get('DTSTART');
    const status = get('STATUS');
    const completed = get('COMPLETED');
    const priority = parseInt((get('PRIORITY') || { value: '0' }).value, 10) || 0;
    if (!uid && !summary) continue;
    todos.push({
      uid: (uid || { value: (summary || { value: 'reminder' }).value }).value,
      title: icalUnescape((summary || { value: '(untitled reminder)' }).value).slice(0, 200),
      note: icalUnescape((get('DESCRIPTION') || { value: '' }).value).slice(0, 2000),
      due: due ? parseIcalDate(due.value, due.params).value : '',
      start: start ? parseIcalDate(start.value, start.params).value : '',
      completed: (completed || (status && /COMPLETED/i.test(status.value))) ? 1 : 0,
      priority,
    });
  }
  return todos;
}

async function fetchEvents(calendarUrl, appleId, password, fromISO, toISO) {
  const r = await dav(calendarUrl, {
    method: 'REPORT', body: queryBody(fromISO, toISO), depth: '1',
    auth: `${appleId}:${password}`,
  });
  if (!r.ok) throw new Error(`Apple returned ${r.status} while reading a calendar.`);
  const out = [];
  for (const block of allBlocks(stripNs(r.text), 'calendar-data')) {
    out.push(...parseEvents(decodeEntities(block)));
  }
  return out;
}

async function fetchTodos(listUrl, appleId, password) {
  const r = await dav(listUrl, {
    method: 'REPORT', body: todoQueryBody(), depth: '1',
    auth: `${appleId}:${password}`,
  });
  if (!r.ok) throw new Error(`Apple returned ${r.status} while reading a reminder list.`);
  const out = [];
  for (const block of allBlocks(stripNs(r.text), 'calendar-data')) {
    out.push(...parseTodos(decodeEntities(block)));
  }
  return out;
}

// A subscribed .ics feed — Google's "secret address in iCal format", Outlook's
// published link, anything that serves plain iCalendar. Unlike CalDAV nothing
// expands it server-side, so recurrence is worked out here.
const { parseCalendar } = require('./ical');

async function fetchFeed(url, fromISO, toISO) {
  const clean = String(url).trim().replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(clean)) throw new Error('That needs to be an https link ending in .ics');
  let res;
  try {
    res = await fetch(clean, { headers: { 'user-agent': 'Sage/1.0', accept: 'text/calendar, text/plain' }, redirect: 'follow' });
  } catch {
    // Node's own message here is "fetch failed", which tells her nothing.
    throw new Error('Could not reach that calendar link. It may have been reset in Google Calendar, or the connection is down.');
  }
  if (res.status === 404) throw new Error('That link came back "not found" — check it was copied whole.');
  if (res.status === 401 || res.status === 403) throw new Error('That link is private. In Google Calendar use the "Secret address in iCal format".');
  if (!res.ok) throw new Error(`The calendar link returned ${res.status}.`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar. Make sure it ends in .ics');
  return { events: parseCalendar(text, { from: fromISO, to: toISO }), name: calendarName(text) };
}

function calendarName(text) {
  const m = /^X-WR-CALNAME:(.*)$/im.exec(String(text).replace(/\r\n[ \t]/g, ''));
  return m ? m[1].trim().slice(0, 80) : '';
}

// Her Apple Calendar drives the trigger engine: a PT appointment there
// suppresses home PT exactly as one entered in Sage would. Only patterns that
// are unambiguous are inferred — everything else stays a plain appointment.
function inferEventKind(title) {
  const t = String(title).toLowerCase();
  if (/\bpt\b|physical therapy|physio/.test(t)) return 'pt';
  if (/\b(dr\.?|doctor|dentist|appt|appointment|clinic)\b/.test(t)) return 'appointment';
  return '';
}

module.exports = {
  encrypt, decrypt, discover, listCalendars, probeHome, fetchEvents, fetchTodos, fetchFeed, inferEventKind,
  _internals: { parseEvents, parseTodos, parseIcalDate, stripNs, unfold, calendarName, firstValue, allBlocks, hasElement },
};
