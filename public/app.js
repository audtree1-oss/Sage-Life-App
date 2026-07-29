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
const today = () => new Date().toISOString().slice(0, 10);

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
  for (const b of (i.blockers || [])) out.push(`<span class="pill grey">${esc(b)}</span>`);
  return out.join('');
}

function itemRow(i, { flat = false } = {}) {
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
VIEWS.now = async function renderNow() {
  const d = await api('/api/views/now');
  const wx = d.weather ? `${d.weather.tempNow}° ${d.weather.todayRain ? '🌧️' : '☀️'}` : '';
  const undoable = (await api('/api/history')).filter((h) => h.by_ai && h.undoable).slice(0, 1)[0] || null;

  const bits = [];
  if (d.nextEvent) {
    const lead = d.nextEvent.prep_minutes ? ` · be ready by ${fmtTime(new Date(new Date(d.nextEvent.event_start).getTime() - d.nextEvent.prep_minutes * 60000).toISOString())}` : '';
    bits.push(`<div class="card sky"><b>📅 ${esc(d.nextEvent.title)}</b><div class="quiet">${fmtTime(d.nextEvent.event_start) || fmtDate(d.nextEvent.event_start || d.nextEvent.due_at)}${lead}</div></div>`);
  }
  if (d.activeTrip) bits.push(`<div class="card clay"><b>🏞️ You're at ${esc(d.activeTrip.location_key)}</b></div>`);
  else if (d.upcomingTrip) bits.push(`<div class="card clay"><b>🚗 ${esc(d.upcomingTrip.location_key)} ${fmtDate(d.upcomingTrip.start_date)}</b><div class="quiet">The departure checklist appears the day before.</div></div>`);

  $('#main').innerHTML = `
    <div class="now-head">
      <h1>${d.greeting}, ${esc(ME.name.split(' ')[0])}.</h1>
      ${wx ? `<span class="wx">${esc(d.here?.name || '')} ${wx}</span>` : ''}
    </div>
    <p class="sub">${d.immediate.length || d.routines.length ? 'Right now:' : 'Nothing is asking for you this minute.'}</p>
    ${undoable ? `<div class="strip">🌿 Sage ${esc(undoable.action)} “${esc(undoable.detail)}”<button class="btn small ghost" data-undo="${undoable.id}">Undo</button></div>` : ''}
    ${bits.join('')}
    ${d.immediate.length ? `<div id="now-items">${d.immediate.map((i) => itemRow(i)).join('')}</div>` : ''}
    <div id="now-routines">${d.routines.map((r) => routineBlock(r, { collapsed: r.steps.length > 3 })).join('')}</div>
    ${!d.immediate.length && !d.routines.length && !bits.length ? '<div class="empty">Clear. Genuinely clear.</div>' : ''}
    ${!d.weightToday ? `<div class="card"><b>Weight today?</b><div class="btn-row" style="margin-top:8px">
      <input type="text" inputmode="decimal" id="wt" placeholder="150.0" style="flex:1">
      <button class="btn small" id="wt-save">Save</button></div></div>`
      : `<div class="quiet center" style="margin-top:14px">Weight today: ${d.weightToday.value}</div>`}
    <div class="btn-row" style="margin-top:16px">
      <button class="btn ghost small" id="ask-sage" style="flex:1">💬 Ask Sage something</button>
      <button class="btn ghost small" data-goto="today" style="flex:1">All of today →</button>
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
      <button class="more-tile" data-go="coming"><span>🔭</span>Coming up</button>
      <button class="more-tile" data-go="opportunities"><span>🌱</span>Opportunities</button>
      <button class="more-tile" data-go="projects"><span>🎯</span>Projects</button>
      <button class="more-tile" data-go="lake"><span>🏞️</span>The lake</button>
      <button class="more-tile" data-go="routines"><span>📋</span>Routines</button>
      <button class="more-tile" data-go="shopping"><span>🛒</span>Shopping</button>
      <button class="more-tile" data-go="inbox"><span>📥</span>Recent captures</button>
      <button class="more-tile" data-go="settings"><span>⚙️</span>Settings</button>
    </div>`;
  $$('[data-go]').forEach((b) => b.onclick = () => setView(b.dataset.go));
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

VIEWS.inbox = async function renderInbox() {
  const d = await api('/api/views/inbox');
  $('#main').innerHTML = `
    <h1>📥 Recent captures</h1>
    <p class="sub">The safety net — everything you said, and what Sage made of it. Tap anything that landed wrong.</p>
    ${d.recent.map((i) => `
      <div class="row" data-item="${i.id}">
        <div class="body" data-open="${i.id}">
          <div class="title">${esc(i.title)}</div>
          <div class="meta">${esc(TYPES[i.type] || i.type)} · ${esc(IMPORTANCE[i.importance] || '')} · ${fmtDate(i.created_at.slice(0, 10))}${i.status === 'done' ? ' · done' : ''}</div>
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
    <h2>📅 Your phone's calendar</h2>
    <div class="card">
      <p style="margin:0 0 10px;font-size:.88em">Put Sage's dates on your real calendar, with real alerts on your phone and watch. Subscribe once; new dates flow in on their own.</p>
      <div class="btn-row"><a class="btn small" id="cal-sub" href="#">Subscribe on this phone</a>
      <button class="btn ghost small" id="cal-copy">Copy the link</button></div>
    </div>
    <h2>📍 Places</h2>
    ${locs.map((l) => `<div class="card"><b>${l.emoji} ${esc(l.name)}</b><div class="quiet">${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}${l.is_home ? ' · home' : ''}</div>
      <div class="quiet">Weather for this place comes from these coordinates.</div></div>`).join('')}
    <h2>Your data</h2>
    <div class="btn-row">
      <a class="btn ghost small" href="/api/export.json">⬇️ Export everything</a>
      <button class="btn danger small" id="sign-out">Sign out</button>
    </div>
    <h2>🧠 Thinking layer</h2>
    <div class="card" id="ai-status"><span class="quiet">${AI_ON ? 'Checking…' : 'No key set — capture still works, just more literally.'}</span></div>
    <button class="btn ghost small" data-back style="margin-top:16px">← More</button>`;
  $$('[data-text]').forEach((b) => b.onclick = () => {
    document.documentElement.dataset.text = b.dataset.text;
    try { localStorage.setItem('sage_text', b.dataset.text); } catch {}
    setView('settings');
  });
  $$('[data-theme]').forEach((b) => b.onclick = () => {
    document.documentElement.dataset.theme = b.dataset.theme;
    try { localStorage.setItem('sage_theme', b.dataset.theme); } catch {}
    setView('settings');
  });
  $('#sign-out').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  $('[data-back]').onclick = () => setView('more');
  api('/api/calendar-url').then(({ path }) => {
    $('#cal-sub').href = `webcal://${location.host}${path}`;
    $('#cal-copy').onclick = async () => {
      await navigator.clipboard.writeText(`${location.origin}${path}`);
      toast('Copied. Paste it into any calendar app.');
    };
  }).catch(() => {});
  if (AI_ON) api('/api/ai/status').then((s) => {
    const el = $('#ai-status');
    if (!el) return;
    el.innerHTML = s.working
      ? `<b>✅ Connected</b> — ${esc(s.provider)}<div class="quiet" style="margin-top:4px">
         Sage picks the model automatically: <b>${esc(s.fast)}</b> for sorting what you say,
         <b>${esc(s.smart)}</b> for thinking with you.</div>`
      : `<b>⚠️ Key is set, but the call failed</b><div class="quiet" style="margin-top:4px">Check the key in Render → Environment. Everything else still works.</div>`;
  }).catch(() => {});
};

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
    <label class="field">Say what's wrong with it</label>
    <div class="btn-row">
      <input type="text" id="it-fix" placeholder="e.g. that isn't urgent, leave it until September" style="flex:1">
      <button class="btn small" id="it-fixgo">Fix</button>
    </div>
    <label class="field">Title</label><input type="text" id="it-title" value="${esc(i.title)}">
    <label class="field">Notes</label><textarea id="it-note" style="min-height:70px">${esc(i.note)}</textarea>
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
    ${i.type === 'project' ? `<label class="field">Next action</label><input type="text" id="it-next" value="${esc(i.next_action || '')}">
      <label class="field">What done looks like</label><input type="text" id="it-outcome" value="${esc(i.outcome || '')}">` : ''}
    <div class="btn-row" style="margin-top:18px">
      <button class="btn" id="it-save" style="flex:2">Save</button>
      ${i.status !== 'done' ? '<button class="btn ghost" id="it-done">✓ Done</button>' : '<button class="btn ghost" id="it-open">Reopen</button>'}
      <button class="btn ghost" id="it-someday">Someday</button>
    </div>
    <button class="btn danger small" id="it-del" style="margin-top:10px">Delete</button>`);

  $('#it-fixgo', m).onclick = async () => {
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
    };
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
    $('#ask-out', m).innerHTML = `<div class="card" style="margin-top:14px;white-space:pre-wrap">${esc(answer)}</div>`;
  };
  $('#ask-go', m).onclick = go;
  $('#ask-q', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

boot();
