/* Admin views (identity review queue, ops health/incidents). Loaded by app.js only when the URL has ?admin=1,
 * so the public bundle carries no admin code. Uses app.js globals (state, root, $, escapeHtml, num, setStatus,
 * API_BASE_URL, render) — both are classic scripts sharing the global scope. */
// ─── Admin: identity review queue (hidden; ?admin=1) ─────────────────────────
// The internal key lives in sessionStorage only (never localStorage, never the read key) and is sent as
// X-Internal-Key exclusively to /admin/* endpoints. sw.js never caches requests carrying X-Internal-Key
// (and only caches GET /api/v1/web/*), so admin responses are never stored offline.

const ADMIN_KEY_STORAGE = 'ma_admin_internal_key';
const ADMIN_ENABLED = new URLSearchParams(location.search).get('admin') === '1';
function adminViewName(view) { return view === 'identity' || view === 'ops'; }
const adminState = { items: [], offset: 0, total: null, hasMore: false, nextOffset: null, busy: false, msg: '' };

function adminKey() { try { return sessionStorage.getItem(ADMIN_KEY_STORAGE) || ''; } catch { return ''; } }
function setAdminKey(value) { try { sessionStorage.setItem(ADMIN_KEY_STORAGE, value || ''); } catch { /* private mode */ } }
function clearAdminKey() { try { sessionStorage.removeItem(ADMIN_KEY_STORAGE); } catch { /* ignore */ } }

async function adminFetch(path, { method = 'GET', params = {}, body = null } = {}) {
  const clean = String(path).replace(/^\/+/, '');
  if (!clean.startsWith('admin/')) throw new Error('Ruta admin inválida');
  const key = adminKey();
  if (!key) throw Object.assign(new Error('Falta clave interna'), { name: 'AdminAuth' });
  const url = new URL(`${API_BASE_URL}/${clean}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const headers = { 'X-Internal-Key': key };
  if (body) headers['Content-Type'] = 'application/json';
  const { signal, cancel } = requestSignal(null, REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal, cache: 'no-store', credentials: 'omit' });
  } finally {
    cancel();
  }
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    clearAdminKey();
    throw Object.assign(new Error('Clave interna inválida'), { name: 'AdminAuth' });
  }
  if (!response.ok || json.ok === false) {
    const detail = json.detail || json.error || json.message;
    throw new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`);
  }
  return 'data' in json ? (json.data || {}) : json;
}

function renderAdminKeyPrompt(message = '') {
  root.innerHTML = `
    <form class="login-box admin-key-box" id="admin-key-form" autocomplete="off">
      <h2>Admin · acceso</h2>
      <p>Ingresa la <strong>clave interna</strong>. Se guarda solo en esta pestaña (sessionStorage) y se envía únicamente a /admin/*.</p>
      <label for="admin-key-input" class="sr-only">Clave interna</label>
      <input id="admin-key-input" type="password" placeholder="Clave interna" autocomplete="off" spellcheck="false">
      <button type="submit">Entrar</button>
      <small>${escapeHtml(message)}</small>
    </form>`;
  $('#admin-key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#admin-key-input').value.trim();
    if (!value) return;
    setAdminKey(value);
    if (state.view === 'ops') loadOpsView(); else loadIdentityQueue(0);
  });
  $('#admin-key-input').focus();
}

function adminSide(label, side) {
  const s = side || {};
  const photo = s.photo ? safeUrl(s.photo) : '#';
  const teams = Array.isArray(s.teams) ? s.teams : [];
  return `
    <div class="idq-side">
      <div class="idq-side-head">
        ${photo !== '#' ? `<img class="idq-photo" src="${escapeHtml(photo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="56" height="56">` : '<span class="idq-photo idq-photo--empty" aria-hidden="true"></span>'}
        <div>
          <div class="idq-label">${escapeHtml(label)}</div>
          <div class="idq-name">${escapeHtml(s.name || '—')}</div>
          <div class="idq-id">id ${escapeHtml(s.id || '—')}</div>
        </div>
      </div>
      <dl class="idq-dl">
        <dt>Nacimiento</dt><dd>${escapeHtml(s.dob || '—')}</dd>
        <dt>Nacionalidad</dt><dd>${escapeHtml(s.nat || '—')}</dd>
        <dt>Equipos</dt><dd>${teams.length ? teams.map((t) => escapeHtml(t)).join(', ') : '—'}</dd>
        <dt>Partidos</dt><dd>${num(s.matches)}</dd>
      </dl>
    </div>`;
}

function adminCard(item) {
  const ev = item.evidence || {};
  const lu = ev.lineup || {};
  const candidates = Array.isArray(item.candidates) ? item.candidates.map(String) : [];
  const needsChoice = item.kind !== 'MULTI_ID_SAME_SOURCE' && candidates.length > 0;
  const decision = ev.decision ? `${ev.decision} · ${num(ev.confidence).toFixed(2)}` : 'sin sugerencia';
  const choice = needsChoice ? `
      <fieldset class="idq-choice"><legend>Fusionar en</legend>
        ${candidates.map((c, i) => `<label><input type="radio" name="idq-cand-${escapeHtml(item.id)}" value="${escapeHtml(c)}" ${i === 0 ? 'checked' : ''}> ${escapeHtml(c)}</label>`).join('')}
      </fieldset>` : '';
  const etype = String(item.entity_type || '').toUpperCase();
  const sameLabel = etype === 'VENUE' ? 'Mismo estadio' : etype === 'TEAM' ? 'Mismo equipo' : 'Misma persona';
  const diffLabel = etype === 'VENUE' ? 'Distintos' : etype === 'TEAM' ? 'Distintos' : 'Distintas';
  const canSplit = etype === 'PLAYER';
  return `
    <article class="idq-card" data-id="${escapeHtml(item.id)}">
      <header class="idq-head">
        <strong>${escapeHtml(item.name || '—')}</strong>
        <span class="chip chip--muted">${escapeHtml(item.entity_type || '')} · ${escapeHtml(item.source || '')}</span>
        <span class="chip chip--muted">${escapeHtml(item.kind || '')}</span>
      </header>
      <p class="idq-suggest">Sugerencia: <strong>${escapeHtml(decision)}</strong> <span class="idq-rule">${escapeHtml(ev.rule || '')}</span></p>
      ${ev.primary || ev.extra ? `<div class="idq-sides">${adminSide('Id principal', ev.primary)}${adminSide('Id extra', ev.extra)}</div>` : ''}
      ${ev.lineup ? `<p class="idq-lineup">Partidos compartidos (mismo equipo): <strong>${num(lu.shared_matches)}</strong> · dorsal/posición coincide: ${num(lu.agree_matches)} · mismo partido, slots distintos: <strong>${num(lu.distinct_slot_matches)}</strong></p>` : ''}
      ${ev.schedule_conflict ? '<p class="idq-warn">Conflicto de calendario</p>' : ''}
      ${ev.concurrent_teams ? '<p class="idq-warn">Clubes simultáneos</p>' : ''}
      ${choice}
      <div class="idq-actions">
        <button type="button" class="idq-btn idq-btn--same" data-act="approve">${escapeHtml(sameLabel)}</button>
        <button type="button" class="idq-btn idq-btn--diff" data-act="reject"${canSplit ? '' : ' disabled title="Separar solo está disponible para jugadores; corrige estadios/equipos con SQL o merge"'}>${escapeHtml(diffLabel)}</button>
        <button type="button" class="idq-btn idq-btn--skip" data-act="skip">Saltar</button>
      </div>
    </article>`;
}

function renderIdentityQueue() {
  const items = adminState.items;
  const total = adminState.total == null ? '' : ` de ${num(adminState.total)}`;
  root.innerHTML = `
    <div class="idq-view">
      <div class="idq-toolbar">
        <h2 class="section-title">Identidad · cola de revisión</h2>
        <span class="idq-count">${num(items.length)} visibles${escapeHtml(total)} · desde ${num(adminState.offset)}</span>
        <button type="button" class="idq-btn idq-btn--skip" id="idq-reload">Recargar</button>
        ${adminState.hasMore ? '<button type="button" class="idq-btn idq-btn--skip" id="idq-next">Siguientes</button>' : ''}
        <button type="button" class="idq-btn idq-btn--skip" id="idq-logout">Olvidar clave</button>
      </div>
      ${adminState.msg ? `<p class="idq-msg" role="status">${escapeHtml(adminState.msg)}</p>` : ''}
      ${items.length ? items.map(adminCard).join('') : '<p class="empty-state">No hay ítems abiertos en esta página.</p>'}
    </div>`;
  $('#idq-reload')?.addEventListener('click', () => loadIdentityQueue(adminState.offset));
  $('#idq-next')?.addEventListener('click', () => loadIdentityQueue(adminState.nextOffset || 0));
  $('#idq-logout')?.addEventListener('click', () => { clearAdminKey(); renderAdminKeyPrompt('Clave olvidada.'); });
  root.querySelectorAll('.idq-card [data-act]').forEach((button) => {
    button.addEventListener('click', () => decideIdentityItem(button.closest('.idq-card').dataset.id, button.dataset.act));
  });
}

async function loadIdentityQueue(offset = 0) {
  if (!adminKey()) { renderAdminKeyPrompt(); return; }
  root.innerHTML = skeletonCards(4);
  try {
    const data = await adminFetch('admin/identity-queue', { params: { status: 'OPEN', limit: 25, offset: Math.max(0, num(offset)) } });
    adminState.items = Array.isArray(data.items) ? data.items : [];
    adminState.offset = num(data.offset, 0);
    adminState.total = data.total == null ? null : num(data.total);
    adminState.hasMore = Boolean(data.has_more);
    adminState.nextOffset = data.next_offset == null ? null : num(data.next_offset);
    adminState.msg = '';
    renderIdentityQueue();
  } catch (error) {
    if (error.name === 'AdminAuth') renderAdminKeyPrompt(error.message);
    else { adminState.msg = `Error: ${error.message}`; renderIdentityQueue(); }
  }
}

async function decideIdentityItem(id, act) {
  const index = adminState.items.findIndex((it) => it.id === id);
  if (index < 0) return;
  const item = adminState.items[index];
  // Optimistic: remove the card now, restore it if the call fails.
  adminState.items.splice(index, 1);
  if (act === 'skip') { adminState.items.push(item); adminState.msg = `Saltado: ${item.name || id}`; renderIdentityQueue(); return; }
  adminState.msg = `${act === 'approve' ? 'Iguales' : 'Distintos'}: ${item.name || id}…`;
  renderIdentityQueue();
  const body = { actor: 'web-admin' };
  if (act === 'approve') {
    const picked = document.querySelector(`input[name="idq-cand-${CSS.escape(id)}"]:checked`)?.value;
    const entityId = item.kind === 'MULTI_ID_SAME_SOURCE' ? item.evidence?.player_id : picked || (item.candidates || [])[0];
    if (entityId) body.entity_id = String(entityId);
  }
  try {
    const out = await adminFetch(`admin/identity-queue/${encodeURIComponent(id)}/${act === 'approve' ? 'approve' : 'reject'}`, { method: 'POST', body });
    adminState.msg = `OK ${out.action || out.status || ''}: ${item.name || id}`;
    if (adminState.total != null) adminState.total = Math.max(0, adminState.total - 1);
  } catch (error) {
    adminState.items.splice(Math.min(index, adminState.items.length), 0, item);
    adminState.msg = `No se pudo guardar (${error.message}); el ítem volvió a la lista.`;
    if (error.name === 'AdminAuth') { renderAdminKeyPrompt(error.message); return; }
  }
  if (state.view === 'identity') renderIdentityQueue();
}

function openAdminView(view) {
  closeMoreSheet();
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  document.querySelectorAll('.bottom-tab, .more-item').forEach((t) => { t.classList.remove('active'); t.removeAttribute('aria-current'); });
  hideDateFilterBar();
  window.scrollTo({ top: 0 });
  render();
}

// ─── Admin: operación (ops incidents + health; hidden; ?admin=1, same key/session rules) ─────
const opsState = { incidents: [], health: null, filter: 'OPEN', mode: 'light', msg: '', busy: false };
const OPS_SEV_CLASS = { CRITICAL: 'ops-sev--crit', WARN: 'ops-sev--warn', INFO: 'ops-sev--info' };

function opsPlain(text) {
  // check messages only use <b>; strip tags and render as escaped text
  return escapeHtml(String(text || '').replace(/<\/?b>/g, ''));
}

function opsWhen(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function opsCard(label, value, hint = '', tone = '') {
  return `<div class="ops-card ${tone}"><div class="ops-card-label">${escapeHtml(label)}</div><div class="ops-card-value">${escapeHtml(String(value))}</div>${hint ? `<div class="ops-card-hint">${escapeHtml(hint)}</div>` : ''}</div>`;
}

function opsIncidentRow(it) {
  const sev = String(it.severity || 'INFO').toUpperCase();
  const details = it.details && typeof it.details === 'object' ? it.details : {};
  const open = it.status === 'OPEN';
  return `
    <article class="ops-inc ${open ? '' : 'ops-inc--resolved'}" data-id="${escapeHtml(String(it.id))}">
      <header class="ops-inc-head">
        <span class="ops-sev ${OPS_SEV_CLASS[sev] || ''}">${escapeHtml(sev)}</span>
        <strong class="ops-inc-title">${escapeHtml(it.title || it.dedupe_key || '')}</strong>
        <span class="chip chip--muted">${escapeHtml(it.status || '')}${it.acked_at ? ' · ack' : ''}</span>
      </header>
      ${details.message ? `<p class="ops-inc-msg">${opsPlain(details.message)}</p>` : ''}
      ${details.action ? `<p class="ops-inc-action">👉 ${escapeHtml(details.action)}</p>` : ''}
      <p class="ops-inc-meta">${escapeHtml(it.check_name || '')} · visto ${escapeHtml(opsWhen(it.last_seen))} · ×${num(it.count, 1)} · desde ${escapeHtml(opsWhen(it.first_seen))}${it.resolved_at ? ` · resuelto ${escapeHtml(opsWhen(it.resolved_at))}` : ''}</p>
      ${open && !it.acked_at ? '<div class="ops-inc-actions"><button type="button" class="idq-btn idq-btn--skip" data-ack="1">Ack (silenciar)</button></div>' : ''}
    </article>`;
}

function renderOpsView() {
  const h = opsState.health || {};
  const inc = h.incidents || null;
  const counts = h.counts || {};
  const db = h.db_errors_1h || {};
  const routes = Array.isArray(h.routes) ? h.routes : [];
  const findings = Array.isArray(h.findings) ? h.findings : [];
  const cards = [
    opsCard('Incidentes abiertos', inc ? num(inc.open) : '—', inc ? `🚨 ${num(inc.open_critical)} · ⚠️ ${num(inc.open_warn)}` : 'migración 046 pendiente', inc && num(inc.open_critical) ? 'ops-card--crit' : ''),
    opsCard('Hallazgos ahora', findings.length, `🚨 ${num(counts.CRITICAL)} · ⚠️ ${num(counts.WARN)} · ℹ️ ${num(counts.INFO)} (${opsState.mode})`, num(counts.CRITICAL) ? 'ops-card--crit' : ''),
    opsCard('Notificados 24 h', inc ? num(inc.notified_24h) : '—', inc ? `resueltos ${num(inc.resolved_24h)}` : ''),
    opsCard('Errores DB 1 h', num(db.total), Object.entries(db.by_kind || {}).map(([k, v]) => `${k} ${v}`).join(' · ')),
  ].join('');
  const slow = routes.slice(0, 5).map((r) => `<li><span class="ops-route">${escapeHtml(r.route)}</span> p95 ${num(r.p95_ms)} ms · n ${num(r.count)}${num(r.errors_5xx) ? ` · 5xx ${num(r.errors_5xx)}` : ''}</li>`).join('');
  const checkErrors = Object.keys(h.check_errors || {});
  const now = findings.slice(0, 12).map((f) => `<li><span class="ops-sev ${OPS_SEV_CLASS[f.severity] || ''}">${escapeHtml(f.severity)}</span> ${escapeHtml(f.title)}</li>`).join('');
  root.innerHTML = `
    <div class="idq-view ops-view">
      <div class="idq-toolbar">
        <h2 class="section-title">Operación</h2>
        <button type="button" class="idq-btn idq-btn--skip" id="ops-reload">Recargar</button>
        <button type="button" class="idq-btn idq-btn--skip" id="ops-full">${opsState.mode === 'full' ? 'Chequeo liviano' : 'Chequeo completo'}</button>
        <button type="button" class="idq-btn idq-btn--skip" id="ops-filter">${opsState.filter === 'OPEN' ? 'Ver todos' : 'Solo abiertos'}</button>
        <button type="button" class="idq-btn idq-btn--skip" id="ops-identity">Identidad</button>
      </div>
      ${opsState.msg ? `<p class="idq-msg" role="status">${escapeHtml(opsState.msg)}</p>` : ''}
      <div class="ops-cards">${cards}</div>
      ${checkErrors.length ? `<p class="idq-warn">Checks con error: ${escapeHtml(checkErrors.join(', '))}</p>` : ''}
      ${now ? `<section class="ops-section"><h3>Hallazgos del chequeo (sin enviar)</h3><ul class="ops-list">${now}</ul></section>` : ''}
      ${slow ? `<section class="ops-section"><h3>Rutas más lentas (1 h, este worker)</h3><ul class="ops-list">${slow}</ul></section>` : ''}
      <section class="ops-section"><h3>Incidentes ${opsState.filter === 'OPEN' ? 'abiertos' : '(todos)'}</h3>
        ${opsState.incidents.length ? opsState.incidents.map(opsIncidentRow).join('') : '<p class="empty-state">Sin incidentes.</p>'}
      </section>
    </div>`;
  $('#ops-reload')?.addEventListener('click', () => loadOpsView());
  $('#ops-full')?.addEventListener('click', () => { opsState.mode = opsState.mode === 'full' ? 'light' : 'full'; loadOpsView(); });
  $('#ops-filter')?.addEventListener('click', () => { opsState.filter = opsState.filter === 'OPEN' ? '' : 'OPEN'; loadOpsView(); });
  $('#ops-identity')?.addEventListener('click', () => openAdminView('identity'));
  root.querySelectorAll('.ops-inc [data-ack]').forEach((button) => {
    button.addEventListener('click', () => ackOpsIncident(button.closest('.ops-inc').dataset.id));
  });
}

async function loadOpsView() {
  if (!adminKey()) { renderAdminKeyPrompt(); return; }
  root.innerHTML = skeletonCards(4);
  opsState.msg = '';
  const [health, incidents] = await Promise.allSettled([
    adminFetch('admin/ops/health', { params: { mode: opsState.mode } }),
    adminFetch('admin/ops/incidents', { params: { status: opsState.filter, limit: 50 } }),
  ]);
  const authError = [health, incidents].find((r) => r.status === 'rejected' && r.reason?.name === 'AdminAuth');
  if (authError) { renderAdminKeyPrompt(authError.reason.message); return; }
  opsState.health = health.status === 'fulfilled' ? health.value : null;
  opsState.incidents = incidents.status === 'fulfilled' && Array.isArray(incidents.value.items) ? incidents.value.items : [];
  const errors = [health, incidents].filter((r) => r.status === 'rejected').map((r) => r.reason?.message || 'error');
  if (errors.length) opsState.msg = `Error: ${errors.join(' · ')}`;
  if (state.view === 'ops') renderOpsView();
}

async function ackOpsIncident(id) {
  if (opsState.busy) return;
  opsState.busy = true;
  try {
    await adminFetch(`admin/ops/incidents/${encodeURIComponent(id)}/ack`, { method: 'POST', body: { by: 'web-admin' } });
    const it = opsState.incidents.find((x) => String(x.id) === String(id));
    if (it) it.acked_at = new Date().toISOString();
    opsState.msg = 'Incidente silenciado (ack). Se resolverá solo cuando el check pase.';
  } catch (error) {
    if (error.name === 'AdminAuth') { opsState.busy = false; renderAdminKeyPrompt(error.message); return; }
    opsState.msg = `No se pudo hacer ack (${error.message}).`;
  }
  opsState.busy = false;
  if (state.view === 'ops') renderOpsView();
}

(function mountAdminEntry() {
  if (!ADMIN_ENABLED) return;
  const refresh = document.getElementById('refresh-btn');
  if (!refresh) return;
  [['admin-identity-entry', 'Identidad', 'identity'], ['admin-ops-entry', 'Operación', 'ops']].forEach(([id, label, view]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn admin-entry';
    button.id = id;
    button.textContent = label;
    button.addEventListener('click', () => openAdminView(view));
    refresh.before(button);
  });
  // Deep link from Telegram alerts: ?admin=1&view=ops
  if (new URLSearchParams(location.search).get('view') === 'ops') state.view = 'ops';
})();

window.MA_ADMIN = {
  isAdminView: adminViewName,
  async render(view, options = {}) {
    if (view === 'identity') {
      setStatus('Admin · identidad');
      if (options.silent) return;
      await loadIdentityQueue(adminState.offset || 0);
    } else if (view === 'ops') {
      setStatus('Admin · operación');
      if (options.silent) return;
      await loadOpsView();
    }
  },
};
