const CFG = window.MATCH_ALPHA_CONFIG || {};
const API_BASE_URL = String(CFG.API_BASE_URL || '').replace(/\/+$/, '');
const SEASON = CFG.DEFAULT_SEASON || 'wc2026';
const KEY_STORAGE = CFG.KEY_STORAGE || 'match_alpha_web_key';
const AUTO_REFRESH_MS = Number(CFG.AUTO_REFRESH_MS || 30000);
const CHILE_TIMEZONE = 'America/Santiago';

const state = {
  view: 'today',
  dateMode: 'today',
  cache: new Map(),
  refreshTimer: null,
  lastUpdatedAt: null,
  renderSeq: 0,
  activeController: null,
  knockoutStage: 'ROUND_OF_32',
};

const dateModes = [
  ['yesterday', 'Ayer', '←'],
  ['today', 'Hoy', '●'],
  ['tomorrow', 'Mañana', '→'],
  ['upcoming', 'Próximos', '⌁'],
];

const knockoutStages = [
  { key: 'ROUND_OF_32', title: 'Dieciseisavos', count: 16 },
  { key: 'ROUND_OF_16', title: 'Octavos', count: 8 },
  { key: 'QUARTER_FINAL', title: 'Cuartos', count: 4 },
  { key: 'SEMI_FINAL', title: 'Semifinales', count: 2 },
  { key: 'THIRD_PLACE', title: 'Tercer puesto', count: 1 },
  { key: 'FINAL', title: 'Final', count: 1 },
];

const roundOf32Slots = [
  ['Grupo A · 2°', 'Grupo B · 2°'],
  ['Grupo C · 1°', 'Grupo F · 2°'],
  ['Grupo E · 1°', 'Mejor 3° · A/B/C/D/F'],
  ['Grupo F · 1°', 'Grupo C · 2°'],
  ['Grupo I · 1°', 'Mejor 3° · C/D/F/G/H'],
  ['Grupo E · 2°', 'Grupo I · 2°'],
  ['Grupo A · 1°', 'Mejor 3° · C/E/F/H/I'],
  ['Grupo L · 1°', 'Mejor 3° · E/H/I/J/K'],
  ['Grupo D · 1°', 'Mejor 3° · B/E/F/I/J'],
  ['Grupo G · 1°', 'Grupo K · 2°'],
  ['Grupo J · 1°', 'Grupo H · 2°'],
  ['Grupo B · 1°', 'Mejor 3° · E/F/G/I/J'],
  ['Grupo H · 1°', 'Grupo J · 2°'],
  ['Grupo K · 1°', 'Grupo L · 2°'],
  ['Grupo D · 2°', 'Grupo G · 2°'],
  ['Grupo C · 2°', 'Grupo A · 2°'],
];

const $ = (selector) => document.querySelector(selector);
const root = $('#view-root');
const statusStrip = $('#status-strip');
const statusText = $('#status-text');

function savedKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
function saveKey(value) { localStorage.setItem(KEY_STORAGE, value || ''); }
function clearKey() { localStorage.removeItem(KEY_STORAGE); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function ymd(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: CHILE_TIMEZONE }).format(date);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateLabel(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: CHILE_TIMEZONE })
    .format(new Date(value))
    .replace('.', '')
    .replace(/\s+/g, '-')
    .toUpperCase();
}

function timeLabel(value, timeZone = CHILE_TIMEZONE) {
  if (!value) return '';
  return new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(value));
}

function chileDateTimeLabel(value) {
  if (!value) return '';
  return `${dateLabel(value).toLowerCase()} · ${timeLabel(value)} Chile`;
}

function chileParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHILE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function chileDateToUtcIso(ymdValue, hour = 0, minute = 0) {
  const [year, month, day] = String(ymdValue).split('-').map(Number);
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i += 1) {
    const parts = chileParts(guess);
    const diffMinutes =
      (Date.UTC(year, month - 1, day, hour, minute, 0) -
       Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)) / 60000;
    guess = new Date(guess.getTime() + diffMinutes * 60000);
  }
  return guess.toISOString();
}

function chileOperationalRange(baseDate, offsetDays = 0) {
  const startYmd = ymd(addDays(baseDate, offsetDays));
  const nextYmd = ymd(addDays(baseDate, offsetDays + 1));
  return {
    kickoff_from: chileDateToUtcIso(startYmd, 0, 0),
    kickoff_to: chileDateToUtcIso(nextYmd, 1, 0),
    label: startYmd
  };
}

function localVenueTimeLabel(match) {
  const zone = match.venue?.timezone_name;
  if (!zone || zone === CHILE_TIMEZONE) return '';
  return `${timeLabel(match.kickoff_at, zone)} local`;
}

function teamShortName(team) {
  const name = team?.display_name || 'Por definir';
  if (name.length <= 18) return name;
  return `${name.slice(0, 16).trim()}…`;
}

function groupLabel(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const normalized = raw.replace(/^GROUP[_\s-]?/i, '').replace(/^GRUPO\s*/i, '');
  if (/^[A-Z]$/i.test(normalized)) return `Grupo ${normalized.toUpperCase()}`;
  if (/^Grupo\s/i.test(raw)) return raw;
  return raw.replace(/_/g, ' ');
}

function stageLabel(value) {
  const raw = String(value || '').replace(/_/g, ' ').toLowerCase();
  if (!raw) return 'Fase de grupos';
  if (raw.includes('group')) return 'Fase de grupos';
  if (raw.includes('round of 32')) return 'Dieciseisavos';
  if (raw.includes('round of 16')) return 'Octavos';
  if (raw.includes('quarter')) return 'Cuartos';
  if (raw.includes('semi')) return 'Semifinal';
  if (raw.includes('third')) return 'Tercer puesto';
  if (raw.includes('final')) return 'Final';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function matchStageLabel(match) {
  return match?.stage_label || stageLabel(match?.stage_name || match?.stage_code);
}

function matchGroupLabel(match) {
  return match?.group_label || groupLabel(match?.group_name || match?.group_code);
}

function knockoutStageKey(match) {
  if (knockoutStages.some((stage) => stage.key === match.stage_code)) return match.stage_code;
  const raw = `${match.stage_code || ''} ${match.stage_name || ''} ${match.stage_label || ''}`.toUpperCase();
  if (raw.includes('32') || raw.includes('DIECISEIS')) return 'ROUND_OF_32';
  if (raw.includes('16') || raw.includes('OCTAV')) return 'ROUND_OF_16';
  if (raw.includes('QUARTER') || raw.includes('CUART')) return 'QUARTER_FINAL';
  if (raw.includes('SEMI')) return 'SEMI_FINAL';
  if (raw.includes('THIRD') || raw.includes('TERCER')) return 'THIRD_PLACE';
  if (raw.includes('FINAL')) return 'FINAL';
  return match.stage_code || match.stage_name || 'KNOCKOUT';
}

function teamFlag(team) {
  if (team?.flag_asset) return `<img class="flag-img" src="${escapeHtml(team.flag_asset)}" alt="" loading="lazy">`;
  if (team?.flag_emoji) return escapeHtml(team.flag_emoji);
  return team?.is_placeholder ? '<span class="placeholder-icon">◇</span>' : '🏳️';
}

async function apiGet(path, params = {}, options = {}) {
  if (!API_BASE_URL || API_BASE_URL.includes('tu-worker')) throw new Error('Configura API_BASE_URL en js/config.js');
  const url = new URL(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`);
  url.searchParams.set('season', SEASON);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const key = savedKey();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const response = await fetch(url, { headers, signal: options.signal });
  const json = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearKey();
    renderLogin('Clave inválida o no configurada.');
    throw new Error('Unauthorized');
  }
  if (!response.ok || json.ok === false) {
    const detail = json.detail || json.error || json.message;
    const message = typeof detail === 'string' ? detail : detail?.message || JSON.stringify(detail || {});
    throw new Error(message || `HTTP ${response.status}`);
  }
  if (!json || typeof json !== 'object') throw new Error('Respuesta API inválida.');
  return 'data' in json ? (json.data || {}) : json;
}

async function cached(path, params = {}, ttlMs = 120000, options = {}) {
  const key = `${path}:${JSON.stringify(params)}`;
  const hit = state.cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const data = await apiGet(path, params, options);
  state.cache.set(key, { ts: Date.now(), data });
  state.lastUpdatedAt = new Date();
  return data;
}

function invalidateViewCache(pathPrefix) {
  for (const key of state.cache.keys()) {
    if (key.startsWith(`${pathPrefix}:`)) state.cache.delete(key);
  }
}

function setStatus(text, strong = '') {
  const updated = state.lastUpdatedAt ? ` · actualizado ${timeLabel(state.lastUpdatedAt.toISOString())}` : '';
  statusText.innerHTML = strong
    ? `<span>${escapeHtml(text)}${updated}</span><strong>${escapeHtml(strong)}</strong>`
    : `<span>${escapeHtml(text)}${updated}</span>`;
}

function updateTabs() {
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
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

function skeletonCards(count = 6) {
  return `<div class="grid skeleton-grid" aria-hidden="true">${Array.from({ length: count }).map(() => `
    <article class="card match-card skeleton-card">
      <div class="skeleton-line short"></div>
      <div class="teams-row">
        <div class="team-side"><div class="skeleton-flag"></div><div class="skeleton-line"></div></div>
        <div class="skeleton-score"></div>
        <div class="team-side"><div class="skeleton-flag"></div><div class="skeleton-line"></div></div>
      </div>
      <div class="skeleton-line wide"></div>
      <div class="skeleton-line wide"></div>
    </article>`).join('')}</div>`;
}

function loading(label = 'Cargando') {
  root.innerHTML = `
    <div class="loading-head">
      <span>${escapeHtml(label)}</span>
      <i></i>
    </div>
    ${skeletonCards(state.view === 'knockout' ? 8 : 6)}`;
}

function errorState(error) {
  root.innerHTML = `<div class="error">${escapeHtml(error.message || error)}</div>`;
}

function emptyState(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function matchScore(match) {
  const homeScore = match.home_score ?? match.home?.score;
  const awayScore = match.away_score ?? match.away?.score;
  if (homeScore === null || homeScore === undefined || awayScore === null || awayScore === undefined) return '<div class="score pending">vs</div>';
  return `<div class="score">${homeScore}<span>-</span>${awayScore}</div>`;
}

function statusClass(status) {
  const value = String(status || '').toUpperCase();
  if (['LIVE', 'IN_PLAY', 'PAUSED', 'HT'].includes(value)) return 'live';
  if (['FINISHED', 'FT', 'AET', 'PEN'].includes(value)) return 'finished';
  return '';
}

function statusLabel(status) {
  const value = String(status || '').toUpperCase();
  if (['FINISHED', 'FT'].includes(value)) return 'FINISHED';
  if (['LIVE', 'IN_PLAY', 'HT'].includes(value)) return 'EN VIVO';
  return value || 'SCHEDULED';
}

function weatherIcon(condition) {
  const value = String(condition || '').toLowerCase();
  if (value.includes('rain')) return '☔';
  if (value.includes('cloud')) return '☁';
  if (value.includes('storm')) return '⚡';
  return '☀';
}

function weatherHtml(match) {
  const weather = match.weather || match.metadata?.weather || null;
  if (!weather) return '';
  const parts = [];
  const temp = weather.temperature_c ?? weather.temperature ?? weather.temp;
  const humidity = weather.humidity_pct ?? weather.humidity;
  const wind = weather.wind_kph ?? weather.wind_speed;
  if (temp !== null && temp !== undefined) parts.push(`${Number(temp).toFixed(1)}°C`);
  if (humidity !== null && humidity !== undefined) parts.push(`${Number(humidity).toFixed(0)}% hum`);
  if (wind !== null && wind !== undefined) parts.push(`${Number(wind).toFixed(0)} km/h`);
  return parts.length ? `<div class="weather"><span>${weatherIcon(weather.condition)}</span>${escapeHtml(parts.join(' · '))}</div>` : '';
}

function venueDetailHtml(match) {
  if (!match.venue) return '<div class="venue">Sede por definir</div>';
  const main = [match.venue.display_name, match.venue.city].filter(Boolean).join(', ');
  const local = localVenueTimeLabel(match);
  return `<div class="venue">📍 ${escapeHtml(main)}${local ? ` · ${escapeHtml(local)}` : ''}</div>`;
}

function matchCard(match) {
  const home = match.home || { display_name: 'Por definir', flag_emoji: '🏳️' };
  const away = match.away || { display_name: 'Por definir', flag_emoji: '🏳️' };
  const group = matchGroupLabel(match);
  const stage = matchStageLabel(match);
  const meta = [stage, group].filter(Boolean).join(' · ');
  return `
    <article class="card match-card fade-in">
      <div class="match-meta">
        <span class="stage-chip">${escapeHtml(meta || 'Partido')}</span>
        <span class="match-time ${statusClass(match.status)}">${escapeHtml(statusLabel(match.status))} · ${escapeHtml(chileDateTimeLabel(match.kickoff_at))}</span>
      </div>
      <div class="teams-row">
        <div class="team-side"><div class="flag">${teamFlag(home)}</div><div class="name" title="${escapeHtml(home.display_name)}">${escapeHtml(teamShortName(home))}</div></div>
        ${matchScore(match)}
        <div class="team-side"><div class="flag">${teamFlag(away)}</div><div class="name" title="${escapeHtml(away.display_name)}">${escapeHtml(teamShortName(away))}</div></div>
      </div>
      ${venueDetailHtml(match)}
      ${weatherHtml(match)}
    </article>`;
}

function todayParams() {
  const now = new Date();
  if (state.dateMode === 'yesterday') {
    const range = chileOperationalRange(now, -1);
    return { kickoff_from: range.kickoff_from, kickoff_to: range.kickoff_to };
  }
  if (state.dateMode === 'tomorrow') {
    const range = chileOperationalRange(now, 1);
    return { kickoff_from: range.kickoff_from, kickoff_to: range.kickoff_to };
  }
  if (state.dateMode === 'upcoming') {
    const range = chileOperationalRange(now, 1);
    return { kickoff_from: range.kickoff_from, kickoff_to: '2026-07-20T05:00:00.000Z' };
  }
  const range = chileOperationalRange(now, 0);
  return { kickoff_from: range.kickoff_from, kickoff_to: range.kickoff_to };
}

function matchesOverviewParams() {
  const now = new Date();
  const yesterday = chileOperationalRange(now, -1);
  const today = chileOperationalRange(now, 0);
  const tomorrow = chileOperationalRange(now, 1);
  return {
    yesterday_from: yesterday.kickoff_from,
    yesterday_to: yesterday.kickoff_to,
    today_from: today.kickoff_from,
    today_to: today.kickoff_to,
    tomorrow_from: tomorrow.kickoff_from,
    tomorrow_to: tomorrow.kickoff_to,
    upcoming_from: tomorrow.kickoff_from,
    upcoming_to: '2026-07-20T05:00:00.000Z',
    weather_refresh_limit: '8'
  };
}

async function getMatchesOverview(options = {}) {
  return cached('web/matches-overview', matchesOverviewParams(), 30000, options);
}

function renderDateToolbar() {
  return `
    <div class="toolbar">
      <div class="segment" role="tablist" aria-label="Fechas">
        ${dateModes.map(([mode, label, icon]) => `
          <button class="${state.dateMode === mode ? 'active' : ''}" data-date-mode="${mode}" type="button">
            <span>${escapeHtml(icon)}</span>${escapeHtml(label)}
          </button>`).join('')}
      </div>
    </div>`;
}

function adjacentDateMode(direction) {
  const modes = dateModes.map(([mode]) => mode);
  const current = modes.indexOf(state.dateMode);
  if (current < 0) return null;
  const next = current + direction;
  return modes[next] || null;
}

function attachDaySwipe(container) {
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  container.addEventListener('touchstart', (event) => {
    if (event.target.closest('.segment, button, a, .modal-overlay')) return;
    const touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startedAt = Date.now();
  }, { passive: true });
  container.addEventListener('touchend', (event) => {
    if (!startedAt) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const elapsed = Date.now() - startedAt;
    startedAt = 0;
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35 || elapsed > 650) return;
    const nextMode = adjacentDateMode(deltaX < 0 ? 1 : -1);
    if (!nextMode) return;
    state.dateMode = nextMode;
    container.classList.add(deltaX < 0 ? 'swipe-left' : 'swipe-right');
    renderToday({ localOnly: true });
  }, { passive: true });
}

async function renderToday(options = {}) {
  const cacheKey = `web/matches-overview:${JSON.stringify(matchesOverviewParams())}`;
  const cachedOverview = state.cache.get(cacheKey);
  if (!options.silent && !options.localOnly && !cachedOverview) loading('Partidos');
  const data = cachedOverview && options.localOnly ? cachedOverview.data : await getMatchesOverview(options);
  const matches = data[state.dateMode] || [];
  setStatus('Partidos', `${matches.length} registros`);
  const grouped = matches.reduce((acc, match) => {
    const key = dateLabel(match.kickoff_at);
    (acc[key] ||= []).push(match);
    return acc;
  }, {});
  const content = Object.keys(grouped).map((label) => `
    <section class="view-section">
      <h2 class="section-title">${escapeHtml(state.dateMode === 'today' ? `Próximos hoy · ${label}` : label)}</h2>
      <div class="grid">${grouped[label].map(matchCard).join('')}</div>
    </section>`).join('') || emptyState('No hay partidos para este rango.');
  root.innerHTML = `<div class="today-view">${renderDateToolbar()}<div class="day-content fade-in">${content}</div></div>`;
  root.querySelectorAll('[data-date-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.dateMode === button.dataset.dateMode) return;
      state.dateMode = button.dataset.dateMode;
      renderToday({ localOnly: true });
    });
  });
  const todayView = root.querySelector('.today-view');
  if (todayView) attachDaySwipe(todayView);
}

async function renderStandings(options = {}) {
  if (!options.silent) loading('Posiciones');
  const data = await cached('web/standings', {}, 90000, options);
  const groups = data.groups || [];
  setStatus('Tabla de posiciones', `${groups.length} grupos`);
  root.innerHTML = groups.map((group) => `
    <section class="group-block fade-in">
      <h2 class="section-title">${escapeHtml(groupLabel(group.group_name))}</h2>
      <div class="card table-card">
        <table>
          <thead><tr><th>#</th><th>Equipo</th><th>Pts</th><th>J</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DG</th></tr></thead>
          <tbody>${(group.standings || []).map((row, index) => `
            <tr>
              <td>${row.position || index + 1}</td>
              <td><strong>${teamFlag(row)} ${escapeHtml(row.team_name)}</strong></td>
              <td><strong>${row.points}</strong></td><td>${row.played}</td><td>${row.wins}</td><td>${row.draws}</td><td>${row.losses}</td><td>${row.goals_for}</td><td>${row.goals_against}</td><td>${row.goal_difference}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </section>`).join('') || emptyState('No hay posiciones disponibles.');
}

async function renderTeams(options = {}) {
  if (!options.silent) loading('Equipos');
  const data = await cached('web/teams', {}, 90000, options);
  const teams = data.teams || [];
  setStatus('Equipos', `${teams.length} selecciones`);
  const byGroup = teams.reduce((acc, team) => {
    const key = groupLabel(team.group_name || team.group_code || 'Sin grupo');
    (acc[key] ||= []).push(team);
    return acc;
  }, {});
  root.innerHTML = Object.keys(byGroup).map((groupName) => `
    <section class="view-section">
      <h2 class="section-title">${escapeHtml(groupName)}</h2>
      <div class="grid team-grid">${byGroup[groupName].map(teamCard).join('')}</div>
    </section>`).join('') || emptyState('No hay equipos disponibles.');
  root.querySelectorAll('[data-team-slug]').forEach((card) => {
    card.addEventListener('click', () => openTeamModal(card.dataset.teamSlug));
  });
}

function teamCard(team) {
  const recent = Array.isArray(team.recent_form) ? team.recent_form : [];
  return `
    <article class="card team-card clickable-card fade-in" data-team-slug="${escapeHtml(team.slug)}" tabindex="0">
      <div class="team-card-top">
        <div class="team-head">
          <div class="flag">${teamFlag(team)}</div>
          <div><h3>${escapeHtml(team.display_name)}</h3><p>${escapeHtml(groupLabel(team.group_name || team.group_code) || team.country_code || '')}</p></div>
        </div>
        <strong class="points-pill">#${team.position || '-'} · ${team.points ?? 0} pts</strong>
      </div>
      <div class="team-rating">Rating <b>${team.seed_rating ?? team.elo_or_seed_rating ?? '-'}</b></div>
      <div class="form-dots">${recent.slice(0, 6).map((item) => `<span class="form-${String(item).toLowerCase()}">${escapeHtml(item)}</span>`).join('') || '<span>-</span>'}</div>
      <div class="stats-line">
        <div class="stat"><b>${team.played ?? 0}</b><span>J</span></div>
        <div class="stat"><b>${team.goal_difference ?? 0}</b><span>DG</span></div>
        <div class="stat"><b>${team.goals_for ?? 0}</b><span>GF</span></div>
        <div class="stat"><b>${team.roster_count ?? 0}</b><span>Plantel</span></div>
      </div>
    </article>`;
}

async function openTeamModal(teamSlug) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card"><div class="loading-head"><span>Cargando equipo</span><i></i></div>${skeletonCards(2)}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal(overlay);
  });
  try {
    const detail = await cached('web/team-detail', { team_slug: teamSlug }, 60000);
    overlay.innerHTML = teamModalHtml(detail);
    overlay.querySelector('[data-close-modal]').addEventListener('click', () => closeModal(overlay));
    overlay.querySelectorAll('[data-modal-tab]').forEach((button) => {
      button.addEventListener('click', () => setModalTab(overlay, button.dataset.modalTab));
    });
  } catch (error) {
    overlay.innerHTML = `<div class="modal-card"><button class="modal-close" data-close-modal>×</button><div class="error">${escapeHtml(error.message || error)}</div></div>`;
    overlay.querySelector('[data-close-modal]').addEventListener('click', () => closeModal(overlay));
  }
}

function closeModal(overlay) {
  overlay.remove();
}

function setModalTab(overlay, tab) {
  overlay.querySelectorAll('[data-modal-tab]').forEach((button) => button.classList.toggle('active', button.dataset.modalTab === tab));
  overlay.querySelectorAll('[data-modal-panel]').forEach((panel) => { panel.hidden = panel.dataset.modalPanel !== tab; });
}

function teamModalHtml(detail) {
  const team = detail.team || {};
  const matches = detail.matches || [];
  const roster = detail.roster || [];
  return `
    <div class="modal-card team-modal" role="dialog" aria-modal="true">
      <button class="modal-close" data-close-modal aria-label="Cerrar">×</button>
      <header class="modal-header">
        <div class="flag">${teamFlag(team)}</div>
        <div>
          <h2>${escapeHtml(team.display_name || 'Equipo')}</h2>
          <p>${escapeHtml(groupLabel(team.group_name || team.group_code) || team.country_code || '')}</p>
        </div>
      </header>
      <section class="modal-section">
        <h3>Resultados Mundial 2026</h3>
        <div class="team-results">${matches.map(teamResultRow).join('') || emptyState('No hay partidos publicados para este equipo.')}</div>
      </section>
      <div class="modal-tabs">
        <button class="active" data-modal-tab="roster">Plantel</button>
        <button data-modal-tab="stats">Stats WC</button>
      </div>
      <section data-modal-panel="roster">${rosterGrid(roster)}</section>
      <section data-modal-panel="stats" hidden>${rosterStatsTable(roster)}</section>
    </div>`;
}

function teamResultRow(match) {
  const home = match.home || {};
  const away = match.away || {};
  const result = match.team_result || '';
  const resultClass = result === 'W' ? 'result-win' : result === 'L' ? 'result-loss' : 'result-draw';
  const score = match.home_score !== null && match.home_score !== undefined ? `${match.home_score}-${match.away_score}` : 'vs';
  return `
    <div class="team-result-row">
      <span>${escapeHtml(dateLabel(match.kickoff_at).toLowerCase())}</span>
      <strong>${teamFlag(home)} ${escapeHtml(home.display_name || 'Por definir')} vs ${teamFlag(away)} ${escapeHtml(away.display_name || 'Por definir')}</strong>
      <b>${escapeHtml(score)}</b>
      <em class="${resultClass}">${escapeHtml(result || '-')}</em>
      <small>${escapeHtml(match.venue?.city || match.venue?.display_name || '')}</small>
    </div>`;
}

function rosterGrid(roster) {
  return `<div class="roster-grid">${roster.map((player) => `
    <div class="player-pill">
      <span>${escapeHtml(player.position || 'UNK')}</span>
      <strong>${escapeHtml(player.display_name || '')}</strong>
    </div>`).join('') || emptyState('Plantel no disponible.')}</div>`;
}

function rosterStatsTable(roster) {
  return `
    <div class="table-card modal-table">
      <table>
        <thead><tr><th>POS</th><th>Jugador</th><th>J</th><th>Min</th><th>G</th><th>A</th><th>TA</th><th>TR</th><th>Rating</th></tr></thead>
        <tbody>${roster.map((player) => {
          const stats = player.stats || {};
          return `<tr>
            <td>${escapeHtml(player.position || 'UNK')}</td>
            <td><strong>${escapeHtml(player.display_name || '')}</strong></td>
            <td>${stats.appearances || 0}</td>
            <td>${stats.minutes || 0}</td>
            <td>${stats.goals || 0}</td>
            <td>${stats.assists || 0}</td>
            <td>${stats.yellow_cards || 0}</td>
            <td>${stats.red_cards || 0}</td>
            <td>${stats.avg_rating ?? '-'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

async function renderKnockout(options = {}) {
  if (!options.silent) loading('Eliminatorias');
  const data = await cached('web/knockout', {}, 90000, options);
  const matches = data.matches || [];
  setStatus('Eliminatorias', `${matches.length} partidos`);
  const byStage = matches.reduce((acc, match) => {
    const key = knockoutStageKey(match);
    (acc[key] ||= []).push(match);
    return acc;
  }, {});
  if (!byStage[state.knockoutStage]) {
    state.knockoutStage = knockoutStages.find((stage) => byStage[stage.key]?.length)?.key || 'ROUND_OF_32';
  }
  const active = knockoutStages.find((stage) => stage.key === state.knockoutStage) || knockoutStages[0];
  const activeMatches = byStage[active.key] || [];
  root.innerHTML = `
    <div class="knockout-view fade-in">
      <div class="knockout-tabs" role="tablist" aria-label="Fases eliminatorias">
        ${knockoutStages.map((stage) => `
          <button class="${stage.key === active.key ? 'active' : ''}" data-knockout-stage="${stage.key}" type="button" role="tab" aria-selected="${stage.key === active.key ? 'true' : 'false'}">
            ${escapeHtml(stage.title)}
            <span>${(byStage[stage.key] || []).length || stage.count}</span>
          </button>`).join('')}
      </div>
      ${knockoutColumn(active, activeMatches)}
    </div>`;
  root.querySelectorAll('[data-knockout-stage]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.knockoutStage === state.knockoutStage) return;
      state.knockoutStage = button.dataset.knockoutStage;
      renderKnockout({ localOnly: true });
    });
  });
  const view = root.querySelector('.knockout-view');
  if (view) attachKnockoutSwipe(view);
}

function knockoutColumn(stage, matches) {
  const cards = matches.length
    ? matches.map(knockoutCard).join('')
    : Array.from({ length: stage.count }).map((_, index) => placeholderKnockoutCard(stage, index + 1)).join('');
  return `
    <section class="knockout-column">
      <header><h2>${escapeHtml(stage.title)}</h2><span>${stage.count} partidos</span></header>
      <div class="knockout-list">${cards}</div>
    </section>`;
}

function adjacentKnockoutStage(direction) {
  const stages = knockoutStages.map((stage) => stage.key);
  const current = stages.indexOf(state.knockoutStage);
  const next = current + direction;
  return stages[next] || null;
}

function attachKnockoutSwipe(container) {
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  container.addEventListener('touchstart', (event) => {
    if (event.target.closest('.knockout-tabs, button, a, .modal-overlay')) return;
    const touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startedAt = Date.now();
  }, { passive: true });
  container.addEventListener('touchend', (event) => {
    if (!startedAt) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const elapsed = Date.now() - startedAt;
    startedAt = 0;
    if (Math.abs(deltaX) < 54 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35 || elapsed > 650) return;
    const nextStage = adjacentKnockoutStage(deltaX < 0 ? 1 : -1);
    if (!nextStage) return;
    state.knockoutStage = nextStage;
    container.classList.add(deltaX < 0 ? 'swipe-left' : 'swipe-right');
    renderKnockout({ localOnly: true });
  }, { passive: true });
}

function knockoutCard(match) {
  return `
    <article class="card bracket-card fade-in">
      <div class="bracket-top"><span>${escapeHtml(match.match_number ? `Partido ${match.match_number}` : 'Partido')}</span><b>${escapeHtml(chileDateTimeLabel(match.kickoff_at))}</b></div>
      <div class="bracket-team">${teamFlag(match.home)} <strong>${escapeHtml(match.home?.display_name || match.home?.slot_label || 'Por definir')}</strong></div>
      <div class="bracket-vs">${matchScore(match)}</div>
      <div class="bracket-team">${teamFlag(match.away)} <strong>${escapeHtml(match.away?.display_name || match.away?.slot_label || 'Por definir')}</strong></div>
      <div class="venue compact">📍 ${escapeHtml(match.venue?.display_name || 'Sede por definir')}</div>
    </article>`;
}

function placeholderKnockoutCard(stage, index) {
  const labels = stage.key === 'ROUND_OF_32' && roundOf32Slots[index - 1]
    ? roundOf32Slots[index - 1]
    : [`Ganador ${stage.title.toLowerCase()} ${index * 2 - 1}`, `Ganador ${stage.title.toLowerCase()} ${index * 2}`];
  return `
    <article class="card bracket-card placeholder">
      <div class="bracket-top"><span>Partido ${index}</span><b>Por definir</b></div>
      <div class="bracket-team"><span class="placeholder-icon">◇</span> <strong>${escapeHtml(labels[0])}</strong></div>
      <div class="bracket-vs">vs</div>
      <div class="bracket-team"><span class="placeholder-icon">◇</span> <strong>${escapeHtml(labels[1])}</strong></div>
      <div class="venue compact">📍 Sede por confirmar</div>
    </article>`;
}

async function render(options = {}) {
  const seq = ++state.renderSeq;
  if (state.activeController) state.activeController.abort();
  state.activeController = new AbortController();
  const renderOptions = { ...options, signal: state.activeController.signal };
  try {
    updateTabs();
    if (state.view === 'standings') await renderStandings(renderOptions);
    else if (state.view === 'teams') await renderTeams(renderOptions);
    else if (state.view === 'knockout') await renderKnockout(renderOptions);
    else await renderToday(renderOptions);
  } catch (error) {
    if (error.name === 'AbortError' || seq !== state.renderSeq) return;
    if (String(error.message) !== 'Unauthorized') errorState(error);
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    if (state.view === button.dataset.view) return;
    state.view = button.dataset.view;
    updateTabs();
    render();
  });
});

$('#refresh-btn').addEventListener('click', () => {
  state.cache.clear();
  render();
});

function refreshSilently() {
  if (document.hidden) return;
  const path = state.view === 'standings' ? 'web/standings' : state.view === 'teams' ? 'web/teams' : state.view === 'knockout' ? 'web/knockout' : 'web/matches-overview';
  invalidateViewCache(path);
  render({ silent: true });
}

if (AUTO_REFRESH_MS > 0) {
  state.refreshTimer = window.setInterval(refreshSilently, AUTO_REFRESH_MS);
}

render();
