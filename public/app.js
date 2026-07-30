/* Sage frontend. One file, no framework, no build step.
   Rules from the spec that shaped this file:
   - Actions first, prose never in the way.
   - Morning view aims at one iPhone screen.
   - Voice capture is first-class, typing is never required.
   - Regena never maintains the taxonomy; she talks, and corrects in words. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function linkify(text) {
  const source = String(text ?? '');
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/gi;
  let html = '';
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    html += esc(source.slice(last, match.index));
    let url = match[2] || match[3];
    let suffix = '';
    if (!match[2]) {
      const trailing = url.match(/[.,!?;:)]+$/);
      if (trailing) {
        suffix = trailing[0];
        url = url.slice(0, -suffix.length);
      }
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsafe protocol');
      html += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(match[1] || url)}</a>${esc(suffix)}`;
    } catch {
      html += esc(match[0]);
    }
    last = match.index + match[0].length;
  }
  return html + esc(source.slice(last));
}
const today = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

const TYPES = { task: '✓ Task', event: '📅 Event', project: '🎯 Project', opportunity: '🌱 Opportunity', shopping: '🛒 Shopping', note: '📝 Note' };
const IMPORTANCE = { must: 'Must do', should: 'Should do', opportunity: 'Opportunity', someday: 'Someday' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/me') { boot(); throw new Error('signed out'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const bytesFromB64 = (s) => {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64FromBytes = (value) => {
  if (value === null || value === undefined) return null;
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
function registrationOptionsFromJSON(o) {
  return {
    ...o,
    challenge: bytesFromB64(o.challenge),
    user: { ...o.user, id: bytesFromB64(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: bytesFromB64(c.id) })),
  };
}
function authenticationOptionsFromJSON(o) {
  return {
    ...o,
    challenge: bytesFromB64(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: bytesFromB64(c.id) })),
  };
}
function credentialToJSON(c) {
  const r = c.response;
  const response = { clientDataJSON: b64FromBytes(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b64FromBytes(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
    response.publicKeyAlgorithm = r.getPublicKeyAlgorithm ? r.getPublicKeyAlgorithm() : undefined;
    if (r.getAuthenticatorData) response.authenticatorData = b64FromBytes(r.getAuthenticatorData());
    if (r.getPublicKey) response.publicKey = b64FromBytes(r.getPublicKey());
  } else {
    response.authenticatorData = b64FromBytes(r.authenticatorData);
    response.signature = b64FromBytes(r.signature);
    if (r.userHandle) response.userHandle = b64FromBytes(r.userHandle);
  }
  return {
    id: c.id, rawId: b64FromBytes(c.rawId), type: c.type,
    authenticatorAttachment: c.authenticatorAttachment,
    clientExtensionResults: c.getClientExtensionResults(), response,
  };
}

function toast(msg, ms = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function openModal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  $('#modal-root').appendChild(back);
  const c = document.createElement('button');
  c.className = 'close'; c.textContent = '✕'; c.onclick = closeModal;
  $('.modal', back).prepend(c);
  return $('.modal', back);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function fmtDate(d) {
  if (!d) return '';
  const day = d.slice(0, 10);
  const t = today();
  if (day === t) return 'today';
  const diff = Math.round((new Date(day) - new Date(t)) / 86400000);
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff < -1) return `${-diff} days ago`;
  if (diff <= 6) return new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(day + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTime(dt) {
  if (!dt || dt.length <= 10) return '';
  return new Date(dt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Boot / auth
// ---------------------------------------------------------------------------
let ME = null, AI_ON = false;

async function boot() {
  const { needsSetup, user, ai } = await api('/api/me');
  AI_ON = !!ai;
  if (user) { ME = user; $('#nav').classList.remove('hidden'); setView('now'); }
  else renderAuth(needsSetup);
}

function renderAuth(needsSetup) {
  $('#nav').classList.add('hidden');
  $('#main').innerHTML = `
    <div class="login-wrap">
      <h1>🌿 Sage</h1>
      <p class="sub center">${needsSetup ? 'Let’s get you set up. This takes about twenty seconds.' : 'Welcome back.'}</p>
      <div class="card">
        ${needsSetup ? '<label class="field">Your name</label><input type="text" id="a-name" autocomplete="name">' : ''}
        <label class="field">Email</label><input type="email" id="a-email" autocomplete="email">
        <label class="field">Password${needsSetup ? ' (8 characters or more)' : ''}</label>
        <input type="password" id="a-pass" autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
        <div style="margin-top:18px"><button class="btn big" id="a-go">${needsSetup ? 'Set up Sage' : 'Sign in'}</button></div>
        ${needsSetup ? '' : `<button class="btn big ghost" id="a-passkey" style="display:none;margin-top:10px">Use Face ID</button>
          <button class="btn ghost small" id="a-recover" style="margin-top:10px">Forgot password?</button>`}
      </div>
    </div>`;
  const go = async () => {
    try {
      await api(needsSetup ? '/api/setup' : '/api/login', { method: 'POST', body: {
        name: ($('#a-name') || {}).value, email: $('#a-email').value, password: $('#a-pass').value } });
      boot();
    } catch (e) { toast(e.message); }
  };
  $('#a-go').onclick = go;
  $('#a-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  if (!needsSetup && window.PublicKeyCredential) {
    api('/api/passkey/available').then(({ available }) => {
      if (available) $('#a-passkey').style.display = '';
    }).catch(() => {});
    $('#a-passkey').onclick = async () => {
      try {
        const start = await api('/api/passkey/auth/options', { method: 'POST' });
        const credential = await navigator.credentials.get({ publicKey: authenticationOptionsFromJSON(start.options) });
        await api('/api/passkey/auth/verify', { method: 'POST', body: {
          flow_id: start.flow_id, response: credentialToJSON(credential),
        } });
        boot();
      } catch (e) { toast(e.name === 'NotAllowedError' ? 'Face ID was cancelled.' : e.message, 5000); }
    };
  }
  if ($('#a-recover')) $('#a-recover').onclick = openRecovery;
}

function openRecovery() {
  const m = openModal(`
    <h2>Recover Sage</h2>
    <p class="sub">Use the one-time recovery code saved when Face ID was set up.</p>
    <label class="field">Email</label><input type="email" id="rec-email" autocomplete="email">
    <label class="field">Recovery code</label><input id="rec-code" autocapitalize="characters" autocomplete="off">
    <label class="field">New password</label><input type="password" id="rec-pass" autocomplete="new-password" placeholder="10 characters or more">
    <button class="btn big" id="rec-go" style="margin-top:16px">Set new password</button>`);
  $('#rec-go', m).onclick = async () => {
    try {
      await api('/api/recovery/reset', { method: 'POST', body: {
        email: $('#rec-email', m).value, code: $('#rec-code', m).value, password: $('#rec-pass', m).value,
      } });
      closeModal(); toast('Password changed. You’re signed back in.'); boot();
    } catch (e) { toast(e.message, 5000); }
  };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
let VIEW = 'now';
const VIEWS = {};
function setView(v) {
  VIEW = v;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  (VIEWS[v] || VIEWS.now)();
  window.scrollTo(0, 0);
}
$$('.nav-btn').forEach((b) => b.onclick = () => setView(b.dataset.view));
$('#capture-fab').onclick = () => openCapture();

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------
function itemPills(i) {
  const out = [];
  const t = today();
  const day = (i.due_at || '').slice(0, 10);
  if (i.type === 'event') {
    const when = fmtTime(i.event_start || i.due_at);
    out.push(`<span class="pill info">${when || fmtDate(i.event_start || i.due_at)}</span>`);
  } else if (day) {
    out.push(`<span class="pill ${day < t ? 'late' : day === t ? 'soon' : ''}">${day < t ? 'was due ' : ''}${fmtDate(day)}</span>`);
  }
  if (i.importance === 'must') out.push('<span class="pill soon">must</span>');
  if (i.target_window && !day) out.push(`<span class="pill grey">${esc(i.target_window)}</span>`);
  if (i.effort_min) out.push(`<span class="pill grey">${i.effort_min} min</span>`);
  if (i.location) out.push(`<span class="pill grey">${esc(i.location)}</span>`);
  if (i.store) out.push(`<span class="pill grey">${esc(i.store)}</span>`);
  if (i.source) out.push(`<span class="pill grey">from ${esc(sourceLabel(i))}</span>`);
  for (const b of (i.blockers || [])) out.push(`<span class="pill grey">${esc(b)}</span>`);
  return out.join('');
}

function sourceLabel(i) {
  if (i.source_label) return i.source_label;
  return ({
    seed: 'Sage’s starter context',
    voice: 'voice capture',
    typed: 'Sage capture',
    ai: 'Sage',
    manual: 'Sage',
  })[i.source] || i.source || 'Sage';
}

function itemRow(i, { flat = false } = {}) {
  // Appointments read from her iCloud calendar are shown, never edited —
  // Apple Calendar stays the system of record. No checkbox, no edit sheet.
  if (i.external) {
    const reminder = i.external_kind === 'reminder';
    return `
      <div class="row ${flat ? 'flat' : ''} external">
        <span style="font-size:1.2em;margin-top:1px">${reminder ? '⏰' : '📅'}</span>
        <div class="body">
          <div class="title">${esc(i.title)}</div>
          <div>${reminder
              ? (i.due_at ? `<span class="pill info">${esc(fmtDate(i.due_at))}</span>` : '')
              : (i.all_day ? '<span class="pill info">all day</span>'
              : `<span class="pill info">${esc(fmtTime(i.event_start) || fmtDate(i.due_at))}</span>`)}
            ${i.location ? `<span class="pill grey">${esc(i.location)}</span>` : ''}
            <span class="pill grey">from ${esc(sourceLabel(i))}</span></div>
        </div>
      </div>`;
  }
  return `
    <div class="row ${flat ? 'flat' : ''} ${i.status === 'done' ? 'done' : ''}" data-item="${i.id}">
      <button class="tick ${i.status === 'done' ? 'on' : ''}" data-tick="${i.id}" aria-label="Mark done">${i.status === 'done' ? '✓' : ''}</button>
      <div class="body" data-open="${i.id}">
        <div class="title">${esc(i.title)}</div>
        ${itemPills(i) ? `<div>${itemPills(i)}</div>` : ''}
      </div>
    </div>`;
}

function wireItems(root) {
  root.addEventListener('click', async (e) => {
    const tick = e.target.closest('[data-tick]')?.dataset.tick;
    const open = e.target.closest('[data-open]')?.dataset.open;
    if (tick) {
      const row = e.target.closest('.row');
      const wasDone = row.classList.contains('done');
      await api(`/api/items/${tick}`, { method: 'PATCH', body: { status: wasDone ? 'open' : 'done' } });
      setView(VIEW);
    } else if (open) {
      const list = await api('/api/items?q=');
      const it = list.find((x) => x.id == open);
      if (it) openItem(it);
    }
  });
}

// On NOW the routine starts collapsed to one line, so the screen stays scannable
// (spec §7: immediate items, roughly one iPhone screen). Tap opens it in place.
function routineBlock(r, { collapsed = false } = {}) {
  return `
    <div class="routine-block ${collapsed ? 'collapsed' : ''}" data-routine="${r.id}">
      <div class="routine-head" data-toggle="${r.id}">
        <span>${r.emoji || '📋'} ${esc(r.name)}</span>
        <span class="count">${r.complete ? 'done ✓' : `${r.remaining} left`}${collapsed ? ' <span class="caret">›</span>' : ''}</span>
      </div>
      ${r.steps.map((s) => `
        <div class="row flat ${s.done ? 'done' : ''}">
          <button class="tick ${s.done ? 'on' : ''}" data-step="${r.id}:${s.id}" aria-label="Check off">${s.done ? '✓' : ''}</button>
          <div class="body"><div class="title" style="font-weight:500">${esc(s.text)}</div></div>
        </div>`).join('')}
      ${r.cadence_note ? `<div class="quiet" style="margin:4px 0 0 4px">${esc(r.cadence_note)}</div>` : ''}
    </div>`;
}

function wireRoutines(root) {
  root.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const block = toggle.closest('.routine-block');
      if (block.classList.contains('collapsed') || block.dataset.wasCollapsed) {
        block.dataset.wasCollapsed = '1';
        block.classList.toggle('collapsed');
      }
      return;
    }
    const s = e.target.closest('[data-step]')?.dataset.step;
    if (!s) return;
    const [rid, sid] = s.split(':');
    const row = e.target.closest('.row');
    const isDone = row.classList.contains('done');
    row.classList.toggle('done', !isDone);
    $('.tick', row).classList.toggle('on', !isDone);
    $('.tick', row).textContent = !isDone ? '✓' : '';
    await api(`/api/routines/${rid}/step/${sid}`, { method: 'POST', body: { done: !isDone } });
    const block = e.target.closest('[data-routine]');
    if (block) {
      const left = $$('.row:not(.done)', block).length;
      const c = $('.count', block);
      if (c) c.textContent = left ? `${left} left` : 'done ✓';
    }
  });
}

// ---------------------------------------------------------------------------
// NOW — immediate items only, one screen where possible
// ---------------------------------------------------------------------------
// Fireflies over the morning greeting. Fixed positions rather than random
// ones, so they're scattered by design instead of occasionally clumping in a
// corner — but each gets its own drift, pulse rate and delay, so they never
// blink together and the field never repeats in a way the eye can catch.
const FIREFLY_FIELD = [
  { x: 12, y: 18, dx: 34, dy: -46, dur: 27, pulse: 4.2, delay: 0.0 },
  { x: 78, y: 12, dx: -28, dy: 38, dur: 31, pulse: 5.6, delay: 1.4 },
  { x: 34, y: 62, dx: 44, dy: -30, dur: 24, pulse: 3.8, delay: 2.7 },
  { x: 88, y: 48, dx: -40, dy: -34, dur: 34, pulse: 6.1, delay: 0.8 },
  { x: 22, y: 82, dx: 30, dy: -52, dur: 29, pulse: 4.9, delay: 3.6 },
  { x: 62, y: 74, dx: -34, dy: -28, dur: 26, pulse: 5.2, delay: 1.9 },
  { x: 48, y: 32, dx: 26, dy: 40, dur: 33, pulse: 3.4, delay: 4.3 },
  { x: 8, y: 46, dx: 38, dy: 32, dur: 28, pulse: 6.4, delay: 2.2 },
  { x: 70, y: 90, dx: -30, dy: -44, dur: 30, pulse: 4.6, delay: 5.1 },
  { x: 92, y: 74, dx: -36, dy: 26, dur: 25, pulse: 5.9, delay: 3.0 },
  { x: 40, y: 8, dx: 22, dy: 48, dur: 32, pulse: 4.0, delay: 6.2 },
];

function fireflies() {
  return `<div class="fireflies" aria-hidden="true">${FIREFLY_FIELD.map((f) => `
    <span class="firefly" style="left:${f.x}%;top:${f.y}%;--dx:${f.dx}px;--dy:${f.dy}px;--dur:${f.dur}s;--pulse:${f.pulse}s;--delay:${f.delay}s"></span>`).join('')}</div>`;
}

// Sage keeps its own clock — the phone's would be right, but everything else
// in the app reasons in her timezone and they must never disagree.
let CLOCK_HOUR_OFFSET = null;
function clockTime() {
  const d = new Date();
  if (CLOCK_HOUR_OFFSET !== null) d.setMinutes(d.getMinutes() + CLOCK_HOUR_OFFSET);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function clockDate() {
  const d = new Date();
  if (CLOCK_HOUR_OFFSET !== null) d.setMinutes(d.getMinutes() + CLOCK_HOUR_OFFSET);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
// She wants this as her home screen, so the time has to actually be the time.
setInterval(() => {
  const t = document.getElementById('clock-time');
  if (t) t.textContent = clockTime();
  const dd = document.getElementById('clock-date');
  if (dd) dd.textContent = clockDate();
}, 10000);

// She can open the day whenever she likes; once she has, it stays open for
// the rest of that day rather than making her tap through it again.
function morningOpened(date) {
  try { return localStorage.getItem('sage_morning_opened') === date; } catch { return false; }
}
function openTheDay(date) {
  try { localStorage.setItem('sage_morning_opened', date); } catch {}
}

VIEWS.now = async function renderNow() {
  const d = await api('/api/views/now');
  const wx = d.weather ? `${d.weather.tempNow}° ${d.weather.todayRain ? '🌧️' : '☀️'}` : '';
  // Keep the on-screen clock aligned with Sage's timezone rather than the
  // phone's, in case she ever opens it from somewhere else.
  if (typeof d.hour === 'number') CLOCK_HOUR_OFFSET = (d.hour - new Date().getHours()) * 60;
  // Fireflies belong to dusk. They're on the morning screen because she loved
  // them there — but this is their real hour.
  const evening = typeof d.hour === 'number' && d.hour >= 19;

  // The morning hour: presence first. Nothing here is a list.
  if (d.morning && !morningOpened(d.date)) {
    $('#main').innerHTML = `
      <div class="morning">
        ${fireflies()}
        <div class="clock"><span id="clock-time">${esc(clockTime())}</span></div>
        <div class="clock-date" id="clock-date">${esc(clockDate())}</div>
        <h1>${d.greeting}, ${esc(ME.name.split(' ')[0])}.</h1>
        ${d.morning.notes.map((n) => `<p class="morning-note">${esc(n)}</p>`).join('')}
        ${d.morning.soon ? `
          <div class="card sky" style="margin-top:20px;text-align:left">
            <b>${esc(d.morning.soon.title)}</b>
            <div class="quiet">${esc(fmtTime(d.morning.soon.at))} — about ${esc(d.morning.soon.away)} from now${
              d.morning.soon.prep_minutes ? `, and you'll want ${d.morning.soon.prep_minutes} minutes to get ready` : ''}.</div>
          </div>
          <p class="morning-line">Nothing else needs you yet.</p>`
          : `<p class="morning-line">${esc(d.morning.line)}</p>`}
        <button class="btn big quietbtn" id="m-open" style="margin-top:26px">When you're ready, let's look at the day →</button>
        ${!d.weightToday ? `<div class="btn-row" style="justify-content:center;margin-top:6px">
          <input type="text" inputmode="decimal" id="wt" placeholder="150.0" style="max-width:110px;text-align:center">
          <button class="btn ghost small" id="wt-save">Log it</button></div>` : ''}
      </div>`;
    $('#m-open').onclick = () => { openTheDay(d.date); renderNow(); };
    if ($('#wt-save')) $('#wt-save').onclick = async () => {
      const v = $('#wt').value.trim();
      if (!v) return;
      await api('/api/tracking', { method: 'POST', body: { kind: 'weight', value: v } });
      toast('Recorded.');
    };
    return;
  }

  const undoable = (await api('/api/history')).filter((h) => h.by_ai && h.undoable).slice(0, 1)[0] || null;

  const bits = [];
  if (d.nextEvent) {
    const lead = d.nextEvent.prep_minutes ? ` · be ready by ${fmtTime(new Date(new Date(d.nextEvent.event_start).getTime() - d.nextEvent.prep_minutes * 60000).toISOString())}` : '';
    bits.push(`<div class="card sky"><b>📅 ${esc(d.nextEvent.title)}</b><div class="quiet">${fmtTime(d.nextEvent.event_start) || fmtDate(d.nextEvent.event_start || d.nextEvent.due_at)}${lead}</div></div>`);
  }
  if (d.activeTrip) bits.push(`<div class="card clay"><b>🏞️ You're at ${esc(d.activeTrip.location_key)}</b></div>`);
  else if (d.upcomingTrip) bits.push(`<div class="card clay"><b>🚗 ${esc(d.upcomingTrip.location_key)} ${fmtDate(d.upcomingTrip.start_date)}</b><div class="quiet">The departure checklist appears the day before.</div></div>`);

  $('#main').innerHTML = `
    <div class="now-wrap${evening ? ' dusk' : ''}">
    ${evening ? fireflies() : ''}
    <div class="clock-row">
      <span class="clock" id="clock-time">${esc(clockTime())}</span>
      <span class="clock-date" id="clock-date">${esc(clockDate())}</span>
    </div>
    <div class="now-head">
      <h1>${d.greeting}, ${esc(ME.name.split(' ')[0])}.</h1>
      ${wx ? `<span class="wx">${esc(d.here?.name || '')} ${wx}</span>` : ''}
    </div>
    <p class="sub">${d.immediate.length || d.routines.length ? 'Right now:' : 'Nothing is asking for you this minute.'}</p>
    ${undoable ? `<div class="strip">🌿 Sage ${esc(undoable.action)} “${esc(undoable.detail)}”<button class="btn small ghost" data-undo="${undoable.id}">Undo</button></div>` : ''}
    ${bits.join('')}
    ${d.immediate.length ? `<div id="now-items">${d.immediate.map((i) => itemRow(i)).join('')}</div>` : ''}
    ${d.reminders.length ? `<h2>⏰ Apple Reminders</h2>${d.reminders.map((i) => itemRow(i)).join('')}` : ''}
    <div id="now-routines">${d.routines.map((r) => routineBlock(r, { collapsed: r.steps.length > 3 })).join('')}</div>
    ${!d.immediate.length && !d.routines.length && !bits.length ? '<div class="empty">Clear. Genuinely clear.</div>' : ''}
    ${!d.weightToday ? `<div class="card"><b>Weight today?</b><div class="btn-row" style="margin-top:8px">
      <input type="text" inputmode="decimal" id="wt" placeholder="150.0" style="flex:1">
      <button class="btn small" id="wt-save">Save</button></div></div>`
      : `<div class="quiet center" style="margin-top:14px">Weight today: ${d.weightToday.value}</div>`}
    <div class="btn-row" style="margin-top:16px">
      <button class="btn ghost small" id="ask-sage" style="flex:1">💬 Ask Sage</button>
      <button class="btn ghost small" data-goto="think" style="flex:1">💭 Think something through</button>
    </div>
    </div>`;

  wireItems($('#main'));
  wireRoutines($('#main'));
  $('#main').addEventListener('click', async (e) => {
    const u = e.target.closest('[data-undo]')?.dataset.undo;
    const goto = e.target.closest('[data-goto]')?.dataset.goto;
    if (u) { await api(`/api/history/${u}/undo`, { method: 'POST' }); toast('Undone.'); setView('now'); }
    if (goto) setView(goto);
  });
  if ($('#wt-save')) $('#wt-save').onclick = async () => {
    const v = $('#wt').value.trim();
    if (!v) return;
    await api('/api/tracking', { method: 'POST', body: { kind: 'weight', value: v } });
    toast('Recorded.'); setView('now');
  };
  $('#ask-sage').onclick = openAsk;
};

// ---------------------------------------------------------------------------
// TODAY — grouped by what it is, appointments visible
// ---------------------------------------------------------------------------
VIEWS.today = async function renderToday() {
  const d = await api('/api/views/today');
  const sect = (title, items, empty) => items.length
    ? `<h2>${title}</h2>${items.map((i) => itemRow(i)).join('')}`
    : (empty ? `<h2>${title}</h2><div class="empty">${empty}</div>` : '');
  $('#main').innerHTML = `
    <h1>Today</h1>
    <p class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${d.weather ? ` · ${d.weather.todayHigh}°/${d.weather.todayLow}°` : ''}</p>
    ${sect('📅 Appointments', d.events)}
    ${sect('⏰ Apple Reminders', d.reminders)}
    ${sect('Must do', d.must)}
    ${sect('Should do', d.should)}
    <h2>Routines</h2>
    <div id="t-routines">${d.routines.length ? d.routines.map((r) => routineBlock(r, { collapsed: r.steps.length > 5 })).join('') : '<div class="empty">Nothing scheduled today.</div>'}</div>
    ${sect('Anytime', d.anytime)}
    ${d.waiting.length ? `<h2>Waiting on someone else</h2>${d.waiting.map((i) => itemRow(i)).join('')}` : ''}
    ${d.blocked.length ? `<h2>Not yet — something comes first</h2>${d.blocked.map((i) => itemRow(i)).join('')}` : ''}`;
  wireItems($('#main'));
  wireRoutines($('#main'));
};

// ---------------------------------------------------------------------------
// WEEK
// ---------------------------------------------------------------------------
VIEWS.week = async function renderWeek() {
  const d = await api('/api/views/week');
  $('#main').innerHTML = `
    <h1>This week</h1>
    <p class="sub">Obligations, plus a few worth-doing things. Not the whole backlog.</p>
    ${d.overdue.length ? `<h2>Behind</h2>${d.overdue.map((i) => itemRow(i)).join('')}` : ''}
    ${d.trips.length ? `<h2>Trips</h2>${d.trips.map((t) => `<div class="card clay"><b>🏞️ ${esc(t.location_key)}</b> — ${fmtDate(t.start_date)}${t.end_date ? ` to ${fmtDate(t.end_date)}` : ''}</div>`).join('')}` : ''}
    ${d.days.map((day, idx) => (day.events.length || day.items.length) ? `
      <div class="daybox ${idx === 0 ? 'today' : ''}">
        <h3>${idx === 0 ? 'Today' : new Date(day.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long' })}</h3>
        ${day.events.map((i) => itemRow(i, { flat: true })).join('')}
        ${day.items.map((i) => itemRow(i, { flat: true })).join('')}
      </div>` : '').join('')}
    ${d.days.every((x) => !x.events.length && !x.items.length) && !d.overdue.length ? '<div class="empty">Nothing dated this week.</div>' : ''}
    ${d.opportunities.length ? `<h2>🌱 If there's room</h2>
      <p class="quiet" style="margin:-4px 0 8px">These never become overdue.</p>
      ${d.opportunities.map((i) => itemRow(i)).join('')}` : ''}`;
  wireItems($('#main'));
};

// ---------------------------------------------------------------------------
// MORE — the rest of the rooms
// ---------------------------------------------------------------------------
VIEWS.more = function renderMore() {
  $('#main').innerHTML = `
    <h1>More</h1>
    <p class="sub">Everything else Sage keeps for you.</p>
    <div class="more-grid">
      <button class="more-tile" data-go="search"><span>🔎</span>Search Sage</button>
      <button class="more-tile" data-go="think"><span>💭</span>Thinking</button>
      <button class="more-tile" data-go="memory"><span>🧠</span>What Sage knows</button>
      <button class="more-tile" data-go="coming"><span>🔭</span>Coming up</button>
      <button class="more-tile" data-go="opportunities"><span>🌱</span>Opportunities</button>
      <button class="more-tile" data-go="projects"><span>🎯</span>Projects</button>
      <button class="more-tile" data-go="lake"><span>🏞️</span>The lake</button>
      <button class="more-tile" data-go="routines"><span>📋</span>Routines</button>
      <button class="more-tile" data-go="shopping"><span>🛒</span>Shopping</button>
      <button class="more-tile" data-go="notes"><span>📝</span>Notes</button>
      <button class="more-tile" data-go="files"><span>📁</span>Files</button>
      <button class="more-tile" data-go="inbox"><span>📥</span>Recent captures</button>
      <button class="more-tile" data-go="settings"><span>⚙️</span>Settings</button>
    </div>`;
  $$('[data-go]').forEach((b) => b.onclick = () => setView(b.dataset.go));
};

VIEWS.search = function renderSearch() {
  $('#main').innerHTML = `
    <h1>🔎 Search Sage</h1>
    <p class="sub">Tasks, projects, notes, appointments, reminders, routines, supplies, and file names.</p>
    <div class="btn-row">
      <input id="search-q" type="search" enterkeyhint="search" autocomplete="off"
        placeholder="Try lavender, lake, dentist…" style="flex:1">
      <button class="btn small" id="search-go">Search</button>
    </div>
    <div id="search-results"><div class="empty">What are we hunting for?</div></div>
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  const input = $('#search-q');
  const out = $('#search-results');
  let timer = null;
  let searchNumber = 0;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++searchNumber;
    if (!q) { out.innerHTML = '<div class="empty">What are we hunting for?</div>'; return; }
    out.innerHTML = '<div class="empty">Searching…</div>';
    try {
      const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (mine !== searchNumber || VIEW !== 'search') return;
      const total = d.items.length + d.files.length + d.events.length + d.reminders.length + d.routines.length + d.inventory.length;
      const itemResults = d.items.map((i) => `
        <div class="row ${i.status === 'done' ? 'done' : ''}" data-open="${i.id}">
          <div class="body">
            <div class="title">${esc(i.title)}</div>
            <div class="meta">${esc(TYPES[i.type] || i.type)} · ${esc(i.status)} · from ${esc(sourceLabel(i))}</div>
            ${i.note ? `<div class="quiet">${esc(i.note.slice(0, 180))}</div>` : ''}
          </div><span class="chev">›</span>
        </div>`).join('');
      const fileResults = d.files.map((f) => `
        <div class="card">
          <b>${fileIcon(f)} ${esc(f.title)}</b>
          ${f.note ? `<div class="quiet">${esc(f.note)}</div>` : ''}
          <div class="meta">${esc(f.original_name)} · encrypted file</div>
          <a class="btn ghost small" href="/files/${f.id}" target="_blank" rel="noopener" style="margin-top:8px">Open</a>
        </div>`).join('');
      const eventResults = d.events.map((e) => `
        <div class="row"><div class="body"><div class="title">📅 ${esc(e.title)}</div>
          <div class="meta">${fmtDate(e.start)}${e.location ? ` · ${esc(e.location)}` : ''} · from ${esc(e.source_label || 'calendar')}</div>
        </div></div>`).join('');
      const reminderResults = d.reminders.map((r) => `
        <div class="row ${r.completed ? 'done' : ''}"><div class="body"><div class="title">⏰ ${esc(r.title)}</div>
          <div class="meta">${r.due ? fmtDate(r.due) : 'no date'} · from ${esc(r.source_label || 'reminders')}</div>
          ${r.note ? `<div class="quiet">${esc(r.note.slice(0, 180))}</div>` : ''}
        </div></div>`).join('');
      const routineResults = d.routines.map((r) => `
        <div class="row"><div class="body"><div class="title">${esc(r.emoji || '📋')} ${esc(r.name)}</div>
          <div class="meta">routine${r.cadence_note ? ` · ${esc(r.cadence_note)}` : ''}</div>
        </div></div>`).join('');
      const inventoryResults = d.inventory.map((i) => `
        <div class="row"><div class="body"><div class="title">📦 ${esc(i.name)}</div>
          <div class="meta">${esc(i.state)} · ${esc(i.location_key)}${i.store ? ` · ${esc(i.store)}` : ''}</div>
        </div></div>`).join('');
      out.innerHTML = total ? `
        <p class="quiet" style="margin:14px 0 8px">${total} result${total === 1 ? '' : 's'}</p>
        ${d.items.length ? `<h2>Sage items</h2>${itemResults}` : ''}
        ${d.events.length ? `<h2>Calendar</h2>${eventResults}` : ''}
        ${d.reminders.length ? `<h2>Reminders</h2>${reminderResults}` : ''}
        ${d.routines.length ? `<h2>Routines</h2>${routineResults}` : ''}
        ${d.inventory.length ? `<h2>Supplies</h2>${inventoryResults}` : ''}
        ${d.files.length ? `<h2>Files</h2>${fileResults}` : ''}`
        : `<div class="empty">Nothing matched “${esc(q)}.” Sage checked all the drawers.</div>`;
    } catch (e) {
      if (mine === searchNumber) out.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  $('#search-go').onclick = run;
  $('[data-back]').onclick = () => setView('more');
  wireItems(out);
  setTimeout(() => input.focus(), 0);
};

VIEWS.coming = async function renderComing() {
  const d = await api('/api/views/coming-up');
  const sect = (t, items) => items.length ? `<h2>${t}</h2>${items.map((i) => itemRow(i)).join('')}` : '';
  $('#main').innerHTML = `
    <h1>Coming up</h1>
    <p class="sub">Further out, so it stops living in your head.</p>
    ${sect('This month', d.month)}
    ${sect('Next few months', d.quarter)}
    ${sect('Later this year', d.halfYear)}
    ${sect('Within a year', d.year)}
    ${sect('When the season is right', d.seasonal)}
    ${!d.month.length && !d.quarter.length && !d.halfYear.length && !d.year.length && !d.seasonal.length ? '<div class="empty">Nothing scheduled beyond this week.</div>' : ''}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  wireItems($('#main'));
  $('[data-back]').onclick = () => setView('more');
};

VIEWS.opportunities = async function renderOpportunities() {
  const mins = VIEWS._oppMinutes || 0;
  const d = await api(`/api/views/opportunities${mins ? `?minutes=${mins}` : ''}`);
  $('#main').innerHTML = `
    <h1>🌱 Opportunities</h1>
    <p class="sub">Worth doing, never owed. Nothing here can be late.</p>
    <div class="seg">
      ${[[0, 'Any'], [15, '15 min'], [30, '30 min'], [60, 'An hour']].map(([v, l]) =>
        `<button class="${mins === v ? 'on' : ''}" data-min="${v}">${l}</button>`).join('')}
    </div>
    ${d.eligible.length ? d.eligible.map((i) => itemRow(i)).join('') : '<div class="empty">Nothing fits right now — that’s fine.</div>'}
    ${d.notYet.length ? `<h2>Not right now</h2><p class="quiet" style="margin:-4px 0 8px">Waiting on the right day, weather, or a first step.</p>${d.notYet.map((i) => itemRow(i)).join('')}` : ''}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  wireItems($('#main'));
  $$('[data-min]').forEach((b) => b.onclick = () => { VIEWS._oppMinutes = +b.dataset.min; setView('opportunities'); });
  $('[data-back]').onclick = () => setView('more');
};

VIEWS.projects = async function renderProjects() {
  const d = await api('/api/views/projects');
  $('#main').innerHTML = `
    <h1>🎯 Projects</h1>
    <p class="sub">Outcome, next action, and what's in the way. Nothing else.</p>
    ${d.projects.length ? d.projects.map((p) => `
      <div class="card" data-open="${p.id}">
        <b>${esc(p.title)}</b>
        ${p.outcome ? `<div class="quiet">${esc(p.outcome)}</div>` : ''}
        ${p.next ? `<div style="margin-top:8px"><span class="pill">next</span> ${esc(p.next)}</div>` : '<div class="quiet" style="margin-top:6px">No next action set.</div>'}
        <div style="margin-top:6px">
          ${p.openCount ? `<span class="pill grey">${p.openCount} open</span>` : ''}
          ${p.blockedCount ? `<span class="pill grey">${p.blockedCount} waiting on something</span>` : ''}
        </div>
      </div>`).join('') : '<div class="empty">No projects yet.</div>'}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  wireItems($('#main'));
  $('[data-back]').onclick = () => setView('more');
};

VIEWS.lake = async function renderLake() {
  const d = await api('/api/views/lake');
  $('#main').innerHTML = `
    <h1>🏞️ The lake</h1>
    ${d.next ? `<div class="card clay"><b>Next trip: ${fmtDate(d.next.start_date)}</b>${d.next.end_date ? `<div class="quiet">back ${fmtDate(d.next.end_date)}</div>` : ''}
      ${d.weather ? `<div class="quiet">There now: ${d.weather.tempNow}° ${d.weather.todayRain ? '🌧️' : '☀️'}</div>` : ''}</div>`
      : '<p class="sub">No trip planned. Say “we’re going to the lake Friday” and everything wakes up.</p>'}
    <div class="btn-row"><button class="btn small" id="lk-trip">＋ Plan a trip</button></div>
    ${d.routines.length ? `<h2>Checklists</h2><div id="lk-routines">${d.routines.map(routineBlock).join('')}</div>` : ''}
    ${d.packing.length ? `<h2>For the lake</h2>${d.packing.map((i) => itemRow(i)).join('')}` : ''}
    ${d.inventory.length ? `<h2>What's up there</h2>${d.inventory.map((v) => `
      <div class="row"><div class="body"><div class="title">${esc(v.name)}</div>
      <div class="meta">${v.state === 'out' ? '❗ out' : v.state === 'low' ? '⚠️ low' : 'stocked'}${v.note ? ' · ' + esc(v.note) : ''}</div></div></div>`).join('')}` : ''}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  wireItems($('#main'));
  wireRoutines($('#main'));
  $('[data-back]').onclick = () => setView('more');
  $('#lk-trip').onclick = () => {
    const m = openModal(`<h2>🚗 Plan a lake trip</h2>
      <label class="field">Leaving</label><input type="date" id="tp-start" value="${today()}">
      <label class="field">Coming back (optional)</label><input type="date" id="tp-end">
      <div style="margin-top:16px"><button class="btn big" id="tp-save">Save the trip</button></div>`);
    $('#tp-save', m).onclick = async () => {
      await api('/api/trips', { method: 'POST', body: { location_key: 'lake', start_date: $('#tp-start', m).value, end_date: $('#tp-end', m).value } });
      closeModal(); toast('Trip saved. The departure checklist appears the day before.'); setView('lake');
    };
  };
};

VIEWS.routines = async function renderRoutines() {
  const all = await api('/api/routines?all=1');
  const active = await api('/api/routines');
  const activeIds = new Set(active.map((r) => r.id));
  $('#main').innerHTML = `
    <h1>📋 Routines</h1>
    <p class="sub">All of them. Today's are marked — the rest are waiting for their moment.</p>
    ${all.map((r) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <b>${r.emoji || '📋'} ${esc(r.name)}</b>
          ${activeIds.has(r.id) ? '<span class="pill">today</span>' : '<span class="pill grey">not today</span>'}
        </div>
        <div class="quiet" style="margin-top:2px">${esc(describeTrigger(r))}</div>
        <div class="quiet" style="margin-top:6px">${r.steps.map((s) => esc(s.text)).join(' · ')}</div>
      </div>`).join('')}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  $('[data-back]').onclick = () => setView('more');
};

function describeTrigger(r) {
  const c = r.config || {};
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const when = [];
  if (r.trigger_type === 'daily') when.push('Every day');
  if (r.trigger_type === 'weekly') when.push(c.days?.length ? c.days.map((d) => DAYS[d] + 's').join(', ') : 'Weekly');
  if (r.trigger_type === 'seasonal') when.push(c.months?.length ? `${MONTHS[c.months[0]]}–${MONTHS[c.months[c.months.length - 1]]}` : 'Seasonal');
  if (r.trigger_type === 'weather') when.push(c.weather === 'rain' ? 'When it rains' : `When it's ${c.weather}`);
  if (r.trigger_type === 'location') when.push(`At the ${String(c.location || '').replace(/_/g, ' ')}`);
  if (r.trigger_type === 'event') when.push(c.event === 'hosting' ? 'Before company' : c.event === 'trip_departure' ? 'Before leaving on a trip' : 'On an event');
  if (r.trigger_type === 'flexible') when.push('Whenever it suits — never overdue');
  if (c.time_of_day === 'morning') when.push('mornings');
  if (c.time_of_day === 'evening') when.push(c.after_hour ? `evenings after ${c.after_hour % 12 || 12}${c.after_hour >= 12 ? 'pm' : 'am'}` : 'evenings');
  const sup = typeof r.suppress_if === 'string' ? JSON.parse(r.suppress_if || '{}') : (r.suppress_if || {});
  if (sup.event_kind) when.push(`— skipped on ${sup.event_kind.toUpperCase()} days`);
  if (sup.on_trip) when.push('— not while away');
  return when.join(', ');
}

VIEWS.shopping = async function renderShopping() {
  const items = await api('/api/items?type=shopping&status=open');
  const inv = await api('/api/inventory');
  $('#main').innerHTML = `
    <h1>🛒 Shopping</h1>
    <p class="sub">What to get, and what to watch rather than rush.</p>
    ${items.length ? items.map((i) => itemRow(i)).join('') : '<div class="empty">Nothing on the list.</div>'}
    ${inv.length ? `<h2>Supplies</h2>${inv.map((v) => `
      <div class="row"><div class="body"><div class="title">${esc(v.name)}</div>
        <div class="meta">${v.state === 'out' ? '❗ out' : v.state === 'low' ? '⚠️ getting low' : 'stocked'}${v.store ? ' · ' + esc(v.store) : ''}${v.purchase_rule === 'on_sale' ? ' · wait for a sale' : ''}</div>
      </div></div>`).join('')}` : ''}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  wireItems($('#main'));
  $('[data-back]').onclick = () => setView('more');
};

VIEWS.notes = async function renderNotes() {
  const notes = await api('/api/items?type=note&status=open');
  $('#main').innerHTML = `
    <h1>📝 Notes</h1>
    <p class="sub">Things worth keeping that are not tasks pretending to need a checkbox.</p>
    <button class="btn small" id="note-new">＋ New note</button>
    <div style="margin-top:12px">
      ${notes.length ? notes.map((n) => `
        <div class="card" data-note-open="${n.id}" style="cursor:pointer">
          <b>${esc(n.title)}</b>
          ${n.note ? `<div class="quiet" style="margin-top:5px;white-space:pre-wrap">${esc(n.note)}</div>` : ''}
          <div style="margin-top:7px"><span class="pill grey">from ${esc(sourceLabel(n))}</span>
            ${n.ai_private ? '<span class="pill grey">🔒 private from AI</span>' : ''}</div>
        </div>`).join('') : '<div class="empty">No notes yet. A suspiciously clean desk.</div>'}
    </div>
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  $('#note-new').onclick = () => {
    const m = openModal(`
      <h2>📝 New note</h2>
      <label class="field">Title</label><input id="note-title" placeholder="What is this about?">
      <label class="field">Note</label><textarea id="note-body" style="min-height:180px" placeholder="Put it here so it can stop living in your head."></textarea>
      <label class="row flat" style="align-items:center;margin-top:12px;cursor:pointer">
        <input type="checkbox" id="note-private" style="transform:scale(1.25)">
        <div class="body"><b>Private from AI</b><div class="quiet">Sage stores it, but never sends it to OpenAI.</div></div>
      </label>
      <button class="btn big" id="note-save" style="margin-top:16px">Save note</button>`);
    $('#note-save', m).onclick = async () => {
      const title = $('#note-title', m).value.trim();
      const note = $('#note-body', m).value.trim();
      if (!title && !note) return toast('Give me at least a little something to save.');
      await api('/api/items', { method: 'POST', body: {
        type: 'note', status: 'open', importance: 'should',
        title: title || note.slice(0, 80), note, source: 'manual', ai_private: $('#note-private', m).checked,
      } });
      closeModal(); toast('Note saved.'); setView('notes');
    };
  };
  $$('[data-note-open]').forEach((el) => el.onclick = async () => {
    const all = await api('/api/items?type=note&status=open');
    const note = all.find((n) => n.id == el.dataset.noteOpen);
    if (note) openItem(note);
  });
  $('[data-back]').onclick = () => setView('more');
};

function fileSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(f) {
  if (f.mime_type === 'application/pdf') return '📕';
  if (f.mime_type.startsWith('image/')) return '🖼️';
  if (/word/.test(f.mime_type)) return '📘';
  if (/sheet|excel|csv/.test(f.mime_type)) return '📊';
  return '📄';
}

VIEWS.files = async function renderFiles() {
  const files = await api('/api/files');
  $('#main').innerHTML = `
    <h1>📁 Files</h1>
    <p class="sub">Photos, PDFs, paperwork, and the things you absolutely put somewhere safe.</p>
    <button class="btn small" id="file-new">＋ Add a file</button>
    <div style="margin-top:12px">
      ${files.length ? files.map((f) => `
        <div class="card">
          <div style="display:flex;gap:10px;align-items:flex-start">
            <span style="font-size:1.35em">${fileIcon(f)}</span>
            <div style="flex:1;min-width:0">
              <b>${esc(f.title)}</b>
              ${f.note ? `<div class="quiet" style="margin-top:3px">${esc(f.note)}</div>` : ''}
              <div style="margin-top:6px">
                <span class="pill grey">${esc(f.original_name)}</span>
                <span class="pill grey">${fileSize(f.size_bytes)}</span>
                ${f.related_item_title ? `<span class="pill grey">linked to ${esc(f.related_item_title)}</span>` : ''}
                <span class="pill grey">encrypted file</span>
              </div>
              ${f.access_count ? `<div class="quiet" style="margin-top:5px">Opened ${f.access_count} time${f.access_count === 1 ? '' : 's'} · last ${fmtDate(f.last_opened.slice(0, 10))}</div>` : ''}
            </div>
          </div>
          <div class="btn-row" style="margin-top:10px">
            <a class="btn ghost small" href="/files/${f.id}" target="_blank" rel="noopener">Open</a>
            <button class="btn danger small" data-file-del="${f.id}">Delete</button>
          </div>
        </div>`).join('') : '<div class="empty">No files yet. The cabinet awaits its paperwork destiny.</div>'}
    </div>
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  $('#file-new').onclick = async () => {
    const items = await api('/api/items?status=open');
    const m = openModal(`
      <h2>📁 Add a file</h2>
      <label class="field">Choose file</label>
      <input type="file" id="file-pick" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx">
      <p class="quiet" style="margin:5px 0 0">PDF, photo, text, Word, or spreadsheet · up to 20 MB</p>
      <label class="field">Name</label><input id="file-title" placeholder="Uses the filename if left blank">
      <label class="field">Note</label><textarea id="file-note" style="min-height:80px" placeholder="What is this, and why are we keeping it?"></textarea>
      <label class="field">Link to something in Sage (optional)</label>
      <select id="file-related"><option value="">Nothing</option>
        ${items.slice(0, 150).map((i) => `<option value="${i.id}">${esc(i.title)}</option>`).join('')}
      </select>
      <button class="btn big" id="file-save" style="margin-top:16px">Upload</button>`);
    $('#file-save', m).onclick = async () => {
      const picked = $('#file-pick', m).files[0];
      if (!picked) return toast('Choose a file first.');
      const form = new FormData();
      form.append('file', picked);
      form.append('title', $('#file-title', m).value);
      form.append('note', $('#file-note', m).value);
      form.append('related_item_id', $('#file-related', m).value);
      const btn = $('#file-save', m);
      btn.disabled = true; btn.textContent = 'Uploading…';
      try {
        await api('/api/files', { method: 'POST', body: form });
        closeModal(); toast('Filed safely.'); setView('files');
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Upload'; toast(e.message, 5000);
      }
    };
  };
  $$('[data-file-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this file from Sage? This cannot be undone.')) return;
    await api(`/api/files/${b.dataset.fileDel}`, { method: 'DELETE' });
    toast('File deleted.'); setView('files');
  });
  $('[data-back]').onclick = () => setView('more');
};

VIEWS.inbox = async function renderInbox() {
  const d = await api('/api/views/inbox');
  $('#main').innerHTML = `
    <h1>📥 Recent captures</h1>
    <p class="sub">The safety net — everything you said, and what Sage made of it. Tap anything that landed wrong.</p>
    ${d.recent.map((i) => `
      <div class="row" data-item="${i.id}">
        <div class="body" data-open="${i.id}">
          <div class="title">${esc(i.title)}</div>
          <div class="meta">${esc(TYPES[i.type] || i.type)} · ${esc(IMPORTANCE[i.importance] || '')} ·
            from ${esc(sourceLabel(i))} · ${fmtDate(i.created_at.slice(0, 10))}${i.status === 'done' ? ' · done' : ''}</div>
          ${i.raw_capture && i.raw_capture !== i.title ? `<div class="quiet" style="margin-top:3px">you said: “${esc(i.raw_capture)}”</div>` : ''}
        </div>
        <span class="chev">›</span>
      </div>`).join('')}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  wireItems($('#main'));
  $('[data-back]').onclick = () => setView('more');
};

VIEWS.settings = async function renderSettings() {
  const locs = await api('/api/locations');
  // A slower Settings request must not repaint the page after she has already
  // tapped More (or any other destination).
  if (VIEW !== 'settings') return;
  const textSize = document.documentElement.dataset.text || 'large';
  const theme = document.documentElement.dataset.theme || 'light';
  $('#main').innerHTML = `
    <h1>⚙️ Settings</h1>
    <h2>Text size</h2>
    <div class="seg">${[['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Largest']].map(([v, l]) =>
      `<button class="${textSize === v ? 'on' : ''}" data-text="${v}">${l}</button>`).join('')}</div>
    <h2>Appearance</h2>
    <div class="seg">${[['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
      `<button class="${theme === v ? 'on' : ''}" data-theme="${v}">${l}</button>`).join('')}</div>
    <h2>📅 Sage → your calendar</h2>
    <div class="card">
      <p style="margin:0 0 10px;font-size:.88em">Put Sage's dates on your real calendar, with real alerts on your phone and watch. Subscribe once; new dates flow in on their own.</p>
      <div class="btn-row"><a class="btn small" id="cal-sub" href="#">Subscribe on this phone</a>
      <button class="btn ghost small" id="cal-copy">Copy the link</button></div>
      <label class="row flat" style="align-items:flex-start;cursor:pointer;margin-top:12px">
        <input type="checkbox" id="cal-feed-tasks" style="transform:scale(1.25);margin-top:6px">
        <div class="body"><div class="title" style="font-weight:500">Also send to-do items</div>
        <div class="quiet" style="font-size:.82em">Off means appointments only — your calendar stays a calendar.
        Your tasks are still in Sage either way.</div></div>
      </label>
      <button class="btn danger small" id="cal-reset" style="margin-top:10px">Reset private calendar link</button>
    </div>
    <h2>📥 Your calendar → Sage</h2>
    <div id="icloud-box"><div class="card"><span class="quiet">Checking…</span></div></div>
    <h2>📍 Places</h2>
    ${locs.map((l) => `<div class="card"><b>${l.emoji} ${esc(l.name)}</b><div class="quiet">${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}${l.is_home ? ' · home' : ''}</div>
      <div class="quiet">Weather for this place comes from these coordinates.</div></div>`).join('')}
    <h2>Your data</h2>
    <div class="btn-row">
      <a class="btn ghost small" href="/api/export.json">⬇️ Export everything</a>
      <button class="btn danger small" id="sign-out">Sign out</button>
    </div>
    <button class="btn danger small" id="sign-out-all" style="margin-top:10px">Sign out everywhere</button>
    <h2>🔐 Sign-in security</h2>
    <div id="security-box"><div class="card"><span class="quiet">Checking…</span></div></div>
    <h2>🗣️ How Sage talks to you</h2>
    <div class="card">
      <p style="margin:0 0 8px;font-size:.88em">Say it in your own words and Sage will follow it — how blunt, how warm,
      how short, what to stop doing. Your wording wins over mine.</p>
      <textarea id="voice-text" style="min-height:110px" placeholder="e.g. Be blunter with me. Skip the reassurance. If I'm avoiding something, say so."></textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn small" id="voice-save">Save</button>
        <button class="btn ghost small" id="voice-see">See the defaults</button>
      </div>
      <p class="quiet" style="font-size:.78em;margin:8px 0 0">This changes tone only. The rules that keep Sage honest — never
      inventing that something's done, never nagging about things that aren't ready — stay put.</p>
    </div>
    <h2>🤖 ChatGPT</h2>
    <div id="gpt-box"><div class="card"><span class="quiet">Checking…</span></div></div>
    <h2>🧠 Thinking layer</h2>
    <div class="card" id="ai-status"><span class="quiet">${AI_ON ? 'Checking…' : 'No key set — capture still works, just more literally.'}</span></div>
    <div class="card">
      <b>OpenAI account</b>
      <p class="quiet" style="margin:4px 0 10px">Check API credits, billing, and usage on OpenAI’s secure account page.</p>
      <div class="btn-row">
        <a class="btn small" href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener">Billing & credits ↗</a>
        <a class="btn ghost small" href="https://platform.openai.com/usage" target="_blank" rel="noopener">Usage ↗</a>
      </div>
    </div>
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  // Scoped to #main on purpose. The <html> element carries data-text and
  // data-theme (set at boot so the page never flashes the wrong theme), so an
  // unscoped selector attaches these handlers to the whole document — and
  // after one visit to Settings, every tap anywhere would bounce back here.
  $$('#main [data-text]').forEach((b) => b.onclick = () => {
    document.documentElement.dataset.text = b.dataset.text;
    try { localStorage.setItem('sage_text', b.dataset.text); } catch {}
    setView('settings');
  });
  $$('#main [data-theme]').forEach((b) => b.onclick = () => {
    document.documentElement.dataset.theme = b.dataset.theme;
    try { localStorage.setItem('sage_theme', b.dataset.theme); } catch {}
    setView('settings');
  });
  $('#sign-out').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  $('#sign-out-all').onclick = async () => {
    if (!confirm('Sign out every phone and browser connected to Sage?')) return;
    await api('/api/logout-all', { method: 'POST' }); location.reload();
  };
  $('[data-back]').onclick = () => setView('more');
  api('/api/calendar-url').then(({ path }) => {
    $('#cal-sub').href = `webcal://${location.host}${path}`;
    $('#cal-copy').onclick = async () => {
      await navigator.clipboard.writeText(`${location.origin}${path}`);
      toast('Copied. Paste it into any calendar app.');
    };
  }).catch(() => {});
  api('/api/preferences').then((prefs) => {
    const cb = $('#cal-feed-tasks');
    if (!cb) return;
    cb.checked = prefs.cal_feed_tasks === '1';
    cb.onchange = async () => {
      await api('/api/preferences', { method: 'POST', body: { cal_feed_tasks: cb.checked ? '1' : '0' } });
      toast(cb.checked
        ? 'To-do items will show on your calendar too.'
        : 'Appointments only. The to-dos drop off next time your phone refreshes the calendar.', 6000);
    };
  }).catch(() => {});
  $('#cal-reset').onclick = async () => {
    if (!confirm('Reset the calendar link? Any calendar already subscribed with the old link will stop updating.')) return;
    await api('/api/calendar-url/reset', { method: 'POST' });
    toast('Calendar link reset. Subscribe again anywhere you still want it.');
    setView('settings');
  };
  api('/api/voice').then(({ voice, defaults }) => {
    if ($('#voice-text')) $('#voice-text').value = voice || '';
    if ($('#voice-save')) $('#voice-save').onclick = async () => {
      await api('/api/voice', { method: 'POST', body: { voice: $('#voice-text').value } });
      toast($('#voice-text').value.trim() ? 'Saved — Sage will talk that way from now on.' : 'Back to how Sage was.');
    };
    if ($('#voice-see')) $('#voice-see').onclick = () => {
      openModal(`<h2>🗣️ How Sage was told to talk</h2>
        <p class="sub">Sage already works this way. What you write in Settings is added on top, and wins where it disagrees.</p>
        <div class="card" style="white-space:pre-wrap;font-size:.85em">${esc(defaults)}</div>`);
    };
  }).catch(() => {});
  renderICloudBox();
  renderSecurityBox();
  renderGptBox();
  if (AI_ON) api('/api/ai/status').then((s) => {
    const el = $('#ai-status');
    if (!el) return;
    el.innerHTML = s.working
      ? `<b>✅ Connected</b> — ${esc(s.provider)}<div class="quiet" style="margin-top:4px">
         Sage picks the model automatically: <b>${esc(s.fast)}</b> for sorting what you say,
         <b>${esc(s.smart)}</b> for thinking with you.</div>`
      : `<b>⚠️ Key is set, but the call failed</b><div class="quiet" style="margin-top:4px">
         ${s.error ? esc(s.error) : 'Open Render → Logs for the provider response.'}
         Everything else still works.</div>`;
  }).catch(() => {});
};

async function renderSecurityBox() {
  const box = $('#security-box');
  if (!box) return;
  const s = await api('/api/security/status');
  box.innerHTML = `
    <div class="card">
      <b>${s.passkeys.length ? '✅ Face ID is ready' : 'Face ID / passkey'}</b>
      <p class="quiet" style="margin:4px 0 10px">${s.passkeys.length
        ? `Sage has ${s.passkeys.length} passkey${s.passkeys.length === 1 ? '' : 's'}. Your password still works as a fallback.`
        : 'Add this iPhone’s passkey so you can sign in with Face ID.'}</p>
      <button class="btn small" id="passkey-add">${s.passkeys.length ? 'Add another device' : 'Set up Face ID'}</button>
      ${s.passkeys.map((p) => `<div class="row flat" style="margin-top:8px">
        <div class="body"><div class="title">Passkey ${p.backed_up ? '· synced' : ''}</div>
          <div class="quiet">Added ${fmtDate(p.created_at.slice(0, 10))}${p.last_used ? ` · last used ${fmtDate(p.last_used.slice(0, 10))}` : ''}</div></div>
        <button class="btn danger small" data-passkey-del="${p.id}">Remove</button>
      </div>`).join('')}
    </div>
    <div class="card">
      <b>${s.has_recovery ? '✅ Recovery code is set' : 'Recovery code'}</b>
      <p class="quiet" style="margin:4px 0 10px">This is the emergency way back in if the password is forgotten and Face ID is unavailable.</p>
      <button class="btn ghost small" id="recovery-make">${s.has_recovery ? 'Replace recovery code' : 'Create recovery code'}</button>
    </div>
    <p class="quiet">New sign-ins stay active for up to ${s.session_days} days.</p>`;
  $('#passkey-add', box).onclick = async () => {
    if (!window.PublicKeyCredential) return toast('This browser does not support passkeys.');
    try {
      const start = await api('/api/passkey/register/options', { method: 'POST' });
      const credential = await navigator.credentials.create({ publicKey: registrationOptionsFromJSON(start.options) });
      await api('/api/passkey/register/verify', { method: 'POST', body: {
        flow_id: start.flow_id, response: credentialToJSON(credential),
      } });
      toast('Face ID is ready.'); renderSecurityBox();
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Face ID setup was cancelled.' : e.message, 5000); }
  };
  $$('[data-passkey-del]', box).forEach((b) => b.onclick = async () => {
    if (!confirm('Remove this passkey? The password will still work.')) return;
    await api(`/api/security/passkeys/${b.dataset.passkeyDel}`, { method: 'DELETE' });
    toast('Passkey removed.'); renderSecurityBox();
  });
  $('#recovery-make', box).onclick = async () => {
    if (s.has_recovery && !confirm('Replace the old recovery code? The old one will stop working immediately.')) return;
    const { code } = await api('/api/security/recovery-code', { method: 'POST' });
    const m = openModal(`
      <h2>Save this recovery code</h2>
      <p class="sub">This is shown once. Put it somewhere safe outside Sage.</p>
      <div class="card sage center" style="font-size:1.18em;letter-spacing:.08em"><b>${esc(code)}</b></div>
      <button class="btn big" id="recovery-copy">Copy code</button>
      <button class="btn ghost big" id="recovery-done" style="margin-top:8px">I saved it</button>`);
    $('#recovery-copy', m).onclick = async () => {
      await navigator.clipboard.writeText(code); toast('Recovery code copied.');
    };
    $('#recovery-done', m).onclick = () => { closeModal(); renderSecurityBox(); };
  };
}

// ---------------------------------------------------------------------------
// iCloud calendar, read-only
// ---------------------------------------------------------------------------
async function renderGptBox() {
  const box = $('#gpt-box');
  if (!box) return;
  const s = await api('/api/gpt-key').catch(() => null);
  if (!s) return;
  box.innerHTML = s.key ? `
    <div class="card">
      <b>✅ Connected</b>
      <div class="quiet" style="margin-top:4px">Your ChatGPT Sage can look things up here.
        ${s.key.use_count ? `Used ${s.key.use_count} time${s.key.use_count === 1 ? '' : 's'}${s.key.last_used ? `, last ${fmtDate(s.key.last_used.slice(0, 10))}` : ''}.` : 'It hasn’t asked yet.'}</div>
      <p class="quiet" style="margin:8px 0 0">It can only <b>read</b>. Adding or finishing things still happens here, where you approve them.</p>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost small" id="gpt-new">Make a new key</button>
        <button class="btn danger small" id="gpt-off">Disconnect</button>
      </div>
    </div>` : `
    <div class="card">
      <b>Let your ChatGPT Sage see this app</b>
      <p class="quiet" style="margin:4px 0 10px">Then you can ask it “what’s on today?” or “did I write down the Terminix thing?” and it will actually know.
        It can only read — it can never change anything.</p>
      <button class="btn small" id="gpt-on">Set it up</button>
    </div>`;
  if ($('#gpt-on')) $('#gpt-on').onclick = () => makeGptKey(s.schema_url);
  if ($('#gpt-new')) $('#gpt-new').onclick = () => makeGptKey(s.schema_url);
  if ($('#gpt-off')) $('#gpt-off').onclick = async () => {
    if (!confirm('Disconnect ChatGPT? It will stop being able to see anything here.')) return;
    await api('/api/gpt-key', { method: 'DELETE' });
    toast('Disconnected.');
    renderGptBox();
  };
}

async function makeGptKey(schemaUrl) {
  const r = await api('/api/gpt-key', { method: 'POST' });
  const m = openModal(`
    <h2>🤖 Connect ChatGPT</h2>
    <p class="sub">This takes a few minutes on a computer, and you only do it once.</p>
    <div class="card sage" style="font-size:.9em">
      <b>In ChatGPT</b>
      <ol style="margin:8px 0 0 -12px;line-height:1.75">
        <li>Open your <b>Sage</b> GPT → <b>Edit</b> → <b>Configure</b></li>
        <li>Scroll down to <b>Actions</b> → <b>Create new action</b></li>
        <li>Under Schema choose <b>Import from URL</b> and paste the first box below</li>
        <li>Under Authentication choose <b>API Key</b>, type <b>Bearer</b>, and paste the second box</li>
        <li>Save, and update your GPT</li>
      </ol>
    </div>
    <label class="field">1. Schema URL</label>
    <div class="btn-row"><input type="text" id="gpt-url" value="${esc(r.schema_url || schemaUrl)}" readonly style="flex:1">
      <button class="btn small" id="gpt-copyurl">Copy</button></div>
    <label class="field">2. Your key — copy it now, it isn't shown again</label>
    <div class="btn-row"><input type="text" id="gpt-token" value="${esc(r.token)}" readonly style="flex:1">
      <button class="btn small" id="gpt-copykey">Copy</button></div>
    <p class="quiet" style="font-size:.8em;margin-top:12px">Keep the key private — anyone with it could read this app.
      You can disconnect from Settings at any time and it stops working immediately.
      When ChatGPT looks something up, what it reads goes to OpenAI, the same as anything else you type there.</p>
    <div style="margin-top:14px"><button class="btn big" id="gpt-done">Done</button></div>`);
  $('#gpt-copyurl', m).onclick = async () => { await navigator.clipboard.writeText($('#gpt-url', m).value); toast('Copied.'); };
  $('#gpt-copykey', m).onclick = async () => { await navigator.clipboard.writeText($('#gpt-token', m).value); toast('Copied. Paste it into ChatGPT now.'); };
  $('#gpt-done', m).onclick = () => { closeModal(); renderGptBox(); };
}

async function renderICloudBox() {
  const box = $('#icloud-box');
  if (!box) return;
  const s = await api('/api/calendar/status').catch(() => ({
    connected: false, icloud: { connected: false }, calendars: [], feeds: [], reminder_lists: [], reminder_count: 0,
  }));
  const when = s.last_sync ? fmtDate(s.last_sync.slice(0, 10)) : 'not yet';

  const icloudCard = s.icloud.connected ? `
    <div class="card">
      <b>${s.icloud.last_error ? '⚠️' : '✅'} iCloud — ${esc(s.icloud.apple_id)}</b>
      ${s.icloud.last_error ? `<div class="quiet" style="color:var(--alert);margin-top:4px">${esc(s.icloud.last_error)}</div>` : ''}
      <div style="margin-top:8px">
        ${s.calendars.map((c) => `
          <label class="row flat" style="align-items:center;cursor:pointer">
            <input type="checkbox" data-cal="${c.id}" ${c.enabled ? 'checked' : ''} style="transform:scale(1.25)">
            <div class="body"><div class="title" style="font-weight:500">${esc(c.name)}</div></div>
          </label>`).join('') || '<span class="quiet">No calendars found yet.</span>'}
      </div>
      <div style="margin-top:12px">
        <b>⏰ Reminder lists</b>
        ${s.reminder_lists.map((l) => `
          <label class="row flat" style="align-items:center;cursor:pointer">
            <input type="checkbox" data-rem-list="${l.id}" ${l.enabled ? 'checked' : ''} style="transform:scale(1.25)">
            <div class="body"><div class="title" style="font-weight:500">${esc(l.name)}</div>
            ${l.last_error ? `<div class="quiet" style="color:var(--alert);font-size:.82em">${esc(l.last_error)}</div>` : ''}</div>
          </label>`).join('') || '<div class="quiet" style="margin-top:4px">No Apple reminder lists were exposed by this iCloud connection.</div>'}
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost small" id="ic-probe">What did Apple send?</button>
        <button class="btn danger small" id="ic-off">Disconnect iCloud</button>
      </div>
    </div>` : `
    <div class="card">
      <b>🍎 iCloud</b>
      <p class="quiet" style="margin:4px 0 10px">Connect with an app-specific password — about a minute to set up.</p>
      <button class="btn small" id="ic-connect">Connect iCloud</button>
    </div>`;

  const feedCards = s.feeds.map((f) => `
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="flex:1">${f.last_error ? '⚠️' : '✅'} ${esc(f.name)}</b>
        <button class="btn danger small" data-feedoff="${f.id}">Remove</button>
      </div>
      ${f.last_error ? `<div class="quiet" style="color:var(--alert);margin-top:4px">${esc(f.last_error)}</div>` : ''}
    </div>`).join('');

  box.innerHTML = `
    <p class="quiet" style="margin:-6px 0 10px">Sage only <b>reads</b> your calendars — it never adds, changes or
    deletes anything. Appointments show up in Today and This Week, and a PT appointment switches off your home PT
    rounds by itself.</p>
    ${s.connected ? `<div class="btn-row" style="margin-bottom:12px">
      <button class="btn small" id="ic-sync">🔄 Check for changes now</button></div>` : ''}
    ${icloudCard}
    ${feedCards}
    <div class="card">
      <b>📆 Google (or any other calendar)</b>
      <p class="quiet" style="margin:4px 0 10px">Paste the calendar's private iCal link. No Google account setup needed.</p>
      <button class="btn small" id="feed-add">Add a calendar link</button>
    </div>
    ${s.connected ? `<p class="quiet" style="margin-top:8px">${s.event_count} appointment${s.event_count === 1 ? '' : 's'} · ${s.reminder_count || 0} open reminder${s.reminder_count === 1 ? '' : 's'} · last checked ${esc(when)}</p>` : ''}`;

  if ($('#ic-connect')) $('#ic-connect').onclick = openICloudConnect;
  if ($('#feed-add')) $('#feed-add').onclick = openFeedConnect;
  if ($('#ic-sync')) $('#ic-sync').onclick = async () => {
    $('#ic-sync').disabled = true;
    $('#ic-sync').textContent = 'Checking…';
    const r = await api('/api/calendar/sync', { method: 'POST' });
    toast(r.errors && r.errors.length ? r.errors[0] : `Up to date — ${r.events || 0} appointments and ${r.reminders || 0} reminders.`,
      r.errors && r.errors.length ? 9000 : 5000);
    renderICloudBox();
  };
  if ($('#ic-probe')) $('#ic-probe').onclick = async () => {
    $('#ic-probe').disabled = true;
    $('#ic-probe').textContent = 'Asking Apple…';
    let d;
    try { d = await api('/api/calendar/diagnostics'); } catch (e) { toast(e.message, 7000); return renderICloudBox(); }
    const skipped = d.considered.filter((c) => c.skipped);
    const m = openModal(`
      <h2>📋 What Apple sent</h2>
      <p class="sub">This is the answer Sage got when it asked your iCloud account what calendars and
      reminder lists exist. If something you see in your Reminders app isn't in here, iCloud isn't
      sharing it — which is a setting on your phone, not a problem with Sage.</p>
      <div class="card">
        <b>${d.kept.length} kept</b>
        ${d.kept.map((c) => `<div class="quiet" style="margin-top:4px">• <b>${esc(c.name)}</b> — ${esc(c.holds)}</div>`).join('') || '<div class="quiet">nothing</div>'}
      </div>
      ${skipped.length ? `<div class="card">
        <b>${skipped.length} skipped</b>
        ${skipped.map((c) => `<div class="quiet" style="margin-top:4px">• ${esc(c.name || c.href)} — ${esc(c.skipped)}</div>`).join('')}
      </div>` : ''}
      <p class="quiet" style="font-size:.8em">Answered ${d.status} · ${d.responses} collections offered · ${esc(d.apple_id)}</p>
      <div class="btn-row"><button class="btn small" id="probe-copy">Copy all of it</button>
        <button class="btn ghost small" id="probe-close">Close</button></div>`);
    $('#probe-copy', m).onclick = async () => {
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
      toast('Copied — you can paste that into a message.');
    };
    $('#probe-close', m).onclick = closeModal;
    renderICloudBox();
  };
  if ($('#ic-off')) $('#ic-off').onclick = async () => {
    if (!confirm('Disconnect iCloud? Your calendar itself is untouched.')) return;
    await api('/api/calendar/connect', { method: 'DELETE' });
    toast('Disconnected.');
    renderICloudBox();
  };
  $$('[data-cal]', box).forEach((cb) => cb.onchange = async () => {
    await api(`/api/calendar/calendars/${cb.dataset.cal}`, { method: 'PATCH', body: { enabled: cb.checked } });
    if (cb.checked) await api('/api/calendar/sync', { method: 'POST' });
    renderICloudBox();
  });
  $$('[data-rem-list]', box).forEach((cb) => cb.onchange = async () => {
    await api(`/api/reminders/lists/${cb.dataset.remList}`, { method: 'PATCH', body: { enabled: cb.checked } });
    if (cb.checked) await api('/api/calendar/sync', { method: 'POST' });
    renderICloudBox();
  });
  $$('[data-feedoff]', box).forEach((b) => b.onclick = async () => {
    if (!confirm('Remove this calendar from Sage? The calendar itself is untouched.')) return;
    await api(`/api/calendar/feed/${b.dataset.feedoff}`, { method: 'DELETE' });
    toast('Removed.');
    renderICloudBox();
  });
}

function openFeedConnect() {
  const m = openModal(`
    <h2>📆 Add a Google calendar</h2>
    <p class="sub">Google gives each calendar a private link. Paste it here and Sage can read it — nothing else to set up.</p>
    <div class="card sage" style="font-size:.88em">
      <b>Finding the link — about a minute</b>
      <ol style="margin:8px 0 0 -12px;line-height:1.7">
        <li>On a computer, open <b>Google Calendar</b></li>
        <li>Hover the calendar's name on the left → <b>⋮</b> → <b>Settings and sharing</b></li>
        <li>Scroll to <b>Integrate calendar</b></li>
        <li>Copy <b>Secret address in iCal format</b> (it ends in <b>.ics</b>)</li>
      </ol>
      <p class="quiet" style="margin:8px 0 0">Keep that link private — anyone who has it can read that calendar. You can reset it from the same screen at any time.</p>
    </div>
    <label class="field">Paste the link</label>
    <input type="text" id="fd-url" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics">
    <label class="field">Call it what? (optional)</label>
    <input type="text" id="fd-name" placeholder="e.g. Google, David's calendar">
    <div style="margin-top:16px"><button class="btn big" id="fd-go">Add it</button></div>`);
  $('#fd-go', m).onclick = async () => {
    const url = $('#fd-url', m).value.trim();
    if (!url) return toast('Paste the link first.');
    $('#fd-go', m).disabled = true;
    $('#fd-go', m).textContent = 'Checking the link…';
    try {
      const r = await api('/api/calendar/feed', { method: 'POST', body: { url, name: $('#fd-name', m).value } });
      closeModal();
      toast(`Added${r.name ? ` — ${r.name}` : ''}. ${r.events || 0} appointments came across.`, 5000);
      renderICloudBox();
    } catch (e) {
      toast(e.message, 6000);
      $('#fd-go', m).disabled = false;
      $('#fd-go', m).textContent = 'Add it';
    }
  };
}

function openICloudConnect() {
  const m = openModal(`
    <h2>📥 Connect your iCloud calendar</h2>
    <p class="sub">Apple needs a special password just for Sage — your real Apple password never comes here, and you can cancel Sage's access from Apple at any time.</p>
    <div class="card sage" style="font-size:.88em">
      <b>Getting the password — about a minute</b>
      <ol style="margin:8px 0 0 -12px;line-height:1.7">
        <li>Go to <b>appleid.apple.com</b> and sign in</li>
        <li><b>Sign-In and Security</b> → <b>App-Specific Passwords</b></li>
        <li>Tap <b>+</b>, name it <b>Sage</b></li>
        <li>Copy the password it shows you (four groups of four letters)</li>
      </ol>
    </div>
    <label class="field">Your Apple ID (the email you sign in with)</label>
    <input type="email" id="ic-id" autocomplete="username" placeholder="you@icloud.com">
    <label class="field">The app-specific password</label>
    <input type="password" id="ic-pw" autocomplete="off" placeholder="xxxx-xxxx-xxxx-xxxx">
    <div style="margin-top:16px"><button class="btn big" id="ic-go">Connect</button></div>
    <p class="quiet" style="font-size:.8em">Stored encrypted, used only to read your calendar. Sage never writes to it.</p>`);
  $('#ic-go', m).onclick = async () => {
    const apple_id = $('#ic-id', m).value.trim();
    const password = $('#ic-pw', m).value.trim();
    if (!apple_id || !password) return toast('Both fields, please.');
    $('#ic-go', m).disabled = true;
    $('#ic-go', m).textContent = 'Connecting…';
    try {
      const r = await api('/api/calendar/connect', { method: 'POST', body: { apple_id, password } });
      closeModal();
      // A connection that authenticates but brings nothing back is not a
      // success, and shouldn't be announced as one.
      toast(r.errors && r.errors.length ? r.errors[0] : `Connected — ${r.events || 0} appointments came across.`,
        r.errors && r.errors.length ? 9000 : 4000);
      renderICloudBox();
    } catch (e) {
      toast(e.message, 6000);
      $('#ic-go', m).disabled = false;
      $('#ic-go', m).textContent = 'Connect';
    }
  };
}

// ---------------------------------------------------------------------------
// CAPTURE — the whole point. Say it once.
// ---------------------------------------------------------------------------
function openCapture() {
  const m = openModal(`
    <h2>🌿 Tell Sage</h2>
    <p class="sub">Say it however it comes out. Sage sorts it — you approve before anything is saved.</p>
    <textarea id="cap-text" placeholder="Good morning Sage. 150.0.&#10;&#10;We're going to the lake Friday.&#10;&#10;I paid Terminix."></textarea>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn quietbtn" id="cap-voice" style="flex:1">🎤 Talk</button>
      <button class="btn" id="cap-go" style="flex:2">Sort it out</button>
    </div>
    <div id="cap-out"></div>`);
  wireVoice($('#cap-voice', m), $('#cap-text', m));
  const go = async () => {
    const text = $('#cap-text', m).value.trim();
    if (!text) return toast('Say something first.');
    $('#cap-out', m).innerHTML = '<div class="empty">Thinking…</div>';
    try {
      const r = await api('/api/capture', { method: 'POST', body: { text } });
      renderProposals(m, r);
    } catch (e) { toast(e.message); $('#cap-out', m).innerHTML = ''; }
  };
  $('#cap-go', m).onclick = go;
}

function proposalCard(p, idx) {
  const checked = p.confidence !== 'low' ? 'checked' : '';
  if (p.kind === 'item') {
    const i = p.item || {};
    return `
      <div class="card" data-prop="${idx}">
        <label style="display:flex;gap:11px;align-items:flex-start">
          <input type="checkbox" ${checked} style="margin-top:6px;transform:scale(1.35)">
          <div style="flex:1">
            <input type="text" data-f="title" value="${esc(i.title || '')}" style="font-weight:600">
            <div class="btn-row" style="margin-top:6px">
              <select data-f="type" style="flex:1">${Object.entries(TYPES).map(([v, l]) => `<option value="${v}" ${v === (i.type || 'task') ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <select data-f="importance" style="flex:1">${Object.entries(IMPORTANCE).map(([v, l]) => `<option value="${v}" ${v === (i.importance || 'should') ? 'selected' : ''}>${l}</option>`).join('')}</select>
            </div>
            <div class="btn-row" style="margin-top:6px">
              <input type="date" data-f="due_at" value="${esc((i.due_at || '').slice(0, 10))}" style="flex:1">
            </div>
            ${i.target_window ? `<div class="quiet" style="margin-top:5px">not until ${esc(i.target_window)}</div>` : ''}
            ${i.event_kind ? `<div class="quiet" style="margin-top:5px">${esc(i.event_kind)}</div>` : ''}
          </div>
        </label>
      </div>`;
  }
  if (p.kind === 'complete') {
    return `<div class="card sage" data-prop="${idx}">
      <label style="display:flex;gap:11px;align-items:center">
        <input type="checkbox" ${checked} style="transform:scale(1.35)">
        <div><b>✓ Mark done:</b> ${esc(p.target?.title || '')}${p.why ? `<div class="quiet">${esc(p.why)}</div>` : ''}</div>
      </label></div>`;
  }
  if (p.kind === 'update') {
    return `<div class="card sky" data-prop="${idx}">
      <label style="display:flex;gap:11px;align-items:center">
        <input type="checkbox" ${checked} style="transform:scale(1.35)">
        <div><b>Change:</b> ${esc(p.target?.title || '')}<div class="quiet">${esc(p.why || Object.keys(p.changes || {}).join(', '))}</div></div>
      </label></div>`;
  }
  if (p.kind === 'tracking') {
    return `<div class="card sage" data-prop="${idx}">
      <label style="display:flex;gap:11px;align-items:center">
        <input type="checkbox" ${checked} style="transform:scale(1.35)">
        <div><b>Record ${esc(p.kindOf || 'weight')}:</b> ${esc(String(p.value))}</div>
      </label></div>`;
  }
  if (p.kind === 'memory') {
    const mem = p.memory || {};
    return `<div class="card sky" data-prop="${idx}">
      <label style="display:flex;gap:11px;align-items:flex-start">
        <input type="checkbox" ${checked} style="margin-top:6px;transform:scale(1.35)">
        <div style="flex:1">
          <b>🧠 Remember this</b>
          <input type="text" data-f="content" value="${esc(mem.content || '')}" style="margin-top:6px">
          <div class="quiet" style="margin-top:4px">${esc(mem.kind || 'fact')} · kept until you delete it</div>
        </div>
      </label></div>`;
  }
  if (p.kind === 'trip') {
    return `<div class="card clay" data-prop="${idx}">
      <label style="display:flex;gap:11px;align-items:center">
        <input type="checkbox" ${checked} style="transform:scale(1.35)">
        <div><b>🚗 Trip to ${esc(p.location_key || 'lake')}</b><div class="quiet">${esc(p.start_date || p.when || '')} — checklists wake up</div></div>
      </label></div>`;
  }
  return '';
}

function renderProposals(m, r) {
  if (!r.proposals.length) {
    $('#cap-out', m).innerHTML = `<div class="card">${esc(r.reply || 'I did not find anything to save in that.')}</div>`;
    return;
  }
  $('#cap-out', m).innerHTML = `
    ${r.reply ? `<div class="card sage" style="margin-top:14px"><b>🌿</b> ${esc(r.reply)}</div>` : ''}
    ${r.proposals.map(proposalCard).join('')}
    <button class="btn big" id="cap-save">Save the checked ones</button>
    ${r.source !== 'ai' ? '<p class="quiet center">Sorted with simple rules — the AI layer isn’t connected.</p>' : ''}`;
  $('#cap-save', m).onclick = async () => {
    const chosen = [];
    for (const card of $$('[data-prop]', m)) {
      if (!$('input[type=checkbox]', card).checked) continue;
      const p = { ...r.proposals[+card.dataset.prop] };
      if (p.kind === 'item') {
        p.item = { ...p.item };
        for (const f of $$('[data-f]', card)) p.item[f.dataset.f] = f.value;
      } else if (p.kind === 'memory') {
        p.memory = { ...p.memory };
        for (const f of $$('[data-f]', card)) p.memory[f.dataset.f] = f.value;
      }
      chosen.push(p);
    }
    if (!chosen.length) { closeModal(); return toast('Nothing saved.'); }
    const { applied } = await api('/api/capture/apply', { method: 'POST', body: { raw: r.raw, proposals: chosen } });
    closeModal();
    toast(applied.length === 1 ? 'Got it.' : `Got it — ${applied.length} things.`);
    setView(VIEW);
  };
}

function wireVoice(btn, textarea) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.onclick = () => toast('Voice isn’t available in this browser — typing works the same.'); return; }
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.continuous = true; rec.interimResults = false;
    btn.textContent = '⏹ Listening…';
    btn.classList.add('listening');
    rec.onresult = (e) => {
      for (const res of e.results) if (res.isFinal) textarea.value = (textarea.value + ' ' + res[0].transcript).trim();
    };
    rec.onend = () => { btn.textContent = '🎤 Talk'; btn.classList.remove('listening'); rec = null; };
    rec.onerror = () => { btn.textContent = '🎤 Talk'; btn.classList.remove('listening'); rec = null; };
    rec.start();
  };
}

// ---------------------------------------------------------------------------
// Item detail — with correction in her own words
// ---------------------------------------------------------------------------
function openItem(i) {
  const m = openModal(`
    <h2>${esc(i.title)}</h2>
    ${i.raw_capture && i.raw_capture !== i.title ? `<p class="quiet">You said: “${esc(i.raw_capture)}”</p>` : ''}
    ${i.blockers?.length ? `<div class="card clay">Waiting on: ${i.blockers.map(esc).join(', ')}</div>` : ''}
    ${i.ai_private ? '' : `<label class="field">Say what's wrong with it</label>
    <div class="btn-row">
      <input type="text" id="it-fix" placeholder="e.g. that isn't urgent, leave it until September" style="flex:1">
      <button class="btn small" id="it-fixgo">Fix</button>
    </div>`}
    <label class="field">Title</label><input type="text" id="it-title" value="${esc(i.title)}">
    <label class="field">Notes</label><textarea id="it-note" style="min-height:70px">${esc(i.note)}</textarea>
    <label class="row flat" style="align-items:center;margin-top:10px;cursor:pointer">
      <input type="checkbox" id="it-private" ${i.ai_private ? 'checked' : ''} style="transform:scale(1.25)">
      <div class="body"><b>Private from AI</b><div class="quiet">Keep this in Sage, but never send it to OpenAI.</div></div>
    </label>
    <div class="btn-row">
      <div style="flex:1"><label class="field">Kind</label>
        <select id="it-type">${Object.entries(TYPES).map(([v, l]) => `<option value="${v}" ${v === i.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div style="flex:1"><label class="field">Weight</label>
        <select id="it-imp">${Object.entries(IMPORTANCE).map(([v, l]) => `<option value="${v}" ${v === i.importance ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="btn-row">
      <div style="flex:1"><label class="field">Due</label><input type="date" id="it-due" value="${esc((i.due_at || '').slice(0, 10))}"></div>
      <div style="flex:1"><label class="field">Not before</label><input type="date" id="it-win" value="${esc(i.window_start || '')}"></div>
    </div>
    ${i.type !== 'project' ? `<label class="field">Project</label>
      <select id="it-project"><option value="0">No project</option></select>` : ''}
    ${i.type === 'project' ? `<label class="field">Next action</label><input type="text" id="it-next" value="${esc(i.next_action || '')}">
      <label class="field">What done looks like</label><input type="text" id="it-outcome" value="${esc(i.outcome || '')}">` : ''}
    <div class="btn-row" style="margin-top:18px">
      <button class="btn" id="it-save" style="flex:2">Save</button>
      ${i.status !== 'done' ? '<button class="btn ghost" id="it-done">✓ Done</button>' : '<button class="btn ghost" id="it-open">Reopen</button>'}
      <button class="btn ghost" id="it-someday">Someday</button>
    </div>
    <button class="btn danger small" id="it-del" style="margin-top:10px">Delete</button>`);

  if ($('#it-project', m)) {
    api('/api/items?type=project&status=open').then((projects) => {
      const select = $('#it-project', m);
      if (!select) return;
      select.innerHTML = `<option value="0">No project</option>${projects.map((p) =>
        `<option value="${p.id}" ${p.id === i.project_id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}`;
    }).catch(() => {});
  }
  if ($('#it-fixgo', m)) $('#it-fixgo', m).onclick = async () => {
    const text = $('#it-fix', m).value.trim();
    if (!text) return;
    try {
      const r = await api('/api/correct', { method: 'POST', body: { item_id: i.id, text } });
      closeModal(); toast(r.reply || 'Updated.'); setView(VIEW);
    } catch (e) { toast(e.message); }
  };
  $('#it-save', m).onclick = async () => {
    const body = {
      title: $('#it-title', m).value, note: $('#it-note', m).value,
      type: $('#it-type', m).value, importance: $('#it-imp', m).value,
      due_at: $('#it-due', m).value, window_start: $('#it-win', m).value,
      ai_private: $('#it-private', m).checked,
    };
    if ($('#it-project', m)) body.project_id = parseInt($('#it-project', m).value, 10) || 0;
    if ($('#it-next', m)) { body.next_action = $('#it-next', m).value; body.outcome = $('#it-outcome', m).value; }
    await api(`/api/items/${i.id}`, { method: 'PATCH', body });
    closeModal(); toast('Saved.'); setView(VIEW);
  };
  const setStatus = (status, msg) => async () => {
    await api(`/api/items/${i.id}`, { method: 'PATCH', body: { status } });
    closeModal(); toast(msg); setView(VIEW);
  };
  if ($('#it-done', m)) $('#it-done', m).onclick = setStatus('done', 'Done.');
  if ($('#it-open', m)) $('#it-open', m).onclick = setStatus('open', 'Back on the list.');
  $('#it-someday', m).onclick = setStatus('someday', 'Moved to someday.');
  $('#it-del', m).onclick = async () => {
    if (!confirm('Delete this?')) return;
    await api(`/api/items/${i.id}`, { method: 'DELETE' });
    closeModal(); toast('Deleted.'); setView(VIEW);
  };
}

// ---------------------------------------------------------------------------
// Ask Sage — reasoning over her own state
// ---------------------------------------------------------------------------
function openAsk() {
  const m = openModal(`
    <h2>💬 Ask Sage</h2>
    <p class="sub">About your own list — “what am I forgetting this week?”, “is anything waiting on me?”</p>
    <div class="btn-row">
      <input type="text" id="ask-q" placeholder="Ask anything" style="flex:1">
      <button class="btn small" id="ask-go">Ask</button>
    </div>
    <div id="ask-out"></div>`);
  const go = async () => {
    const text = $('#ask-q', m).value.trim();
    if (!text) return;
    $('#ask-out', m).innerHTML = '<div class="empty">Thinking…</div>';
    const { answer } = await api('/api/ask', { method: 'POST', body: { text } });
    $('#ask-out', m).innerHTML = `<div class="card" style="margin-top:14px;white-space:pre-wrap">${linkify(answer)}</div>
      <button class="btn ghost small" id="ask-more" style="margin-top:10px">Keep talking about this →</button>`;
    $('#ask-more', m).onclick = async () => {
      const th = await api('/api/threads', { method: 'POST', body: { kind: 'thinking' } });
      closeModal();
      OPEN_THREAD = th.id;
      PENDING_FIRST = text;
      setView('think');
    };
  };
  $('#ask-go', m).onclick = go;
  $('#ask-q', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// ---------------------------------------------------------------------------
// MEMORY — everything Sage has been told to remember, in plain sight.
// Memory she can't read is memory she can't trust, so all of it is visible
// and every line is editable or deletable.
// ---------------------------------------------------------------------------
// 📌 is reserved for "pinned" — a plain fact must not wear it.
const MEM_KINDS = { fact: '🔹 Fact', preference: '💛 Preference', decision: '✔️ Decision',
  principle: '🧭 Principle', person: '👤 Person', place: '📍 Place' };

VIEWS.memory = async function renderMemory() {
  const list = await api(`/api/memories?q=${encodeURIComponent(VIEWS._memQ || '')}`);
  $('#main').innerHTML = `
    <h1>🧠 What Sage knows</h1>
    <p class="sub">Everything you've asked Sage to remember. Change or delete any of it — this is yours.</p>
    <input type="text" id="mem-q" placeholder="🔍 Search what Sage knows…" value="${esc(VIEWS._memQ || '')}">
    <button class="btn small" id="mem-add" style="margin-top:10px">＋ Tell Sage something to remember</button>
    ${list.length ? list.map((m) => `
      <div class="card" data-mem="${m.id}">
        <div style="display:flex;gap:8px;align-items:flex-start">
          <div style="flex:1">
            <div>${esc(m.content)}</div>
            <div class="quiet" style="margin-top:4px">${esc(MEM_KINDS[m.kind] || m.kind)}${m.pinned ? ' · 📌 always remembered' : ''}${m.source === 'thread' ? ' · from a conversation' : ''}</div>
          </div>
          <button class="btn ghost small" data-memedit="${m.id}">✎</button>
        </div>
      </div>`).join('')
    : `<div class="empty">${VIEWS._memQ ? 'Nothing matches.' : 'Nothing yet. Say “remember that…” to Sage, or add something here.'}</div>`}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;

  let deb;
  $('#mem-q').addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { VIEWS._memQ = $('#mem-q').value; renderMemory(); }, 250);
  });
  $('#mem-add').onclick = () => openMemoryModal();
  $$('[data-memedit]').forEach((b) => b.onclick = () => openMemoryModal(list.find((x) => x.id == b.dataset.memedit)));
  $('[data-back]').onclick = () => setView('more');
};

function openMemoryModal(mem = null) {
  const m = openModal(`
    <h2>🧠 ${mem ? 'This memory' : 'Remember this'}</h2>
    <p class="sub">${mem ? '' : 'Something true about your life that Sage should carry forward — not a task.'}</p>
    <label class="field">What should Sage remember?</label>
    <textarea id="mm-content" style="min-height:80px" placeholder="e.g. The silver tea set matters because it was David's mother's.">${esc(mem?.content || '')}</textarea>
    <label class="field">What kind of thing is it?</label>
    <select id="mm-kind">${Object.entries(MEM_KINDS).map(([v, l]) => `<option value="${v}" ${v === (mem?.kind || 'fact') ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:10px">
      <div><b style="font-size:.9em">Always remember this</b><br><span class="quiet" style="font-size:.8em">Carried into every conversation, not only the relevant ones.</span></div>
      <button type="button" class="chip ${mem?.pinned ? 'on' : ''}" id="mm-pin">${mem?.pinned ? 'yes' : 'no'}</button>
    </div>
    <div class="btn-row" style="margin-top:18px">
      <button class="btn" id="mm-save" style="flex:2">${mem ? 'Save' : 'Remember it'}</button>
      ${mem ? '<button class="btn danger small" id="mm-del">Forget this</button>' : ''}
    </div>`);
  let pinned = !!mem?.pinned;
  $('#mm-pin', m).onclick = () => {
    pinned = !pinned;
    $('#mm-pin', m).classList.toggle('on', pinned);
    $('#mm-pin', m).textContent = pinned ? 'yes' : 'no';
  };
  $('#mm-save', m).onclick = async () => {
    const content = $('#mm-content', m).value.trim();
    if (!content) return toast('What should Sage remember?');
    const body = { content, kind: $('#mm-kind', m).value, pinned };
    await (mem ? api(`/api/memories/${mem.id}`, { method: 'PATCH', body })
      : api('/api/memories', { method: 'POST', body }));
    closeModal(); toast(mem ? 'Saved.' : 'Sage will remember that.');
    if (VIEW === 'memory') VIEWS.memory();
  };
  if ($('#mm-del', m)) $('#mm-del', m).onclick = async () => {
    if (!confirm('Forget this? Sage won’t bring it up again.')) return;
    await api(`/api/memories/${mem.id}`, { method: 'DELETE' });
    closeModal(); toast('Forgotten.');
    if (VIEW === 'memory') VIEWS.memory();
  };
}

// ---------------------------------------------------------------------------
// THINKING — a place to muse, decide, or empty her head at bedtime.
// Nothing said here becomes a task unless she asks for it.
// ---------------------------------------------------------------------------
let OPEN_THREAD = null;
let PENDING_FIRST = null;

VIEWS.think = async function renderThink() {
  if (OPEN_THREAD) return renderThread(OPEN_THREAD);
  const threads = await api('/api/threads');
  $('#main').innerHTML = `
    <h1>💭 Thinking</h1>
    <p class="sub">Somewhere to talk it through — or just put it down for the night.</p>
    <button class="btn big" id="th-new">💭 Think something through</button>
    <button class="btn big quietbtn" id="th-bed">🌙 Bedtime brain dump<br>
      <small style="font-weight:400">Say it all. No advice, no planning — just held until morning.</small></button>
    ${threads.length ? '<h2>Earlier</h2>' : ''}
    ${threads.map((t) => `
      <div class="row" data-thread="${t.id}">
        <span style="font-size:1.2em;margin-top:1px">${t.kind === 'bedtime' ? '🌙' : '💭'}</span>
        <div class="body">
          <div class="title">${esc(t.title || 'Untitled')}</div>
          <div class="meta">${fmtDate(t.last_at.slice(0, 10))} · ${t.message_count} message${t.message_count === 1 ? '' : 's'}</div>
        </div>
        <span class="chev">›</span>
      </div>`).join('')}
    ${!threads.length ? '<div class="empty">Nothing yet. Anything on your mind is a fine place to start.</div>' : ''}
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  $('#th-new').onclick = async () => {
    const t = await api('/api/threads', { method: 'POST', body: { kind: 'thinking' } });
    OPEN_THREAD = t.id; setView('think');
  };
  $('#th-bed').onclick = async () => {
    const t = await api('/api/threads', { method: 'POST', body: { kind: 'bedtime' } });
    OPEN_THREAD = t.id; setView('think');
  };
  $$('[data-thread]').forEach((r) => r.onclick = () => { OPEN_THREAD = +r.dataset.thread; setView('think'); });
  $('[data-back]').onclick = () => { OPEN_THREAD = null; setView('more'); };
};

async function renderThread(id) {
  const t = await api(`/api/threads/${id}`);
  const bedtime = t.kind === 'bedtime';
  $('#main').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <button class="btn ghost small" id="th-back">←</button>
      <h1 style="flex:1;font-size:1.15em;margin:0">${bedtime ? '🌙 Bedtime' : '💭 ' + esc(t.title || 'Thinking')}</h1>
    </div>
    ${bedtime ? '<p class="sub" style="margin-top:10px">Everything you say is held. Nothing to decide tonight.</p>' : ''}
    <div id="th-messages" style="margin-top:14px">
      ${t.messages.map(messageBubble).join('') || `<div class="empty">${bedtime ? 'What’s rattling around? Say it and let it go.' : 'What’s on your mind?'}</div>`}
    </div>
    <div class="card" style="position:sticky;bottom:96px;margin-top:14px">
      <textarea id="th-input" placeholder="${bedtime ? 'Anything at all…' : 'Say what you’re thinking…'}" style="min-height:80px"></textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn quietbtn small" id="th-voice">🎤 Talk</button>
        <button class="btn" id="th-send" style="flex:1">Send</button>
      </div>
    </div>
    ${!bedtime && t.messages.length >= 2 ? `
      <button class="btn ghost small" id="th-harvest" style="margin-top:10px">✓ Anything here I should keep?</button>
      <p class="quiet" style="font-size:.8em;margin-top:6px">Nothing from a conversation becomes a task unless you say so.</p>` : ''}
    ${t.messages.length ? '<button class="btn danger small" id="th-del" style="margin-top:16px">Delete this conversation</button>' : ''}`;

  $('#th-back').onclick = () => { OPEN_THREAD = null; setView('think'); };
  wireVoice($('#th-voice'), $('#th-input'));
  const send = async () => {
    const text = $('#th-input').value.trim();
    if (!text) return;
    $('#th-input').value = '';
    $('#th-messages').insertAdjacentHTML('beforeend', messageBubble({ role: 'her', content: text }));
    $('#th-messages').insertAdjacentHTML('beforeend', '<div class="bubble sage pending" id="th-pending"><span class="quiet">…</span></div>');
    window.scrollTo(0, document.body.scrollHeight);
    try {
      const { reply } = await api(`/api/threads/${id}/message`, { method: 'POST', body: { text } });
      $('#th-pending').outerHTML = messageBubble({ role: 'sage', content: reply });
      window.scrollTo(0, document.body.scrollHeight);
    } catch (e) {
      $('#th-pending').outerHTML = messageBubble({ role: 'sage', content: e.message });
    }
  };
  $('#th-send').onclick = send;
  if ($('#th-harvest')) $('#th-harvest').onclick = () => harvestThread(id);
  if ($('#th-del')) $('#th-del').onclick = async () => {
    if (!confirm('Delete this conversation?')) return;
    await api(`/api/threads/${id}`, { method: 'DELETE' });
    OPEN_THREAD = null; setView('think');
  };
  if (PENDING_FIRST) { $('#th-input').value = PENDING_FIRST; PENDING_FIRST = null; send(); }
  window.scrollTo(0, document.body.scrollHeight);
}

function messageBubble(m) {
  return `<div class="bubble ${m.role === 'her' ? 'her' : 'sage'}">${esc(m.content).replace(/\n/g, '<br>')}</div>`;
}

async function harvestThread(id) {
  const m = openModal('<h2>✓ Anything to keep?</h2><div class="empty">Reading it back…</div>');
  const addClose = () => {
    const c = document.createElement('button');
    c.className = 'close'; c.textContent = '✕'; c.onclick = closeModal;
    m.prepend(c);
  };
  const r = await api(`/api/threads/${id}/harvest`, { method: 'POST' });
  if (!r.proposals.length) {
    m.innerHTML = `<h2>✓ Anything to keep?</h2>
      <div class="card">${esc(r.reply || 'Nothing in there was a commitment — just thinking. That’s allowed.')}</div>`;
    addClose();
    return;
  }
  m.innerHTML = `<h2>✓ Anything to keep?</h2>
    ${r.reply ? `<div class="card sage">${esc(r.reply)}</div>` : ''}
    <p class="sub">Only what you tick gets saved.</p>
    <div id="cap-out">${r.proposals.map(proposalCard).join('')}</div>
    <button class="btn big" id="hv-save">Keep the ticked ones</button>`;
  addClose();
  $('#hv-save', m).onclick = async () => {
    const chosen = [];
    for (const card of $$('[data-prop]', m)) {
      if (!$('input[type=checkbox]', card).checked) continue;
      const p = { ...r.proposals[+card.dataset.prop] };
      if (p.kind === 'item') {
        p.item = { ...p.item };
        for (const f of $$('[data-f]', card)) p.item[f.dataset.f] = f.value;
      } else if (p.kind === 'memory') {
        p.memory = { ...p.memory };
        for (const f of $$('[data-f]', card)) p.memory[f.dataset.f] = f.value;
      }
      chosen.push(p);
    }
    if (!chosen.length) { closeModal(); return toast('Nothing saved.'); }
    const { applied } = await api('/api/capture/apply', { method: 'POST', body: { raw: '', proposals: chosen } });
    closeModal();
    toast(applied.length === 1 ? 'Kept it.' : `Kept ${applied.length}.`);
  };
}

boot();
