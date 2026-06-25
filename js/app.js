const CFG = window.MATCH_ALPHA_CONFIG || {};
const API_BASE_URL = String(CFG.API_BASE_URL || '').replace(/\/+$/, '');
const SEASON = CFG.DEFAULT_SEASON || 'wc2026';
const KEY_STORAGE = CFG.KEY_STORAGE || 'match_alpha_web_key';
const AUTO_REFRESH_MS = Number(CFG.AUTO_REFRESH_MS || 30000);

const state = {
  view: 'today',
  dateMode: 'today',
  cache: new Map(),
  refreshTimer: null,
  lastUpdatedAt: null,
};

const $ = (selector) => document.querySelector(selector);
const root = $('#view-root');
const statusStrip = $('#status-strip');

function savedKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
function saveKey(value) { localStorage.setItem(KEY_STORAGE, value || ''); }
function clearKey() { localStorage.removeItem(KEY_STORAGE); }

function ymd(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(date);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: 'America/Santiago' }).format(date).replace('.', '');
}

function timeLabel(value, timeZone = 'America/Santiago') {
  if (!value) return '';
  return new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(value));
}

function chileDateTimeLabel(value) {
  if (!value) return '';
  return `${dateLabel(value)} · ${timeLabel(value)} Chile`;
}

function localVenueTimeLabel(match) {
  const zone = match.venue?.timezone_name;
  if (!zone || zone === 'America/Santiago') return '';
  return `${timeLabel(match.kickoff_at, zone)} local`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function apiGet(path, params = {}) {
  if (!API_BASE_URL || API_BASE_URL.includes('tu-worker')) throw new Error('Configura API_BASE_URL en js/config.js');
  const url = new URL(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`);
  url.searchParams.set('season', SEASON);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const key = savedKey();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const response = await fetch(url, { headers });
  const json = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearKey();
    renderLogin('Clave inválida o no configurada.');
    throw new Error('Unauthorized');
  }
  if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`);
  return json.data;
}

async function cached(path, params = {}, ttlMs = 120000) {
  const key = `${path}:${JSON.stringify(params)}`;
  const hit = state.cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const data = await apiGet(path, params);
  state.cache.set(key, { ts: Date.now(), data });
  state.lastUpdatedAt = new Date();
  return data;
}

function invalidateViewCache(pathPrefix) {
  for (const key of state.cache.keys()) {
    if (key.startsWith(`${pathPrefix}:`)) state.cache.delete(key);
  }
}


function renderLogin(message = '') {
  const template = $('#login-template');
  root.innerHTML = '';
  root.append(template.content.cloneNode(true));
  $('#login-error').textContent = message;
  $('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveKey($('#api-key-input').value.trim());
    state.cache.clear();
    render();
  });
}

function setStatus(text, strong = '') {
  const updated = state.lastUpdatedAt ? ` · actualizado ${timeLabel(state.lastUpdatedAt.toISOString())}` : '';
  statusStrip.innerHTML = strong ? `<span>${escapeHtml(text)}${updated}</span><strong>${escapeHtml(strong)}</strong>` : `<span>${escapeHtml(text)}${updated}</span>`;
}

function loading() { root.innerHTML = '<div class="loading">Cargando datos...</div>'; }
function errorState(error) { root.innerHTML = `<div class="error">${escapeHtml(error.message || error)}</div>`; }
function emptyState(text) { return `<div class="empty">${escapeHtml(text)}</div>`; }

function matchScore(match) {
  const homeScore = match.home_score ?? match.home?.score;
  const awayScore = match.away_score ?? match.away?.score;
  if (homeScore === null || homeScore === undefined || awayScore === null || awayScore === undefined) return '<div class="score pending">vs</div>';
  return `<div class="score">${homeScore} - ${awayScore}</div>`;
}

function statusClass(status) {
  const value = String(status || '').toUpperCase();
  if (['LIVE', 'IN_PLAY', 'PAUSED'].includes(value)) return 'live';
  if (['FINISHED', 'FT', 'AET', 'PEN'].includes(value)) return 'finished';
  return '';
}

function weatherHtml(match) {
  const weather = match.weather || match.metadata?.weather || null;
  if (!weather) return '';
  const parts = [];
  const temp = weather.temperature_c ?? weather.temperature ?? weather.temp;
  const humidity = weather.humidity_pct ?? weather.humidity;
  const wind = weather.wind_kph ?? weather.wind_speed;
  if (temp !== null && temp !== undefined) parts.push(`${Number(temp).toFixed(1)}°C`);
  if (humidity !== null && humidity !== undefined) parts.push(`hum ${Number(humidity).toFixed(0)}%`);
  if (wind !== null && wind !== undefined) parts.push(`viento ${Number(wind).toFixed(0)} km/h`);
  if (weather.condition) parts.unshift(String(weather.condition));
  return parts.length ? `<div class="weather">☀ ${escapeHtml(parts.join(' · '))}</div>` : '';
}

function venueDetailHtml(match) {
  if (!match.venue) return '<div class="venue">Sede por definir</div>';
  const main = [match.venue.display_name, match.venue.city].filter(Boolean).join(', ');
  const local = localVenueTimeLabel(match);
  const coords = match.venue.latitude && match.venue.longitude
    ? `${Number(match.venue.latitude).toFixed(3)}, ${Number(match.venue.longitude).toFixed(3)}`
    : '';
  return `<div class="venue">${escapeHtml(main)}${local ? ` · ${escapeHtml(local)}` : ''}${coords ? `<span class="coords">${escapeHtml(coords)}</span>` : ''}</div>`;
}

function matchCard(match) {
  const home = match.home || { display_name: 'Por definir', flag_emoji: '🏳️' };
  const away = match.away || { display_name: 'Por definir', flag_emoji: '🏳️' };
  const meta = [match.group_name || match.stage_name, `#${match.match_number || '-'}`].filter(Boolean).join(' · ');
  return `
    <article class="card match-card">
      <div class="match-meta">
        <span>${escapeHtml(meta)}</span>
        <span class="${statusClass(match.status)}">${escapeHtml(match.status || 'SCHEDULED')} · ${chileDateTimeLabel(match.kickoff_at)}</span>
      </div>
      <div class="teams-row">
        <div class="team-side"><div class="flag">${home.flag_emoji || '🏳️'}</div><div class="name">${escapeHtml(home.display_name)}</div></div>
        ${matchScore(match)}
        <div class="team-side"><div class="flag">${away.flag_emoji || '🏳️'}</div><div class="name">${escapeHtml(away.display_name)}</div></div>
      </div>
      ${venueDetailHtml(match)}
      ${weatherHtml(match)}
    </article>`;
}

function todayParams() {
  const now = new Date();
  if (state.dateMode === 'yesterday') {
    const d = ymd(addDays(now, -1));
    return { date_from: d, date_to: d };
  }
  if (state.dateMode === 'tomorrow') {
    const d = ymd(addDays(now, 1));
    return { date_from: d, date_to: d };
  }
  if (state.dateMode === 'upcoming') return { date_from: ymd(addDays(now, 1)), date_to: '2026-07-19' };
  const d = ymd(now);
  return { date_from: d, date_to: d };
}

async function renderToday(options = {}) {
  if (!options.silent) loading();
  const data = await cached('web/matches', todayParams(), 30000);
  setStatus('Partidos', `${data.matches.length} registros`);
  const buttons = [
    ['yesterday', 'Ayer'], ['today', 'Hoy'], ['tomorrow', 'Mañana'], ['upcoming', 'Próximos']
  ].map(([mode, label]) => `<button class="${state.dateMode === mode ? 'active' : ''}" data-date-mode="${mode}">${label}</button>`).join('');
  const grouped = data.matches.reduce((acc, match) => {
    const key = dateLabel(match.kickoff_at);
    (acc[key] ||= []).push(match);
    return acc;
  }, {});
  const content = Object.keys(grouped).map((label) => `
    <section>
      <h2 class="section-title">${escapeHtml(label)}</h2>
      <div class="grid">${grouped[label].map(matchCard).join('')}</div>
    </section>`).join('') || emptyState('No hay partidos para este rango.');
  root.innerHTML = `<div class="toolbar"><div class="segment">${buttons}</div></div>${content}`;
  root.querySelectorAll('[data-date-mode]').forEach((button) => {
    button.addEventListener('click', () => { state.dateMode = button.dataset.dateMode; renderToday(); });
  });
}

async function renderStandings(options = {}) {
  if (!options.silent) loading();
  const data = await cached('web/standings', {}, 90000);
  setStatus('Tabla de posiciones', `${data.groups.length} grupos`);
  root.innerHTML = data.groups.map((group) => `
    <section class="group-block">
      <h2 class="group-heading">${escapeHtml(group.group_name)}</h2>
      <div class="card table-card">
        <table>
          <thead><tr><th>#</th><th>Equipo</th><th>Pts</th><th>J</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DG</th></tr></thead>
          <tbody>${group.standings.map((row, index) => `
            <tr>
              <td>${row.position || index + 1}</td>
              <td>${row.flag_emoji || '🏳️'} ${escapeHtml(row.team_name)}</td>
              <td><strong>${row.points}</strong></td><td>${row.played}</td><td>${row.wins}</td><td>${row.draws}</td><td>${row.losses}</td><td>${row.goals_for}</td><td>${row.goals_against}</td><td>${row.goal_difference}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </section>`).join('') || emptyState('No hay posiciones disponibles.');
}

async function renderTeams(options = {}) {
  if (!options.silent) loading();
  const data = await cached('web/teams', {}, 90000);
  setStatus('Equipos', `${data.teams.length} selecciones`);
  const byGroup = data.teams.reduce((acc, team) => {
    const key = team.group_name || 'Sin grupo';
    (acc[key] ||= []).push(team);
    return acc;
  }, {});
  root.innerHTML = Object.keys(byGroup).map((groupName) => `
    <section>
      <h2 class="section-title">${escapeHtml(groupName)}</h2>
      <div class="grid">${byGroup[groupName].map((team) => `
        <article class="card team-card">
          <div class="team-head"><div class="flag">${team.flag_emoji || '🏳️'}</div><div><h3>${escapeHtml(team.display_name)}</h3><p>${escapeHtml(team.country_code || '')} · Plantel ${team.roster_count}</p></div></div>
          <div class="stats-line">
            <div class="stat"><b>${team.points}</b><span>Pts</span></div>
            <div class="stat"><b>${team.played}</b><span>J</span></div>
            <div class="stat"><b>${team.goal_difference}</b><span>DG</span></div>
            <div class="stat"><b>${team.seed_rating ?? '-'}</b><span>Rating</span></div>
          </div>
        </article>`).join('')}</div>
    </section>`).join('') || emptyState('No hay equipos disponibles.');
}

async function renderKnockout(options = {}) {
  if (!options.silent) loading();
  const data = await cached('web/knockout', {}, 90000);
  setStatus('Eliminatorias', `${data.matches.length} partidos`);
  const byStage = data.matches.reduce((acc, match) => {
    const key = match.stage_name || match.stage_code || 'Eliminatoria';
    (acc[key] ||= []).push(match);
    return acc;
  }, {});
  root.innerHTML = Object.keys(byStage).map((stageName) => `
    <section class="knockout-stage">
      <h2 class="knockout-title">${escapeHtml(stageName)}</h2>
      <div class="grid">${byStage[stageName].map(matchCard).join('')}</div>
    </section>`).join('') || emptyState('El cuadro eliminatorio aun no tiene partidos publicados.');
}

async function render(options = {}) {
  try {
    if (!savedKey()) return renderLogin();
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
    if (state.view === 'standings') return await renderStandings(options);
    if (state.view === 'teams') return await renderTeams(options);
    if (state.view === 'knockout') return await renderKnockout(options);
    return await renderToday(options);
  } catch (error) {
    if (String(error.message) !== 'Unauthorized') errorState(error);
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    render();
  });
});

$('#refresh-btn').addEventListener('click', () => {
  state.cache.clear();
  render();
});

function refreshSilently() {
  if (!savedKey() || document.hidden) return;
  const path = state.view === 'standings' ? 'web/standings' : state.view === 'teams' ? 'web/teams' : state.view === 'knockout' ? 'web/knockout' : 'web/matches';
  invalidateViewCache(path);
  render({ silent: true });
}

if (AUTO_REFRESH_MS > 0) {
  state.refreshTimer = window.setInterval(refreshSilently, AUTO_REFRESH_MS);
}

render();
