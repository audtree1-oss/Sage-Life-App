// Shared iCalendar parsing, including recurrence expansion.
//
// iCloud (over CalDAV) expands recurring events server-side, so those arrive
// ready to use. A subscribed .ics feed — Google's "secret address", Outlook's
// published link — does not: it sends one VEVENT with an RRULE and expects the
// reader to work out the instances. That expansion lives here.
//
// Scope is deliberate: the recurrence patterns real people actually create in
// a calendar app. Weekly Mahjong, monthly book club on the third Sunday,
// yearly birthdays, "every other Tuesday", with exceptions and edited single
// occurrences. Not the exotic corners of RFC 5545.

const MAX_INSTANCES = 750;      // per event, across the whole window
const DAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// --- text handling ---------------------------------------------------------
function unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').replace(/\r\n/g, '\n');
}
function unescape_(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Split "DTSTART;TZID=America/New_York:20260730T093000" into name, params, value.
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = left.indexOf(';');
  return semi < 0
    ? { name: left.toUpperCase(), params: '', value }
    : { name: left.slice(0, semi).toUpperCase(), params: left.slice(semi + 1), value };
}

// --- dates -----------------------------------------------------------------
// Everything is handled as wall-clock time. A calendar entry at 1pm means 1pm
// to the person reading it, which is the only interpretation that matters for
// deciding what to show her today.
function parseDT(value, params) {
  const raw = String(value).trim();
  const dateOnly = /VALUE=DATE(?!-TIME)/i.test(params || '') || /^\d{8}$/.test(raw);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mi, , z] = m;
  if (dateOnly || !hh) return { date: new Date(+y, +mo - 1, +d, 12, 0), allDay: true };
  if (z) {
    const utc = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi));
    return { date: utc, allDay: false };            // rendered in server-local time
  }
  return { date: new Date(+y, +mo - 1, +d, +hh, +mi), allDay: false };
}

const pad = (n) => String(n).padStart(2, '0');
function fmt(date, allDay) {
  const s = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return allDay ? s : `${s}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function dayKey(date) { return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`; }

// --- RRULE -----------------------------------------------------------------
function parseRRule(value) {
  const out = {};
  for (const part of String(value).split(';')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    out[k.toUpperCase()] = v;
  }
  const rule = {
    freq: (out.FREQ || '').toUpperCase(),
    interval: Math.max(1, parseInt(out.INTERVAL, 10) || 1),
    count: out.COUNT ? parseInt(out.COUNT, 10) : null,
    until: null,
    byDay: out.BYDAY ? out.BYDAY.split(',').map((d) => d.trim().toUpperCase()) : null,
    byMonthDay: out.BYMONTHDAY ? out.BYMONTHDAY.split(',').map((n) => parseInt(n, 10)) : null,
    byMonth: out.BYMONTH ? out.BYMONTH.split(',').map((n) => parseInt(n, 10)) : null,
  };
  if (out.UNTIL) {
    const p = parseDT(out.UNTIL, /^\d{8}$/.test(out.UNTIL) ? 'VALUE=DATE' : '');
    if (p) rule.until = p.date;
  }
  return rule;
}

// "3SU" -> {ord: 3, day: 0}; "-1FR" -> {ord: -1, day: 5}; "MO" -> {ord: 0, day: 1}
function parseByDay(token) {
  const m = /^([+-]?\d)?([A-Z]{2})$/.exec(token);
  if (!m) return null;
  const day = DAY_NAMES.indexOf(m[2]);
  if (day < 0) return null;
  return { ord: m[1] ? parseInt(m[1], 10) : 0, day };
}

// Nth weekday of a month; ord < 0 counts back from the end.
function nthWeekdayOfMonth(year, month, day, ord) {
  if (ord > 0) {
    const first = new Date(year, month, 1);
    const shift = (day - first.getDay() + 7) % 7;
    const date = 1 + shift + (ord - 1) * 7;
    return date > new Date(year, month + 1, 0).getDate() ? null : new Date(year, month, date);
  }
  const lastDay = new Date(year, month + 1, 0).getDate();
  const last = new Date(year, month, lastDay);
  const shift = (last.getDay() - day + 7) % 7;
  const date = lastDay - shift + (ord + 1) * 7;
  return date < 1 ? null : new Date(year, month, date);
}

function withTime(date, template) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), template.getHours(), template.getMinutes());
}

// Every start time this rule produces inside [from, to].
function expandRule(start, rule, from, to) {
  const out = [];
  if (!rule.freq) return [start];
  const hardStop = rule.until && rule.until < to ? rule.until : to;
  let emitted = 0;
  let guard = 0;

  const push = (d) => {
    if (rule.count !== null && emitted >= rule.count) return false;
    if (d > hardStop) return false;
    emitted++;                                   // COUNT counts from the series start
    if (d >= from) out.push(d);
    return out.length < MAX_INSTANCES;
  };

  if (rule.freq === 'DAILY') {
    let d = new Date(start);
    while (d <= hardStop && guard++ < 5000) {
      if (!push(new Date(d))) break;
      d.setDate(d.getDate() + rule.interval);
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byDay ? rule.byDay.map(parseByDay).filter(Boolean).map((x) => x.day) : [start.getDay()];
    // Walk week by week from the start of the series' own week.
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    let w = new Date(weekStart);
    outer:
    while (w <= hardStop && guard++ < 5000) {
      for (const dow of [...days].sort((a, b) => a - b)) {
        const d = new Date(w);
        d.setDate(d.getDate() + dow);
        const at = withTime(d, start);
        if (at < start) continue;                // nothing before the series begins
        if (!push(at)) break outer;
      }
      w.setDate(w.getDate() + 7 * rule.interval);
    }
  } else if (rule.freq === 'MONTHLY') {
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= hardStop && guard++ < 2000) {
      const y = cursor.getFullYear(), mo = cursor.getMonth();
      let candidates = [];
      if (rule.byDay) {
        for (const token of rule.byDay) {
          const p = parseByDay(token);
          if (!p) continue;
          if (p.ord) {
            const d = nthWeekdayOfMonth(y, mo, p.day, p.ord);
            if (d) candidates.push(d);
          } else {
            // No ordinal: every matching weekday in the month.
            const last = new Date(y, mo + 1, 0).getDate();
            for (let dd = 1; dd <= last; dd++) {
              const d = new Date(y, mo, dd);
              if (d.getDay() === p.day) candidates.push(d);
            }
          }
        }
      } else if (rule.byMonthDay) {
        const last = new Date(y, mo + 1, 0).getDate();
        for (const n of rule.byMonthDay) {
          const dd = n > 0 ? n : last + n + 1;
          if (dd >= 1 && dd <= last) candidates.push(new Date(y, mo, dd));
        }
      } else {
        // Same day-of-month as the start; skip months that are too short,
        // which is what calendar apps do with a 31st.
        if (start.getDate() <= new Date(y, mo + 1, 0).getDate()) candidates.push(new Date(y, mo, start.getDate()));
      }
      candidates.sort((a, b) => a - b);
      for (const c of candidates) {
        const at = withTime(c, start);
        if (at < start) continue;
        if (!push(at)) { guard = Infinity; break; }
      }
      cursor = new Date(y, mo + rule.interval, 1);
    }
  } else if (rule.freq === 'YEARLY') {
    let y = start.getFullYear();
    while (y <= hardStop.getFullYear() + 1 && guard++ < 500) {
      const months = rule.byMonth ? rule.byMonth.map((m) => m - 1) : [start.getMonth()];
      for (const mo of months) {
        const dd = rule.byMonthDay ? rule.byMonthDay[0] : start.getDate();
        if (dd > new Date(y, mo + 1, 0).getDate()) continue;
        const at = withTime(new Date(y, mo, dd), start);
        if (at < start) continue;
        if (!push(at)) { guard = Infinity; break; }
      }
      y += rule.interval;
    }
  } else {
    return [start];
  }
  return out;
}

// --- the whole calendar ----------------------------------------------------
// A window given as "2026-08-03" means the whole of that day in her time,
// not midnight at its start — otherwise a 9am event on the last day vanishes.
function windowBound(value, fallbackMs, endOfDay) {
  const raw = value === undefined || value === null ? new Date(Date.now() + fallbackMs) : value;
  const m = typeof raw === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    return endOfDay
      ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59)
      : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  }
  const d = new Date(raw);
  if (endOfDay && typeof raw !== 'string') return d;
  return d;
}

function parseCalendar(text, { from, to } = {}) {
  const fromDate = windowBound(from, -30 * 86400000, false);
  const toDate = windowBound(to, 180 * 86400000, true);
  const blocks = unfold(text).split(/BEGIN:VEVENT/i).slice(1);

  const masters = [];
  const overrides = new Map();       // "uid|YYYYMMDD" -> event, an edited single occurrence

  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0];
    const props = {};
    const exdates = [];
    for (const line of body.split('\n')) {
      const p = parseLine(line.trim());
      if (!p) continue;
      if (p.name === 'EXDATE') {
        for (const v of p.value.split(',')) {
          const d = parseDT(v, p.params);
          if (d) exdates.push(dayKey(d.date));
        }
        continue;
      }
      if (!(p.name in props)) props[p.name] = p;
    }
    if (!props.DTSTART) continue;
    if (props.STATUS && /CANCELLED/i.test(props.STATUS.value)) continue;

    const start = parseDT(props.DTSTART.value, props.DTSTART.params);
    if (!start) continue;
    const end = props.DTEND ? parseDT(props.DTEND.value, props.DTEND.params) : null;

    const ev = {
      uid: props.UID ? props.UID.value : `noid-${masters.length}`,
      title: unescape_(props.SUMMARY ? props.SUMMARY.value : '(untitled)').slice(0, 200),
      location: unescape_(props.LOCATION ? props.LOCATION.value : '').slice(0, 200),
      start: start.date,
      allDay: start.allDay,
      durationMs: end ? Math.max(0, end.date - start.date) : 0,
      rrule: props.RRULE ? parseRRule(props.RRULE.value) : null,
      exdates,
    };

    if (props['RECURRENCE-ID']) {
      const rid = parseDT(props['RECURRENCE-ID'].value, props['RECURRENCE-ID'].params);
      if (rid) { overrides.set(`${ev.uid}|${dayKey(rid.date)}`, ev); continue; }
    }
    masters.push(ev);
  }

  const out = [];
  const emit = (ev, when) => {
    if (when < fromDate || when > toDate) return;
    const endAt = ev.durationMs ? new Date(when.getTime() + ev.durationMs) : null;
    out.push({
      uid: `${ev.uid}|${fmt(when, ev.allDay)}`,
      title: ev.title,
      start: fmt(when, ev.allDay),
      end: endAt ? fmt(endAt, ev.allDay) : '',
      all_day: ev.allDay ? 1 : 0,
      location: ev.location,
    });
  };

  for (const ev of masters) {
    if (!ev.rrule) { emit(ev, ev.start); continue; }
    for (const when of expandRule(ev.start, ev.rrule, fromDate, toDate)) {
      const key = dayKey(when);
      if (ev.exdates.includes(key)) continue;              // deleted occurrence
      const override = overrides.get(`${ev.uid}|${key}`);
      if (override) { emit(override, override.start); continue; }   // edited occurrence
      emit(ev, when);
    }
  }
  // Any override outside its series' expansion still deserves to show up.
  for (const [key, ev] of overrides) {
    const uid = key.split('|')[0];
    if (!masters.some((m) => m.uid === uid && m.rrule)) emit(ev, ev.start);
  }
  return out;
}

module.exports = { parseCalendar, _internals: { expandRule, parseRRule, parseDT, unfold, nthWeekdayOfMonth } };
