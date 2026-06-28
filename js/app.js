const CFG = window.MATCH_ALPHA_CONFIG || {};
const API_BASE_URL = String(CFG.API_BASE_URL || '').replace(/\/+$/, '');
const SEASON = new URLSearchParams(location.search).get('season') || CFG.DEFAULT_SEASON || 'wc2026';
const KEY_STORAGE = CFG.KEY_STORAGE || 'match_alpha_web_key';
const AUTO_REFRESH_MS = Number(CFG.AUTO_REFRESH_MS || 30000);
const CHILE_TIMEZONE = 'America/Santiago';

const state = {
  view: 'today',
  dateMode: 'today',
  cache: new Map(),
  refreshTimer: null,
  lastUpdatedAt: null,
  layout: null,
  renderSeq: 0,
  activeController: null,
  knockoutStage: null,
};

const dateModes = [
  ['yesterday', 'Ayer', '←'],
  ['today', 'Hoy', '●'],
  ['tomorrow', 'Mañana', '→'],
  ['upcoming', 'Próximos', '⌁'],
];

// Emergency fallback only — real definitions come from layout API
const _FALLBACK_KNOCKOUT_STAGES = [
  { key: 'ROUND_OF_32', title: 'Dieciseisavos', count: 16 },
  { key: 'ROUND_OF_16', title: 'Octavos', count: 8 },
  { key: 'QUARTER_FINAL', title: 'Cuartos', count: 4 },
  { key: 'SEMI_FINAL', title: 'Semifinales', count: 2 },
  { key: 'THIRD_PLACE', title: 'Tercer puesto', count: 1 },
  { key: 'FINAL', title: 'Final', count: 1 },
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
  const stages = knockoutStageDefinitions();
  // Prefer exact match against layout stage keys
  if (match.stage_code && stages.some((s) => s.key === match.stage_code)) return match.stage_code;
  // Then try stage_name
  if (match.stage_name && stages.some((s) => s.key === match.stage_name)) return match.stage_name;
  // Fallback: fuzzy keyword matching (WC-specific but safe as last resort)
  const raw = `${match.stage_code || ''} ${match.stage_name || ''} ${match.stage_label || ''}`.toUpperCase();
  for (const s of stages) {
    if (raw.includes(s.key)) return s.key;
  }
  if (raw.includes('32') || raw.includes('DIECISEIS')) return 'ROUND_OF_32';
  if (raw.includes('16') || raw.includes('OCTAV')) return 'ROUND_OF_16';
  if (raw.includes('QUARTER') || raw.includes('CUART')) return 'QUARTER_FINAL';
  if (raw.includes('SEMI')) return 'SEMI_FINAL';
  if (raw.includes('THIRD') || raw.includes('TERCER')) return 'THIRD_PLACE';
  if (raw.includes('FINAL')) return 'FINAL';
  return match.stage_code || match.stage_name || stages[0]?.key || 'KNOCKOUT';
}

function teamFlag(team) {
  if (team?.flag_asset) return `<img class="flag-img" src="${escapeHtml(team.flag_asset)}" alt="" loading="lazy">`;
  if (team?.flag_emoji) return escapeHtml(team.flag_emoji);
  return team?.is_placeholder ? '<span class="placeholder-icon">◇</span>' : '🏳️';
}

function layoutKeyToView(key) {
  return {
    matches: 'today',
    standings: 'standings',
    teams: 'teams',
    bracket: 'knockout',
    knockout: 'knockout',
  }[key] || key;
}

function fallbackLayout() {
  return {
    capabilities: {
      has_groups: true,
      has_league_table: false,
      has_knockout: true,
      has_standings: true,
      has_teams: true,
    },
    ui: {
      default_view: 'matches',
      navigation: [
        { key: 'matches', label: 'Partidos', enabled: true, order: 10 },
        { key: 'standings', label: 'Posiciones', enabled: true, order: 20 },
        { key: 'teams', label: 'Equipos', enabled: true, order: 30 },
        { key: 'bracket', label: 'Eliminatorias', enabled: true, order: 40 },
      ],
    },
    stages: _FALLBACK_KNOCKOUT_STAGES.map((stage, index) => ({
      stage_code: stage.key,
      stage_label: stage.title,
      stage_order: index + 1,
      view_type: 'BRACKET_ROUND',
      match_count: stage.count,
    })),
  };
}

async function ensureLayout(options = {}) {
  if (state.layout && !options.forceLayoutRefresh) return state.layout;
  try {
    state.layout = await cached(`competitions/${SEASON}/layout`, {}, 300000, options);
  } catch (error) {
    console.warn('No se pudo cargar layout de competencia, usando fallback local.', error);
    state.layout = fallbackLayout();
  }
  applyCompetitionLayout();
  return state.layout;
}

function navigationItems() {
  return (state.layout?.ui?.navigation || state.layout?.navigation || fallbackLayout().ui.navigation)
    .filter((item) => item.enabled !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function competitionLabel() {
  return state.layout?.name
    || state.layout?.competition?.display_name
    || state.layout?.competition_name
    || SEASON;
}

function stageDefinitionsByViewType(viewType) {
  const vt = String(viewType).toUpperCase();
  return (state.layout?.stages || [])
    .filter((s) => String(s.view_type || '').toUpperCase() === vt)
    .sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0))
    .map((s) => ({
      key: s.stage_code || s.stage_name,
      title: s.stage_label || s.stage_name || s.stage_code,
      count: s.match_count || 0,
      viewType: s.view_type,
    }))
    .filter((s) => s.key);
}

function applyCompetitionLayout() {
  const navByView = Object.fromEntries(navigationItems().map((item) => [layoutKeyToView(item.key), item]));
  const ALWAYS_VISIBLE = new Set(['ev', 'model', 'stats', 'news']);
  document.querySelectorAll('.tab').forEach((button) => {
    if (button.classList.contains('tab--quant')) return; // quant tabs always visible
    if (ALWAYS_VISIBLE.has(button.dataset.view)) return;  // extra always-visible tabs
    const item = navByView[button.dataset.view];
    button.hidden = !item;
    if (item?.label) button.textContent = item.label;
  });
  const QUANT_VIEWS = new Set(['ev', 'model', 'stats']);
  if (!navByView[state.view] && !QUANT_VIEWS.has(state.view) && state.view !== 'news') {
    const defaultView = layoutKeyToView(state.layout?.ui?.default_view || navigationItems()[0]?.key || 'matches');
    state.view = navByView[defaultView] ? defaultView : layoutKeyToView(navigationItems()[0]?.key || 'matches');
  }
  // Set initial knockout stage from first bracket stage in layout
  if (!state.knockoutStage) {
    state.knockoutStage = knockoutStageDefinitions()[0]?.key || null;
  }
  // Competition name from layout
  const compName = competitionLabel();
  if (compName && compName !== SEASON) {
    const brandEl = document.querySelector('.brand p');
    if (brandEl && brandEl.textContent !== compName) brandEl.textContent = compName;
  }
}

function knockoutStageDefinitions() {
  const layoutStages = state.layout?.stages || [];
  const stages = layoutStages
    .filter((stage) => String(stage.view_type || '').toUpperCase() === 'BRACKET_ROUND')
    .sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0))
    .map((stage) => ({
      key: stage.stage_code || stage.stage_name,
      title: stage.stage_label || stage.stage_name || stage.stage_code || 'Eliminatoria',
      count: stage.expected_match_count || stage.match_count || stage.rules?.expected_matches || 0,
      viewType: stage.view_type || 'BRACKET_ROUND',
    }))
    .filter((stage) => stage.key);
  return stages.length ? stages : _FALLBACK_KNOCKOUT_STAGES;
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
  if (state.layout) applyCompetitionLayout();
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
  if (['FINISHED', 'FT', 'AET', 'PEN'].includes(value)) return 'Finalizado';
  if (['LIVE', 'IN_PLAY'].includes(value)) return 'EN VIVO';
  if (value === 'HT') return 'Descanso';
  if (value === 'PAUSED') return 'Pausado';
  if (['POSTPONED'].includes(value)) return 'Pospuesto';
  if (['CANCELLED', 'ABANDONED'].includes(value)) return 'Cancelado';
  return 'Programado';
}

function liveMinuteLabel(match) {
  if (!match.kickoff_at) return null;
  const value = String(match.status || '').toUpperCase();
  if (value === 'HT') return '45+\'';
  if (!['LIVE', 'IN_PLAY'].includes(value)) return null;
  const elapsed = Math.floor((Date.now() - new Date(match.kickoff_at).getTime()) / 60000);
  if (elapsed < 0) return null;
  if (elapsed <= 45) return `${elapsed}'`;
  // After 45min: show as extra time (second half started ~15min after HT)
  const secondHalf = elapsed - 60; // ~15min HT break
  if (secondHalf < 0) return '45+\'';
  const min = Math.min(45 + secondHalf, 90);
  return `${min}'`;
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

function matchTimeHtml(match) {
  const label = escapeHtml(statusLabel(match.status));
  const min = liveMinuteLabel(match);
  if (min) return `${label} · <strong class="match-minute">${escapeHtml(min)}</strong>`;
  return `${label} · ${escapeHtml(chileDateTimeLabel(match.kickoff_at))}`;
}

function matchCard(match) {
  const home = match.home || { display_name: 'Por definir', flag_emoji: '🏳️' };
  const away = match.away || { display_name: 'Por definir', flag_emoji: '🏳️' };
  const group = matchGroupLabel(match);
  const stage = matchStageLabel(match);
  const meta = [stage, group].filter(Boolean).join(' · ');
  const isLive = ['IN_PROGRESS', 'IN_PLAY', 'LIVE', 'HT', 'PAUSED'].includes(match.status);
  return `
    <article class="card match-card fade-in" data-status="${escapeHtml(match.status || 'SCHEDULED')}">
      <div class="match-meta">
        <span class="stage-chip${isLive ? ' stage-chip--live' : ''}">${escapeHtml(meta || 'Partido')}</span>
        <span class="match-time ${statusClass(match.status)}">${matchTimeHtml(match)}</span>
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
  const bar = document.getElementById('date-filter-bar');
  if (bar) {
    bar.hidden = false;
    bar.innerHTML = `
      <div class="toolbar">
        <div class="segment" role="tablist" aria-label="Fechas">
          ${dateModes.map(([mode, label, icon]) => `
            <button class="${state.dateMode === mode ? 'active' : ''}" data-date-mode="${mode}" type="button">
              <span>${escapeHtml(icon)}</span>${escapeHtml(label)}
            </button>`).join('')}
        </div>
      </div>`;
  }
  return ''; // no longer injected inline into today-view
}

function hideDateFilterBar() {
  const bar = document.getElementById('date-filter-bar');
  if (bar) bar.hidden = true;
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

  // Group by date, then by kickoff time within each date
  const byDate = {};
  for (const match of matches) {
    const dk = dateLabel(match.kickoff_at);
    const tk = timeLabel(match.kickoff_at);
    if (!byDate[dk]) byDate[dk] = {};
    if (!byDate[dk][tk]) byDate[dk][tk] = { timeKey: tk, kickoffAt: match.kickoff_at, matches: [] };
    byDate[dk][tk].matches.push(match);
  }

  const content = Object.keys(byDate).length
    ? Object.keys(byDate).map((dateKey) => {
        const timeBlocks = Object.values(byDate[dateKey]).sort((a, b) => (a.kickoffAt < b.kickoffAt ? -1 : 1));
        const blocksHtml = timeBlocks.map((block) => {
          const hasLive = block.matches.some((m) => ['IN_PROGRESS', 'IN_PLAY', 'LIVE', 'HT', 'PAUSED'].includes(m.status));
          const count = block.matches.length;
          return `
            <div class="kickoff-block">
              <div class="kickoff-header">
                <span class="kickoff-time">${escapeHtml(block.timeKey)} Chile</span>
                <span class="kickoff-meta">${count} partido${count !== 1 ? 's' : ''}${hasLive ? ' <span class="live-badge">EN VIVO</span>' : ''}</span>
              </div>
              <div class="grid">${block.matches.map(matchCard).join('')}</div>
            </div>`;
        }).join('');
        return `<section class="view-section">${blocksHtml}</section>`;
      }).join('')
    : emptyState('No hay partidos para este rango.');

  renderDateToolbar(); // injects into #date-filter-bar, outside scroll area
  root.innerHTML = `<div class="today-view"><div class="day-content fade-in">${content}</div></div>`;
  document.getElementById('date-filter-bar')?.querySelectorAll('[data-date-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.dateMode === button.dataset.dateMode) return;
      state.dateMode = button.dataset.dateMode;
      renderToday({ localOnly: true });
    });
  });
  const todayView = root.querySelector('.today-view');
  if (todayView) attachDaySwipe(todayView);
}

// ─── Stage view renderers ─────────────────────────────────────────────────────
// Each renderer receives pre-fetched data and layout context.
// renderStandings() is the dispatch entry point — it reads view_type from layout
// and delegates to the correct renderer. Adding a new competition format only
// requires registering a new renderer here; the dispatch table handles the rest.

const STANDINGS_RENDERERS = {
  GROUP_TABLES: renderGroupTablesView,
  LEAGUE_TABLE: renderLeagueTableView,
};

function _standingsRow(row, index, zoneCls = '') {
  const pos = row.position || index + 1;
  const posCls = pos <= 3 ? `standings-row--${pos === 1 ? '1st' : pos === 2 ? '2nd' : '3rd'}` : '';
  const cls = [posCls, zoneCls].filter(Boolean).join(' ');
  return `
    <tr${cls ? ` class="${cls}"` : ''}>
      <td>${pos}</td>
      <td><strong>${teamFlag(row)} ${escapeHtml(row.team_name)}</strong></td>
      <td><strong>${row.points}</strong></td><td>${row.played}</td><td>${row.wins}</td><td>${row.draws}</td><td>${row.losses}</td><td>${row.goals_for}</td><td>${row.goals_against}</td><td>${row.goal_difference}</td>
    </tr>`;
}

function _standingsTable(rows, zoneResolver = () => '') {
  return `
    <div class="card table-card">
      <table>
        <thead><tr><th>#</th><th>Equipo</th><th>Pts</th><th>J</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DG</th></tr></thead>
        <tbody>${rows.map((row, i) => _standingsRow(row, i, zoneResolver(row, i))).join('')}</tbody>
      </table>
    </div>`;
}

function renderGroupTablesView(groups) {
  const sorted = [...groups].sort((a, b) => (a.group_order || 0) - (b.group_order || 0));
  return sorted.map((group) => {
    const rows = [...(group.standings || [])].sort((a, b) => (a.position || 99) - (b.position || 99));
    return `
    <section class="group-block fade-in">
      <h2 class="section-title">${escapeHtml(groupLabel(group.group_name))}</h2>
      ${_standingsTable(rows, (row, i) => {
        const pos = row.position || i + 1;
        const qualify = group.rules?.promotion_spots ?? 2;
        if (pos <= qualify) return 'zone--promote';
        return '';
      })}
    </section>`;
  }).join('');
}

function renderLeagueTableView(groups, stageRules = {}) {
  const allRows = groups.flatMap((g) => g.standings || []);
  const sorted = [...allRows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goal_difference !== a.goal_difference) return b.goal_difference - a.goal_difference;
    return b.goals_for - a.goals_for;
  }).map((row, i) => ({ ...row, position: i + 1 }));

  const promoteSpots = stageRules.promotion_spots ?? 0;
  const euroSpots    = stageRules.europe_spots    ?? 0;
  const relegateSpots = stageRules.relegation_spots ?? 0;
  const total = sorted.length;

  const zoneResolver = (row) => {
    const pos = row.position;
    if (promoteSpots > 0 && pos <= promoteSpots)                          return 'zone--promote';
    if (euroSpots    > 0 && pos <= promoteSpots + euroSpots)              return 'zone--europe';
    if (relegateSpots > 0 && pos > total - relegateSpots)                 return 'zone--relegate';
    return '';
  };

  const legend = [
    promoteSpots  > 0 ? `<span class="zone-legend zone-legend--promote"></span> Clasificación` : '',
    euroSpots     > 0 ? `<span class="zone-legend zone-legend--europe"></span> Europa`          : '',
    relegateSpots > 0 ? `<span class="zone-legend zone-legend--relegate"></span> Descenso`     : '',
  ].filter(Boolean).join('');

  return `
    <section class="group-block fade-in">
      ${_standingsTable(sorted, zoneResolver)}
      ${legend ? `<div class="zone-legend-bar">${legend}</div>` : ''}
    </section>`;
}

async function renderMatchListView(stageCode, stageTitle, options = {}) {
  const data = await cached('web/matches', { stage_code: stageCode }, 90000, options);
  const matches = data.matches || data.items || [];
  if (!matches.length) return emptyState(`Sin partidos para ${escapeHtml(stageTitle)}.`);

  const byKickoff = matches.reduce((acc, m) => {
    const dt = new Date(m.kickoff_at);
    const key = dt.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: CHILE_TIMEZONE });
    (acc[key] ||= []).push(m);
    return acc;
  }, {});

  return Object.entries(byKickoff).map(([dateLabel, dayMatches]) => `
    <section class="kickoff-block fade-in">
      <header class="kickoff-header">
        <span class="kickoff-time">${escapeHtml(dateLabel)}</span>
      </header>
      <div class="grid">${dayMatches.map(matchCard).join('')}</div>
    </section>`).join('');
}

async function renderStandings(options = {}) {
  if (!options.silent) loading('Posiciones');
  await ensureLayout();
  const data = await cached('web/standings', {}, 90000, options);
  const groups = data.groups || [];

  // Determine which renderer to use from layout stages
  const leagueStages   = stageDefinitionsByViewType('LEAGUE_TABLE');
  const groupStages    = stageDefinitionsByViewType('GROUP_TABLES');
  const hasLeagueStage = leagueStages.length > 0;
  const hasGroupStage  = groupStages.length > 0;

  // Fallback: capabilities flags if no explicit stage view_type
  const isLeagueByCapability = state.layout?.capabilities?.has_league_table && !state.layout?.capabilities?.has_groups;
  const useLeague = hasLeagueStage || (!hasGroupStage && isLeagueByCapability);

  if (useLeague) {
    const stageRules = state.layout?.stages?.find(
      (s) => String(s.view_type || '').toUpperCase() === 'LEAGUE_TABLE'
    )?.rules || {};
    const totalTeams = groups.flatMap((g) => g.standings || []).length;
    setStatus('Posiciones', `${totalTeams} equipos`);
    root.innerHTML = renderLeagueTableView(groups, stageRules) || emptyState('No hay posiciones disponibles.');
  } else {
    setStatus('Posiciones', `${groups.length} grupos`);
    root.innerHTML = renderGroupTablesView(groups) || emptyState('No hay posiciones disponibles.');
  }
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
        <h3>Resultados ${escapeHtml(competitionLabel())}</h3>
        <div class="team-results">${matches.map(teamResultRow).join('') || emptyState('No hay partidos publicados para este equipo.')}</div>
      </section>
      <div class="modal-tabs">
        <button class="active" data-modal-tab="roster">Plantel</button>
        <button data-modal-tab="stats">Stats</button>
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
  await ensureLayout();
  const stages = knockoutStageDefinitions();
  const data = await cached('web/knockout', {}, 90000, options);
  const matches = data.matches || [];
  setStatus('Eliminatorias', `${matches.length} partidos`);
  const byStage = matches.reduce((acc, match) => {
    const key = knockoutStageKey(match);
    (acc[key] ||= []).push(match);
    return acc;
  }, {});
  // Init or re-anchor knockoutStage to a stage that has data
  if (!state.knockoutStage || !byStage[state.knockoutStage]) {
    state.knockoutStage = stages.find((s) => byStage[s.key]?.length)?.key || stages[0]?.key || null;
  }
  const active = stages.find((stage) => stage.key === state.knockoutStage) || stages[0];
  const activeMatches = byStage[active.key] || [];
  const activeIndex = stages.findIndex((s) => s.key === state.knockoutStage);
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex < stages.length - 1;

  root.innerHTML = `
    <div class="knockout-view fade-in">
      <div class="bracket-tree-wrap">
        ${renderBracketTree(byStage, stages)}
      </div>
      <div class="knockout-mobile-view">
        <div class="knockout-stage-header">
          <button class="knockout-nav-btn${hasPrev ? '' : ' disabled'}" data-dir="-1" ${hasPrev ? '' : 'disabled'} aria-label="Etapa anterior">‹</button>
          <div class="knockout-stage-info">
            <h2 class="knockout-stage-title">${escapeHtml(active.title.toUpperCase())}</h2>
            <span class="knockout-stage-count">${(byStage[active.key] || []).length || active.count} partidos</span>
          </div>
          <button class="knockout-nav-btn${hasNext ? '' : ' disabled'}" data-dir="1" ${hasNext ? '' : 'disabled'} aria-label="Etapa siguiente">›</button>
        </div>
        <div class="knockout-progress" role="tablist" aria-label="Progreso eliminatorias">
          ${stages.map((stage) => `
            <button class="knockout-progress-step${stage.key === state.knockoutStage ? ' active' : ''}"
                    data-knockout-stage="${stage.key}" role="tab"
                    aria-selected="${stage.key === state.knockoutStage}"
                    title="${escapeHtml(stage.title)}">
              <span class="knockout-progress-dot"></span>
              <span class="knockout-progress-label">${escapeHtml(stage.title)}</span>
            </button>`).join('')}
        </div>
        <div class="knockout-tabs" role="tablist" aria-label="Fases eliminatorias">
          ${stages.map((stage) => `
            <button class="${stage.key === active.key ? 'active' : ''}" data-knockout-stage="${stage.key}" type="button" role="tab" aria-selected="${stage.key === active.key ? 'true' : 'false'}">
              ${escapeHtml(stage.title)}
              <span>${(byStage[stage.key] || []).length || stage.count}</span>
            </button>`).join('')}
        </div>
        ${knockoutColumn(active, activeMatches)}
      </div>
    </div>`;

  root.querySelectorAll('[data-knockout-stage]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.knockoutStage === state.knockoutStage) return;
      state.knockoutStage = button.dataset.knockoutStage;
      renderKnockout({ localOnly: true });
    });
  });
  root.querySelectorAll('[data-dir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextStage = adjacentKnockoutStage(Number(btn.dataset.dir));
      if (!nextStage) return;
      state.knockoutStage = nextStage;
      renderKnockout({ localOnly: true });
    });
  });
  const view = root.querySelector('.knockout-view');
  if (view) attachKnockoutSwipe(view);
}

function renderBracketTree(byStage, stages) {
  const rounds = stages.filter((s) => !['GROUP_STAGE', 'LEAGUE_PHASE'].includes(s.key));
  if (!rounds.length) return '';
  const maxSlots = Math.max(...rounds.map((s) => s.count || 1), 1);
  const NODE_H = 64;
  const NODE_GAP = 6;
  const bracketH = maxSlots * (NODE_H + NODE_GAP);
  return `
    <div class="bracket-tree">
      <div class="bracket-rounds" style="--bracket-height:${bracketH}px">
        ${rounds.map((stage) => {
          const stageMatches = byStage[stage.key] || [];
          const total = Math.max(stage.count || stageMatches.length, 1);
          const nodes = Array.from({ length: total }, (_, i) => stageMatches[i] || null);
          return `
            <div class="bracket-round">
              <div class="bracket-round-label">${escapeHtml(stage.title)}</div>
              <div class="bracket-round-slots">
                ${nodes.map((match) => match ? bracketNodeCard(match) : `
                  <div class="bracket-node bracket-node--placeholder">
                    <div class="bracket-node-team">
                      <span class="placeholder-icon">◇</span>
                      <span class="bracket-node-name" style="color:var(--faint);font-style:italic">Por definir</span>
                    </div>
                    <div class="bracket-node-divider"></div>
                    <div class="bracket-node-team">
                      <span class="placeholder-icon">◇</span>
                      <span class="bracket-node-name" style="color:var(--faint);font-style:italic">Por definir</span>
                    </div>
                  </div>`).join('')}
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function bracketNodeCard(match) {
  const isLive = ['IN_PROGRESS', 'IN_PLAY', 'LIVE', 'HT', 'PAUSED'].includes(match.status);
  const hasScore = match.home_score != null && match.away_score != null;
  const homeWin = hasScore && match.home_score > match.away_score;
  const awayWin = hasScore && match.away_score > match.home_score;
  const dateStr = match.kickoff_at ? dateLabel(match.kickoff_at).toLowerCase() : '';
  const timeStr = match.kickoff_at ? timeLabel(match.kickoff_at) : '';
  return `
    <div class="bracket-node${isLive ? ' bracket-node--live' : ''}">
      ${dateStr ? `<div class="bracket-node-date">${escapeHtml(dateStr)} · ${escapeHtml(timeStr)} CL</div>` : ''}
      <div class="bracket-node-team${homeWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamFlag(match.home)}</span>
        <span class="bracket-node-name">${escapeHtml(match.home?.display_name || match.home?.slot_label || '?')}</span>
        ${hasScore ? `<span class="bracket-node-score${homeWin ? ' bracket-node-score--win' : ''}">${match.home_score}</span>` : ''}
      </div>
      <div class="bracket-node-divider"></div>
      <div class="bracket-node-team${awayWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamFlag(match.away)}</span>
        <span class="bracket-node-name">${escapeHtml(match.away?.display_name || match.away?.slot_label || '?')}</span>
        ${hasScore ? `<span class="bracket-node-score${awayWin ? ' bracket-node-score--win' : ''}">${match.away_score}</span>` : ''}
      </div>
    </div>`;
}

function knockoutColumn(stage, matches) {
  const placeholderCount = Math.max(Number(stage.count || 0), 1);
  const cards = matches.length
    ? matches.map(knockoutCard).join('')
    : Array.from({ length: placeholderCount }).map((_, index) => placeholderKnockoutCard(stage, index + 1)).join('');
  return `
    <section class="knockout-column">
      <header><h2>${escapeHtml(stage.title)}</h2><span>${stage.count} partidos</span></header>
      <div class="knockout-list">${cards}</div>
    </section>`;
}

function adjacentKnockoutStage(direction) {
  const stages = knockoutStageDefinitions().map((stage) => stage.key);
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
  const labels = [`Clasificado por definir`, `Clasificado por definir`];
  return `
    <article class="card bracket-card placeholder">
      <div class="bracket-top"><span>Partido ${index}</span><b>Por definir</b></div>
      <div class="bracket-team"><span class="placeholder-icon">◇</span> <strong>${escapeHtml(labels[0])}</strong></div>
      <div class="bracket-vs">vs</div>
      <div class="bracket-team"><span class="placeholder-icon">◇</span> <strong>${escapeHtml(labels[1])}</strong></div>
      <div class="venue compact">📍 Sede por confirmar</div>
    </article>`;
}

// ─── Quant adapters ────────────────────────────────────────────────────────

function adaptEVOpportunity(raw) {
  return {
    id: raw.betting_decision_id,
    matchLabel: [raw.home_flag_emoji, raw.home_team_name, 'vs', raw.away_flag_emoji, raw.away_team_name || raw.away_slot_label || '???'].filter(Boolean).join(' ') || raw.match_id,
    kickoffAt: raw.kickoff_at,
    marketCode: raw.market_code || '',
    selectionCode: raw.selection_code || '',
    modelProb: raw.model_probability ?? raw.calibrated_probability ?? raw.raw_probability,
    marketProb: raw.market_probability ?? raw.market_implied_probability,
    decimalOdds: raw.decimal_odds,
    fairOdds: raw.model_probability ? (1 / raw.model_probability) : null,
    edge: Number(raw.edge) || null,
    ev: Number(raw.ev) || null,
    kellyFraction: Number(raw.kelly_fraction) || null,
    confidenceScore: raw.confidence_score,
    decisionStatus: raw.decision_status,
    predictionStatus: raw.prediction_status,
    blockReasons: Array.isArray(raw.block_reasons) ? raw.block_reasons : (raw.block_reason ? [raw.block_reason] : []),
    modelName: raw.model_name,
    modelFamily: raw.model_family,
    oddsAgeMinutes: raw.odds_age_minutes,
  };
}

function adaptBlockedDecision(raw) {
  return {
    id: raw.betting_decision_id,
    matchLabel: [raw.home_flag_emoji, raw.home_team_name, 'vs', raw.away_flag_emoji, raw.away_team_name || raw.away_slot_label || '???'].filter(Boolean).join(' ') || raw.match_id,
    kickoffAt: raw.kickoff_at,
    marketCode: raw.market_code || '',
    selectionCode: raw.selection_code || '',
    decisionStatus: raw.decision_status,
    blockReasons: Array.isArray(raw.block_reasons) ? raw.block_reasons : (raw.block_reason ? [raw.block_reason] : []),
    ev: Number(raw.ev) || null,
    edge: Number(raw.edge) || null,
    confidenceScore: raw.confidence_score,
  };
}

// ─── EV+ view ──────────────────────────────────────────────────────────────

const BLOCK_REASON_LABELS = {
  NO_CALIBRATION: 'Sin calibración',
  LOW_CONFIDENCE: 'Confianza baja',
  ODDS_STALE: 'Odds desactualizadas',
  LOW_LIQUIDITY: 'Liquidez baja',
  COMPETITION_NOT_BETTABLE: 'Competencia bloqueada',
  LEGACY_IMPORT: 'Importación legacy',
  ODDS_CAPTURED_AFTER_KICKOFF: 'Odds post-kickoff',
  PAPER_ONLY_BACKFILL: 'Backfill histórico',
  EV_OUTLIER: 'EV outlier (modelo descalibrado)',
};

const BLOCK_REASON_DESC = {
  NO_CALIBRATION: 'El modelo aún es RAW_ONLY. Se necesitan 30+ picks settled para calibrar.',
  LOW_CONFIDENCE: 'El confidence score es menor a 0.30. Más datos de features o calibración mejorarán esto.',
  ODDS_STALE: 'Las últimas odds capturadas tienen más de 2 horas. Permitido en PAPER_ONLY.',
  LOW_LIQUIDITY: 'El mercado tiene liquidez baja. No recomendado para apuestas reales.',
  COMPETITION_NOT_BETTABLE: 'Esta competencia está en modo OBSERVATION, no BETTABLE.',
  LEGACY_IMPORT: 'Decisión importada de datos históricos. No ejecutable.',
  ODDS_CAPTURED_AFTER_KICKOFF: 'Las odds fueron capturadas después del inicio del partido.',
  PAPER_ONLY_BACKFILL: 'Decisión de backfill histórico. Solo para análisis.',
  EV_OUTLIER: 'EV > 40% — estadísticamente imposible en mercados líquidos. Indica modelo descalibrado o datos de odds incorrectos.',
};

function quantEmptyState(icon, title, text) {
  return `<div class="quant-empty"><div class="quant-empty__icon">${icon}</div><div class="quant-empty__title">${escapeHtml(title)}</div><div class="quant-empty__text">${escapeHtml(text)}</div></div>`;
}

function decisionStatusChip(status) {
  const cfg = {
    BETTABLE:   ['chip--ok',   'BETTABLE'],
    PAPER_ONLY: ['chip--warn', 'PAPER'],
    BLOCKED:    ['chip--muted','BLOQUEADO'],
    NO_EDGE:    ['chip--muted','SIN EDGE'],
  };
  const [cls, label] = cfg[status] || ['chip--muted', escapeHtml(status)];
  return `<span class="chip ${cls}">${label}</span>`;
}

function probBars(modelProb, marketProb) {
  if (modelProb == null && marketProb == null) return '';
  const mp = Math.round((modelProb ?? 0) * 100);
  const mkp = Math.round((marketProb ?? 0) * 100);
  return `
    <div class="prob-bars">
      <div class="prob-bar-row">
        <span class="prob-bar-label">Modelo</span>
        <div class="prob-bar-track"><div class="prob-bar-fill prob-bar-fill--model" style="width:${mp}%"></div></div>
        <span class="prob-bar-value">${mp}%</span>
      </div>
      <div class="prob-bar-row">
        <span class="prob-bar-label">Mercado</span>
        <div class="prob-bar-track"><div class="prob-bar-fill prob-bar-fill--market" style="width:${mkp}%"></div></div>
        <span class="prob-bar-value">${mkp}%</span>
      </div>
    </div>`;
}

function fmtPct(value) {
  if (value == null) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function fmtNum(value, decimals = 2) {
  if (value == null) return '—';
  return Number(value).toFixed(decimals);
}

function evHeroCard(opp) {
  if (!opp) return '';
  const evHeat = opp.ev > 0.10 ? 'ev-value--hot' : opp.ev > 0.05 ? 'ev-value--warm' : 'ev-value--cold';
  const confPct = opp.confidenceScore != null ? Math.round(opp.confidenceScore * 100) : null;
  const confLevel = confPct != null ? (confPct >= 65 ? 'high' : confPct >= 35 ? 'medium' : 'low') : 'low';
  return `
    <div class="ev-hero-card fade-in">
      <div class="ev-hero-badge">⚡ Mejor oportunidad del día</div>
      <div class="ev-hero-body">
        <div class="ev-hero-match">
          <div class="ev-hero-match-label">${escapeHtml(opp.matchLabel)}</div>
          <div class="ev-hero-match-date">${escapeHtml(opp.kickoffAt ? chileDateTimeLabel(opp.kickoffAt) : '')}</div>
        </div>
        <div class="ev-hero-metrics">
          <div class="ev-hero-metric">
            <span class="ev-hero-metric__value ${evHeat}">${fmtPct(opp.ev)}</span>
            <span class="ev-hero-metric__label">EV</span>
          </div>
          <div class="ev-hero-metric">
            <span class="ev-hero-metric__value">${fmtPct(opp.edge)}</span>
            <span class="ev-hero-metric__label">Edge</span>
          </div>
          <div class="ev-hero-metric">
            <span class="ev-hero-metric__value">${opp.decimalOdds ? fmtNum(opp.decimalOdds) : '—'}</span>
            <span class="ev-hero-metric__label">Cuota</span>
          </div>
          <div class="ev-hero-metric">
            <span class="ev-hero-metric__value">${fmtPct(opp.kellyFraction)}</span>
            <span class="ev-hero-metric__label">Kelly%</span>
          </div>
        </div>
        <div class="ev-hero-tags">
          <span class="chip chip--warn">${escapeHtml(opp.marketCode || '1X2')}</span>
          <span class="chip chip--blue">${escapeHtml(opp.selectionLabel || opp.selectionCode || '—')}</span>
          ${confPct != null ? `<div class="confidence-ring" data-level="${confLevel}" title="Confidence: ${confPct}%">${confPct}</div>` : ''}
        </div>
      </div>
    </div>`;
}

function evOpportunityRow(opp) {
  const isOutlier = (opp.ev != null && opp.ev > 0.40) || opp.blockReasons.includes('EV_OUTLIER');
  const rowClass = isOutlier ? 'ev-row--blocked'
    : opp.decisionStatus === 'BETTABLE' ? 'ev-row--bettable'
    : opp.decisionStatus === 'PAPER_ONLY' ? 'ev-row--paper'
    : 'ev-row--blocked';

  const evHeat = opp.ev != null
    ? (opp.ev > 0.05 ? 'ev-value--hot' : opp.ev > 0.02 ? 'ev-value--warm' : 'ev-value--cold')
    : 'ev-value--cold';
  const edgeHeat = opp.edge != null
    ? (opp.edge > 0.05 ? 'ev-value--hot' : opp.edge > 0.02 ? 'ev-value--warm' : opp.edge < 0 ? 'ev-value--neg' : 'ev-value--cold')
    : '';

  const confPct = opp.confidenceScore != null ? Math.round(opp.confidenceScore * 100) : null;
  const confLevel = confPct != null ? (confPct >= 65 ? 'high' : confPct >= 35 ? 'medium' : 'low') : 'low';

  const kickoff = opp.kickoffAt ? chileDateTimeLabel(opp.kickoffAt) : '';
  const fairArrow = opp.fairOdds && opp.decimalOdds
    ? `${fmtNum(opp.fairOdds)} → <b>${fmtNum(opp.decimalOdds)}</b>`
    : opp.fairOdds ? fmtNum(opp.fairOdds) : '—';
  const overlay = opp.fairOdds && opp.decimalOdds && opp.edge != null
    ? `<br><span class="ev-overlay ${edgeHeat}">${opp.edge >= 0 ? '+' : ''}${fmtPct(opp.edge)}</span>`
    : '';

  return `
    <tr class="ev-row ${rowClass} fade-in">
      <td class="ev-td-match">
        <div class="ev-match-label">${escapeHtml(opp.matchLabel)}</div>
        <div class="ev-match-date">${escapeHtml(kickoff)}</div>
      </td>
      <td class="ev-td-market">${escapeHtml(opp.marketCode || '—')}</td>
      <td class="ev-td-sel"><b>${escapeHtml(opp.selectionLabel || opp.selectionCode || '—')}</b></td>
      <td class="ev-td-num">${opp.modelProb != null ? `<b>${fmtPct(opp.modelProb)}</b>` : '—'}</td>
      <td class="ev-td-num ev-market-prob">${opp.marketProb != null ? fmtPct(opp.marketProb) : '—'}</td>
      <td class="ev-td-odds">${fairArrow}${overlay}</td>
      <td class="ev-td-num ${edgeHeat}">${opp.edge != null ? `${opp.edge >= 0 ? '+' : ''}${(opp.edge * 100).toFixed(1)}pp` : '—'}</td>
      <td class="ev-td-num ${evHeat}">${opp.ev != null ? fmtPct(opp.ev) : '—'}${isOutlier ? ' <span class="chip chip--muted" title="EV outlier — modelo descalibrado">OUTLIER</span>' : ''}</td>
      <td class="ev-td-num">${opp.kellyFraction != null ? `${fmtPct(opp.kellyFraction)}<br><span class="ev-kelly-label">${opp.decisionStatus === 'BETTABLE' ? 'BETTABLE' : opp.decisionStatus === 'PAPER_ONLY' ? 'PAPER' : 'BLOCK'}</span>` : '—'}</td>
      <td class="ev-td-num">${confPct != null ? `<div class="confidence-ring" data-level="${confLevel}" title="Confidence: ${confPct}%">${confPct}</div>` : '—'}</td>
    </tr>`;
}

function evSummaryBar(opportunities, blocked) {
  const bettable = opportunities.filter((o) => o.decisionStatus === 'BETTABLE').length;
  const paper = opportunities.filter((o) => o.decisionStatus === 'PAPER_ONLY').length;
  const evList = opportunities.map((o) => o.ev).filter((e) => e != null && !isNaN(e));
  const avgEV = evList.length ? evList.reduce((a, b) => a + b, 0) / evList.length : null;
  const kellyList = opportunities.map((o) => o.kellyFraction).filter((k) => k != null && !isNaN(k));
  const avgKelly = kellyList.length ? kellyList.reduce((a, b) => a + b, 0) / kellyList.length : null;
  const confList = opportunities.map((o) => o.confidenceScore).filter((c) => c != null);
  const avgConf = confList.length ? confList.reduce((a, b) => a + b, 0) / confList.length : null;

  const cards = [
    { label: 'EV+ activos', value: opportunities.length, cls: `metric-card--hero${opportunities.length ? ' metric-card--blue' : ''}` },
    { label: 'Bettable', value: bettable, cls: bettable ? 'metric-card--ok' : '' },
    { label: 'Paper', value: paper, cls: paper ? 'metric-card--warn' : '' },
    { label: 'Bloqueados', value: blocked.length, cls: '' },
    { label: 'EV promedio', value: avgEV != null ? fmtPct(avgEV) : '—', cls: avgEV > 0 ? 'metric-card--ok' : '' },
    { label: 'Kelly prom.', value: avgKelly != null ? fmtPct(avgKelly) : '—', cls: '' },
    { label: 'Confianza', value: avgConf != null ? fmtPct(avgConf) : '—', cls: avgConf != null && avgConf >= 0.6 ? 'metric-card--ok' : avgConf != null && avgConf >= 0.3 ? 'metric-card--warn' : '' },
  ];
  return `<div class="ev-summary-bar">${cards.map((c) => `
    <div class="metric-card ${c.cls}">
      <div class="metric-card__value">${escapeHtml(String(c.value))}</div>
      <div class="metric-card__label">${escapeHtml(c.label)}</div>
    </div>`).join('')}</div>`;
}

function blockReasonsSection(blocked) {
  if (!blocked.length) return quantEmptyState('🔒', 'Sin bloqueos activos', 'No hay decisiones bloqueadas en este momento.');
  const counts = {};
  blocked.forEach((b) => b.blockReasons.forEach((r) => { counts[r] = (counts[r] || 0) + 1; }));
  const chips = Object.entries(counts).map(([reason, count]) => `
    <button class="block-chip-btn" data-reason="${escapeHtml(reason)}" type="button">
      ${escapeHtml(BLOCK_REASON_LABELS[reason] || reason)}
      <span class="chip-count">${count}</span>
    </button>`).join('');
  return `<div class="block-chips">${chips}</div>`;
}

let _blockTooltip = null;

function attachBlockChipTooltips(container) {
  if (!_blockTooltip) {
    _blockTooltip = document.createElement('div');
    _blockTooltip.className = 'block-tooltip';
    document.body.appendChild(_blockTooltip);
  }
  const tooltip = _blockTooltip;
  container.querySelectorAll('.block-chip-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const reason = btn.dataset.reason;
      const desc = BLOCK_REASON_DESC[reason] || reason;
      tooltip.innerHTML = `<strong>${escapeHtml(BLOCK_REASON_LABELS[reason] || reason)}</strong>${escapeHtml(desc)}`;
      const rect = btn.getBoundingClientRect();
      tooltip.style.top = `${rect.bottom + 6 + window.scrollY}px`;
      tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 296))}px`;
      tooltip.classList.toggle('visible');
      e.stopPropagation();
    });
  });
  document.addEventListener('click', () => tooltip.classList.remove('visible'), { once: false });
}

async function renderEV(options = {}) {
  if (!options.silent) {
    root.innerHTML = `<div class="ev-view"><div class="loading-head"><span>Cargando EV+</span><i></i></div></div>`;
  }
  let rawOpps = [], rawBlocked = [];
  try {
    const [oppsData, blockedData] = await Promise.all([
      cached('ev/opportunities', { limit: 50 }, 60000, options),
      cached('ev/blocked', { limit: 50 }, 60000, options),
    ]);
    rawOpps = oppsData.opportunities || [];
    rawBlocked = blockedData.blocked || [];
  } catch (error) {
    if (error.name === 'AbortError') return;
    root.innerHTML = `<div class="ev-view"><div class="error">${escapeHtml(error.message)}</div></div>`;
    return;
  }

  const opportunities = rawOpps.map(adaptEVOpportunity);
  const blocked = rawBlocked.map(adaptBlockedDecision);

  setStatus('EV+', `${opportunities.length} oportunidades`);

  const positiveEV = opportunities.filter((o) => (o.ev ?? 0) > 0);
  const negativeEV = opportunities.filter((o) => (o.ev ?? 0) <= 0 && o.decisionStatus !== 'BLOCKED');

  const EV_TABLE_HEAD = `<thead><tr class="ev-thead-row">
    <th>PARTIDO</th><th>MERCADO</th><th>SELECCIÓN</th>
    <th title="Probabilidad del modelo">MODELO</th>
    <th title="Probabilidad implícita de mercado">MERCADO</th>
    <th>CUOTA JUSTA → LIBRO</th>
    <th title="Edge = Prob.modelo – Prob.mercado">EDGE</th>
    <th title="EV = Prob.modelo × cuota – 1">EV</th>
    <th>KELLY%</th>
    <th title="Confidence score del modelo (0-100)">CONF.</th>
  </tr></thead>`;

  const oppsHtml = positiveEV.length
    ? `<div class="ev-table-wrap"><table class="ev-table">${EV_TABLE_HEAD}<tbody>${positiveEV.map(evOpportunityRow).join('')}</tbody></table></div>`
    : quantEmptyState('📊', 'Sin oportunidades EV+', 'El pipeline no encontró edge positivo en el mercado actual. Las oportunidades aparecen cuando el modelo ve valor vs las odds del libro.');

  const overpricedHtml = negativeEV.length
    ? `<div class="ev-table-wrap"><table class="ev-table">${EV_TABLE_HEAD}<tbody>${negativeEV.map((o) => evOpportunityRow({ ...o, decisionStatus: 'BLOCKED' })).join('')}</tbody></table></div>`
    : quantEmptyState('✅', 'Sin mercados sobrepreciados', 'No hay selecciones con EV negativo en este momento.');

  const calibrationNote = positiveEV.length && positiveEV.every((o) => o.predictionStatus === 'RAW_ONLY')
    ? quantEmptyState('🔬', 'Modelo RAW_ONLY', 'El modelo aún no está calibrado. Se necesitan 30+ picks settled para calibrar. Las oportunidades mostradas son paper-only.')
    : '';

  const bestOpp = positiveEV.length ? positiveEV.reduce((a, b) => ((b.ev ?? 0) > (a.ev ?? 0) ? b : a)) : null;

  root.innerHTML = `
    <div class="ev-view">
      ${evSummaryBar(opportunities, blocked)}
      ${evHeroCard(bestOpp)}
      ${calibrationNote}
      <section>
        <div class="ev-section-title">▲ Oportunidades con Edge</div>
        ${oppsHtml}
      </section>
      <section>
        <div class="ev-section-title">▼ Mercado Sobrepreciado</div>
        ${overpricedHtml}
      </section>
      <section>
        <div class="ev-section-title">🔒 Razones de Bloqueo</div>
        ${blockReasonsSection(blocked)}
      </section>
    </div>`;

  attachBlockChipTooltips(root);
}

// ─── Model view ────────────────────────────────────────────────────────────

const FEATURE_HEALTH = [
  { key: 'elo',      label: 'ELO ratings',        status: 'ok',      freshness: 'Diario',   coverage: '100%', detail: 'ELO Global, Internacional y Doméstico calculados incrementalmente' },
  { key: 'form',     label: 'Forma reciente',      status: 'ok',      freshness: 'Diario',   coverage: '100%', detail: 'Últimos 5 partidos: puntos, diferencia de goles' },
  { key: 'odds',     label: 'Odds / Mercado',      status: 'ok',      freshness: 'Variable', coverage: '80%',  detail: 'Cuotas pre-kickoff capturadas. Sin API key: odds del bootstrap Excel' },
  { key: 'lineups',  label: 'Lineups confirmados', status: 'pending', freshness: '—',        coverage: '0%',   detail: 'Pendiente: integración con fuente de alineaciones (Phase 2)' },
  { key: 'weather',  label: 'Clima / Condiciones', status: 'ok',      freshness: 'Diario',   coverage: '100%', detail: 'Google News RSS activo, sin API key requerida' },
  { key: 'xg',       label: 'xG histórico',        status: 'pending', freshness: '—',        coverage: '0%',   detail: 'Pendiente: fuente de datos xG (Phase 2)' },
  { key: 'news',     label: 'Noticias / Lesiones', status: 'ok',      freshness: 'Diario',   coverage: '100%', detail: 'Google News RSS activo' },
];

function featureHealthGrid() {
  return `<div class="feature-health-grid">${FEATURE_HEALTH.map((f) => {
    const dotCls = f.status === 'ok' ? 'health-dot--ok' : f.status === 'partial' ? 'health-dot--partial' : 'health-dot--pending';
    const chipCls = f.status === 'ok' ? 'chip--ok' : f.status === 'partial' ? 'chip--warn' : 'chip--muted';
    const chipLabel = f.status === 'ok' ? 'OK' : f.status === 'partial' ? 'Parcial' : 'Pendiente';
    return `
      <div class="feature-health-item" title="${escapeHtml(f.detail)}">
        <span class="health-dot ${dotCls}"></span>
        <div class="feature-health-meta">
          <span class="feature-health-name">${escapeHtml(f.label)}</span>
          <span class="feature-health-sub">${escapeHtml(f.freshness)} · ${escapeHtml(f.coverage)}</span>
        </div>
        <span class="chip ${chipCls}" style="margin-left:auto;font-size:.62rem;flex-shrink:0">${chipLabel}</span>
      </div>`;
  }).join('')}</div>`;
}

function feedbackTimeline() {
  const steps = [
    { icon: '🎯', label: 'Predicción' },
    { icon: '⚽', label: 'Partido' },
    { icon: '📋', label: 'Resultado' },
    { icon: '💰', label: 'EV real' },
    { icon: '📈', label: 'CLV' },
    { icon: '🔬', label: 'Calibración' },
    { icon: '🧠', label: 'Aprende' },
  ];
  return `<div class="feedback-timeline">${steps.map((s, i) => `
    <div class="tl-step">
      <div class="tl-dot">${s.icon}</div>
      <div class="tl-label">${escapeHtml(s.label)}</div>
    </div>
    ${i < steps.length - 1 ? '<span class="tl-arrow">→</span>' : ''}`).join('')}</div>`;
}

function modelStatusCards(diagnostics) {
  if (!diagnostics.length) return quantEmptyState('🤖', 'Sin modelos registrados', 'El pipeline aún no ha registrado ningún modelo.');
  const champion = diagnostics.find((d) => d.champion_status === 'CHAMPION') || diagnostics[0];
  const cards = [
    { label: 'Modelo activo', value: champion.model_name || '—', cls: 'metric-card--blue' },
    { label: 'Versión', value: champion.model_version || '—', cls: '' },
    { label: 'Familia', value: champion.model_family || '—', cls: '' },
    { label: 'Predicciones', value: champion.prediction_count ?? 0, cls: '' },
    { label: 'Corridas', value: champion.run_count ?? 0, cls: '' },
    { label: 'Drift severo', value: champion.severe_drift_reports ?? 0, cls: (champion.severe_drift_reports ?? 0) > 0 ? 'metric-card--danger' : '' },
  ];
  return `<div class="metric-grid">${cards.map((c) => `
    <div class="metric-card ${c.cls}">
      <div class="metric-card__value">${escapeHtml(String(c.value))}</div>
      <div class="metric-card__label">${escapeHtml(c.label)}</div>
    </div>`).join('')}</div>`;
}

function calibrationSummaryText(calibration) {
  if (!calibration.length) return quantEmptyState('🔬', 'Sin calibración', 'El modelo aún es RAW_ONLY. Se necesitan 30+ picks settled para calibrar.');
  const latest = calibration[0];
  const n = latest.sample_size ?? 0;
  const lowN = n < 30;
  return `
    <div class="cal-summary-row">
      <span>ECE: <b>${fmtNum(latest.ece, 4)}</b></span>
      <span>Brier: <b>${fmtNum(latest.brier_score, 4)}</b></span>
      <span>Método: <b>${escapeHtml(latest.method || '—')}</b></span>
      <span>n: <b>${n}</b></span>
    </div>
    ${lowN ? '<div class="cal-warn">⚠️ Datos insuficientes — calibration chart disponible en Stats cuando n ≥ 30</div>' : ''}
    <p style="font-size:.78rem;color:var(--muted);margin:.6rem 0 0">Si el modelo dice 40%, debería ocurrir ~40% de las veces (ver Stats para gráfico completo)</p>`;
}

function calibrationProgressBar(calibration) {
  const settled = calibration.length ? (calibration[0].n_settled ?? calibration[0].sample_size ?? calibration[0].total_predictions ?? 0) : 0;
  const target = 30;
  const pct = Math.min(100, Math.round((settled / target) * 100));
  const ready = settled >= target;
  return `
    <div class="cal-progress-wrap">
      <div class="cal-progress-header">
        <span class="cal-progress-title">Progreso de calibración</span>
        <span class="cal-progress-count${ready ? ' cal-progress-count--ready' : ''}">${settled}/${target} picks settled</span>
      </div>
      <div class="cal-progress-track">
        <div class="cal-progress-fill${ready ? ' cal-progress-fill--ready' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="cal-progress-note">${ready ? '✓ Modelo listo para calibración automática' : `Faltan ${target - settled} picks resueltos para calibrar el modelo`}</div>
    </div>`;
}

function whatDoesThisMeanSection() {
  return `
    <div class="what-means-section">
      <h3 class="what-means-title">¿Qué significa todo esto?</h3>
      <div class="what-means-grid">
        <div class="what-means-item">
          <span class="what-means-icon">📊</span>
          <div>
            <strong>EV (Expected Value)</strong>
            <p>Si el modelo dice 40% y la cuota implica 30%, hay +10pp de edge. EV = prob_modelo × cuota_decimal − 1. EV positivo = valor a largo plazo.</p>
          </div>
        </div>
        <div class="what-means-item">
          <span class="what-means-icon">🎯</span>
          <div>
            <strong>Kelly%</strong>
            <p>Fracción óptima del bankroll a apostar según Kelly Criterion. Usamos Kelly×25% para reducir varianza. Nunca apostar el Kelly completo.</p>
          </div>
        </div>
        <div class="what-means-item">
          <span class="what-means-icon">⚖️</span>
          <div>
            <strong>Calibración</strong>
            <p>Un modelo calibrado que dice 60% gana ~60% del tiempo. Sin calibración, el EV puede estar sesgado. Se necesitan 30+ picks para calibrar.</p>
          </div>
        </div>
        <div class="what-means-item">
          <span class="what-means-icon">🔒</span>
          <div>
            <strong>PAPER vs BETTABLE</strong>
            <p>PAPER = modelo aún no calibrado, solo seguimiento virtual. BETTABLE = modelo calibrado y confianza suficiente para apuesta real.</p>
          </div>
        </div>
      </div>
    </div>`;
}

async function renderModel(options = {}) {
  if (!options.silent) {
    root.innerHTML = `<div class="model-view"><div class="loading-head"><span>Cargando Modelo</span><i></i></div></div>`;
  }
  let diagnostics = [], calibration = [];
  try {
    const [diagData, calData] = await Promise.all([
      cached('model/diagnostics', {}, 120000, options),
      cached('calibration/summary', { limit: 5 }, 120000, options),
    ]);
    diagnostics = diagData.models || [];
    calibration = calData.calibration || [];
  } catch (error) {
    if (error.name === 'AbortError') return;
    root.innerHTML = `<div class="model-view"><div class="error">${escapeHtml(error.message)}</div></div>`;
    return;
  }

  setStatus('Modelo', `${diagnostics.length} modelos`);

  root.innerHTML = `
    <div class="model-view">
      <section class="model-section">
        <h3>Estado del Modelo</h3>
        ${modelStatusCards(diagnostics)}
        ${calibrationProgressBar(calibration)}
      </section>
      <section class="model-section">
        <h3>Calibración</h3>
        ${calibrationSummaryText(calibration)}
      </section>
      <section class="model-section">
        <h3>Feature Health</h3>
        ${featureHealthGrid()}
      </section>
      <section class="model-section">
        <h3>Feedback Loop</h3>
        <p style="font-size:.78rem;color:var(--muted);margin:0 0 .8rem">Así aprende el sistema de cada partido:</p>
        ${feedbackTimeline()}
      </section>
      ${whatDoesThisMeanSection()}
    </div>`;
}

// ─── Stats view ─────────────────────────────────────────────────────────────

function destroyChart(id) {
  const existing = Chart.getChart(id);
  if (existing) existing.destroy();
}

function calibrationBucketChart(calibrationData) {
  const id = 'cal-bucket-chart';
  const bins = Array.from({ length: 10 }, (_, i) => `${i * 10}-${i * 10 + 10}%`);
  if (!calibrationData.length) return `<div class="chart-wrap">${quantEmptyState('📊', 'Sin datos de calibración', 'Se necesitan 30+ picks settled.')}</div>`;
  return `
    <div class="chart-wrap">
      <canvas id="${id}"></canvas>
    </div>
    <p style="font-size:.74rem;color:var(--muted);margin:.4rem 0 0">Barras = tasa observada. Línea = predicha. La diagonal perfecta = calibración ideal.</p>`;
}

function initCalibrationChart(calibrationData) {
  destroyChart('cal-bucket-chart');
  const canvas = document.getElementById('cal-bucket-chart');
  if (!canvas || !calibrationData.length || typeof Chart === 'undefined') return;
  const bins = Array.from({ length: 10 }, (_, i) => `${i * 10}-${i * 10 + 10}%`);
  const predicted = bins.map((_, i) => (i * 10 + 5) / 100);
  const observed = bins.map(() => null);
  new Chart(canvas, {
    data: {
      labels: bins,
      datasets: [
        { type: 'bar', label: 'Tasa observada', data: observed, backgroundColor: 'rgba(53,194,255,.45)', borderColor: 'rgba(53,194,255,.8)', borderWidth: 1 },
        { type: 'line', label: 'Calibración perfecta', data: predicted, borderColor: 'rgba(244,197,66,.8)', borderDash: [4, 4], borderWidth: 2, pointRadius: 0, fill: false },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#9fb0c3', font: { size: 11 } } } }, scales: { y: { min: 0, max: 1, ticks: { color: '#9fb0c3', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.06)' } }, x: { ticks: { color: '#9fb0c3', font: { size: 9 } }, grid: { display: false } } } },
  });
}

function roiByEvChart(buckets) {
  const id = 'roi-ev-chart';
  if (!buckets.length) return `<div class="chart-wrap">${quantEmptyState('📊', 'Sin datos', 'Se necesitan picks settled para calcular ROI por EV.')}</div>`;
  return `<div class="chart-wrap"><canvas id="${id}"></canvas></div>`;
}

function initRoiChart(buckets) {
  destroyChart('roi-ev-chart');
  const canvas = document.getElementById('roi-ev-chart');
  if (!canvas || !buckets.length || typeof Chart === 'undefined') return;
  const labels = buckets.map((b) => b.ev_bucket);
  const roiData = buckets.map((b) => b.roi_pct ?? 0);
  const colors = roiData.map((v) => v >= 0 ? 'rgba(30,215,96,.6)' : 'rgba(255,99,117,.6)');
  new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'ROI %', data: roiData, backgroundColor: colors, borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#9fb0c3', font: { size: 10 }, callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,.06)' } }, x: { ticks: { color: '#9fb0c3', font: { size: 10 } }, grid: { display: false } } } },
  });
}

function picksByStatusChart(decisions) {
  const id = 'picks-donut-chart';
  const counts = decisions.reduce((acc, d) => { acc[d.decision_status] = (acc[d.decision_status] || 0) + 1; return acc; }, {});
  if (!Object.keys(counts).length) return `<div class="chart-wrap">${quantEmptyState('🍩', 'Sin picks', 'No hay decisiones registradas aún.')}</div>`;
  return `<div class="chart-wrap"><canvas id="${id}"></canvas></div>`;
}

function initPicksDonut(decisions) {
  destroyChart('picks-donut-chart');
  const canvas = document.getElementById('picks-donut-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const counts = decisions.reduce((acc, d) => { acc[d.decision_status] = (acc[d.decision_status] || 0) + 1; return acc; }, {});
  const STATUS_COLORS = { BETTABLE: '#1ed760', PAPER_ONLY: '#f4c542', NO_EDGE: '#6f8399', BLOCKED: '#3d4f61' };
  const labels = Object.keys(counts);
  new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: labels.map((l) => counts[l]), backgroundColor: labels.map((l) => STATUS_COLORS[l] || '#3d4f61'), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#9fb0c3', font: { size: 11 }, padding: 12 } } } },
  });
}

function statsKpiBar(calibration, buckets) {
  const latest = calibration[0] || {};
  const totalROI = buckets.length ? buckets.reduce((s, b) => s + (b.roi_pct ?? 0) * (b.settled_count ?? 0), 0) / Math.max(1, buckets.reduce((s, b) => s + (b.settled_count ?? 0), 0)) : null;
  const cards = [
    { label: 'Brier Score', value: fmtNum(latest.brier_score, 4), cls: '' },
    { label: 'Log Loss', value: fmtNum(latest.log_loss, 4), cls: '' },
    { label: 'ECE', value: fmtNum(latest.ece, 4), cls: '' },
    { label: 'ROI prom.', value: totalROI != null ? `${fmtNum(totalROI, 1)}%` : '—', cls: totalROI > 0 ? 'metric-card--ok' : totalROI < 0 ? 'metric-card--danger' : '' },
    { label: 'Picks n', value: latest.sample_size ?? 0, cls: '' },
  ];
  return `<div class="kpi-bar">${cards.map((c) => `
    <div class="metric-card ${c.cls}">
      <div class="metric-card__value">${escapeHtml(String(c.value))}</div>
      <div class="metric-card__label">${escapeHtml(c.label)}</div>
    </div>`).join('')}</div>`;
}

function statsRoadmapEmpty() {
  return `
    <div class="stats-roadmap">
      <div class="stats-roadmap-header">
        <span class="stats-roadmap-icon">🗺️</span>
        <div>
          <strong>Stats disponibles cuando haya picks resueltos</strong>
          <p>Las métricas históricas y gráficos aparecen automáticamente una vez que los partidos predichos terminen y se liquiden.</p>
        </div>
      </div>
      <div class="stats-roadmap-steps">
        <div class="stats-roadmap-step stats-roadmap-step--done">
          <span class="stats-step-dot stats-step-dot--done">✓</span>
          <div><strong>Modelo activo</strong><small>Pipeline corriendo, predicciones generadas</small></div>
        </div>
        <div class="stats-roadmap-step stats-roadmap-step--done">
          <span class="stats-step-dot stats-step-dot--done">✓</span>
          <div><strong>EV calculado</strong><small>Decisiones de apuesta calculadas</small></div>
        </div>
        <div class="stats-roadmap-step stats-roadmap-step--active">
          <span class="stats-step-dot stats-step-dot--active">→</span>
          <div><strong>Picks en juego</strong><small>Esperando que terminen los partidos predichos</small></div>
        </div>
        <div class="stats-roadmap-step">
          <span class="stats-step-dot">◯</span>
          <div><strong>Settlement automático</strong><small>Resultados registrados y picks liquidados</small></div>
        </div>
        <div class="stats-roadmap-step">
          <span class="stats-step-dot">◯</span>
          <div><strong>Stats y calibración</strong><small>Brier score, ROI, calibration chart disponibles</small></div>
        </div>
      </div>
    </div>`;
}

async function renderStats(options = {}) {
  if (!options.silent) {
    root.innerHTML = `<div class="stats-view"><div class="loading-head"><span>Cargando Stats</span><i></i></div></div>`;
  }
  let calibration = [], buckets = [], decisions = [];
  try {
    const [calData, roiData, bankData] = await Promise.all([
      cached('calibration/summary', { limit: 5 }, 120000, options),
      cached('stats/roi-by-ev', {}, 120000, options),
      cached('stats/bankroll', { limit: 200 }, 120000, options),
    ]);
    calibration = calData.calibration || [];
    buckets = roiData.buckets || [];
    decisions = bankData.decisions || [];
  } catch (error) {
    if (error.name === 'AbortError') return;
    root.innerHTML = `<div class="stats-view"><div class="error">${escapeHtml(error.message)}</div></div>`;
    return;
  }

  setStatus('Stats', `${decisions.length} picks`);

  const hasData = decisions.length > 0 || calibration.length > 0;

  root.innerHTML = `
    <div class="stats-view">
      ${!hasData ? statsRoadmapEmpty() : `
      <section class="stats-section">
        <h3>KPIs del Modelo</h3>
        ${statsKpiBar(calibration, buckets)}
      </section>
      <section class="stats-section">
        <h3>Calibración (bucket chart)</h3>
        ${calibrationBucketChart(calibration)}
      </section>
      <section class="stats-section">
        <h3>ROI por Rango de EV</h3>
        ${roiByEvChart(buckets)}
      </section>
      <section class="stats-section">
        <h3>Picks por Estado</h3>
        ${picksByStatusChart(decisions)}
      </section>`}
    </div>`;

  // Init charts after DOM painted (only if data exists)
  if (hasData) setTimeout(() => {
    initCalibrationChart(calibration);
    initRoiChart(buckets);
    initPicksDonut(decisions);
  }, 0);
}

// ─── News view ───────────────────────────────────────────────────────────────

function newsArticleCard(article) {
  const title = escapeHtml(article.title || '');
  const source = escapeHtml(article.source || '');
  const url = article.url || '#';
  const pub = article.published_at ? timeLabel(article.published_at) : '';
  const team = article.home_team || article.away_team
    ? `<span class="news-team-tag">${escapeHtml(article.home_team || article.away_team)}</span>`
    : '';
  return `<a class="news-article" href="${url}" target="_blank" rel="noopener noreferrer">
    <div class="news-article__header">${team}<span class="news-article__meta">${source}${pub ? ` · ${pub}` : ''}</span></div>
    <span class="news-article__title">${title}</span>
    <span class="news-article__link">Leer más →</span>
  </a>`;
}

async function renderNews(options = {}) {
  root.innerHTML = skeletonCards(3);

  let matches = [];
  try {
    const resp = await apiGet('web/news', {}, options.signal);
    matches = resp?.matches_news || [];
  } catch (e) {
    if (e.name === 'AbortError') return;
  }

  if (!matches.length) {
    root.innerHTML = `<div class="quant-empty"><p>No hay partidos hoy para mostrar noticias.</p></div>`;
    return;
  }

  const matchBlocks = matches.map(m => {
    const aiChip = m.ai_context_used
      ? `<span class="chip chip--ai" title="La IA usó estas noticias en su pronóstico">IA activa</span>`
      : '';
    const articlesHtml = (m.news || []).length
      ? `<div class="news-grid">${(m.news || []).map(newsArticleCard).join('')}</div>`
      : `<p class="news-empty">Sin noticias — se sincronizarán mañana a las 6 AM.</p>`;

    return `<section class="news-match-block fade-in">
      <div class="news-match-header">
        <span class="news-match-teams">${escapeHtml(m.home_team)} <span class="news-vs">vs</span> ${escapeHtml(m.away_team)}</span>
        <div class="news-match-meta">
          <span class="chip chip--muted">${timeLabel(m.kickoff_at)}</span>
          ${aiChip}
        </div>
      </div>
      ${articlesHtml}
    </section>`;
  });

  root.innerHTML = `
    <div class="news-view">
      <div class="news-header">
        <h2 class="section-title">Noticias del día</h2>
        <p class="news-subtitle">Noticias sincronizadas cada mañana desde Google News vía GAS.
          Las marcadas con <strong style="color:var(--ai)">IA activa</strong>
          fueron consideradas en los pronósticos del modelo.</p>
      </div>
      ${matchBlocks.join('')}
    </div>`;
}

async function render(options = {}) {
  const seq = ++state.renderSeq;
  if (state.activeController) state.activeController.abort();
  state.activeController = new AbortController();
  const renderOptions = { ...options, signal: state.activeController.signal };
  try {
    await ensureLayout(renderOptions);
    updateTabs();
    if (state.view === 'standings') { hideDateFilterBar(); await renderStandings(renderOptions); }
    else if (state.view === 'teams') { hideDateFilterBar(); await renderTeams(renderOptions); }
    else if (state.view === 'knockout') { hideDateFilterBar(); await renderKnockout(renderOptions); }
    else if (state.view === 'ev') { hideDateFilterBar(); await renderEV(renderOptions); }
    else if (state.view === 'model') { hideDateFilterBar(); await renderModel(renderOptions); }
    else if (state.view === 'stats') { hideDateFilterBar(); await renderStats(renderOptions); }
    else if (state.view === 'news') { hideDateFilterBar(); await renderNews(renderOptions); }
    else await renderToday(renderOptions);
  } catch (error) {
    if (error.name === 'AbortError' || seq !== state.renderSeq) return;
    if (String(error.message) !== 'Unauthorized') errorState(error);
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.hidden) return;
    if (state.view === button.dataset.view) return;
    state.view = button.dataset.view;
    updateTabs();
    render();
  });
});

$('#refresh-btn').addEventListener('click', () => {
  state.cache.clear();
  state.layout = null;
  render();
});

function refreshSilently() {
  if (document.hidden) return;
  if (!state.layout) return;
  const quantPaths = { ev: 'ev/opportunities', model: 'model/diagnostics', stats: 'calibration/summary' };
  const path = quantPaths[state.view] || (state.view === 'standings' ? 'web/standings' : state.view === 'teams' ? 'web/teams' : state.view === 'knockout' ? 'web/knockout' : 'web/matches-overview');
  invalidateViewCache(path);
  render({ silent: true });
}

if (AUTO_REFRESH_MS > 0) {
  state.refreshTimer = window.setInterval(refreshSilently, AUTO_REFRESH_MS);
}

render();
