const CFG = window.MATCH_ALPHA_CONFIG || {};
const API_BASE_URL = String(CFG.API_BASE_URL || '').replace(/\/+$/, '');
const SEASON = new URLSearchParams(location.search).get('season') || CFG.DEFAULT_SEASON || 'wc2026';
const KEY_STORAGE = CFG.KEY_STORAGE || 'match_alpha_web_key';
const AUTO_REFRESH_MS = Number(CFG.AUTO_REFRESH_MS || 30000);
const CHILE_TIMEZONE = 'America/Santiago';
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || CHILE_TIMEZONE;
const BROWSER_LANG = (navigator.language || 'en').toLowerCase().split('-')[0];

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
  tournamentView: null,
  tableStage: null,
  matchday: null,
  hasLive: false,
  eloRatingType: 'INTERNATIONAL',
  teamsFilters: {
    search: '',
    sort: 'name',
    group: '',
    status: '',
    country: '',
    continent: '',
  },
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
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// Coerce API values to finite numbers before interpolating into HTML.
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Only allow absolute http(s) URLs in hrefs coming from the API.
function safeUrl(value) {
  try {
    const url = new URL(String(value || ''), location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '#';
  } catch {
    return '#';
  }
}

// Decorative emoji/icon: hidden from assistive tech.
function deco(icon) {
  return `<span aria-hidden="true">${escapeHtml(icon)}</span>`;
}

function isLiveStatus(status) {
  return ['IN_PROGRESS', 'IN_PLAY', 'LIVE', 'HT', 'PAUSED'].includes(String(status || '').toUpperCase());
}

function isFinishedStatus(status) {
  return ['FINISHED', 'FT', 'AET', 'PEN'].includes(String(status || '').toUpperCase());
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
  if (team?.flag_asset) {
    const src = safeUrl(team.flag_asset);
    if (src !== '#') return `<img class="flag-img" src="${escapeHtml(src)}" alt="" loading="lazy">`;
  }
  if (team?.flag_emoji) return deco(team.flag_emoji);
  return team?.is_placeholder ? '<span class="placeholder-icon" aria-hidden="true">◇</span>' : deco('🏳️');
}

function layoutKeyToView(key) {
  return {
    matches: 'today',
    standings: 'standings',
    teams: 'teams',
    tournament: 'tournament',
    bracket: 'tournament',
    knockout: 'tournament',
    elo: 'elo',
    news: 'news',
    ev: 'ev',
    model: 'model',
    stats: 'stats',
  }[key] || key;
}

// Generic, format-agnostic fallback (F3.8): one table + a match list.
// Used only when the layout API is unreachable.
function fallbackLayout() {
  return {
    _fallback: true,
    capabilities: {
      has_groups: false,
      has_league_table: true,
      has_knockout: false,
      has_standings: true,
      has_teams: true,
      has_tournament: true,
      has_elo: true,
    },
    ui: {
      default_view: 'matches',
      navigation: [
        { key: 'matches', label: 'Partidos', enabled: true, order: 10 },
        { key: 'standings', label: 'Posiciones', enabled: true, order: 20 },
        { key: 'teams', label: 'Equipos', enabled: true, order: 30 },
        { key: 'tournament', label: 'Torneo', enabled: true, order: 40 },
        { key: 'news', label: 'Noticias', enabled: true, order: 50 },
        { key: 'elo', label: 'ELO', enabled: true, order: 60 },
        { key: 'ev', label: 'EV+', enabled: true, order: 70 },
        { key: 'model', label: 'Modelo', enabled: true, order: 80 },
        { key: 'stats', label: 'Stats', enabled: true, order: 90 },
      ],
    },
    tournament_views: [
      { key: 'table', label: 'Tabla', render_mode: 'GENERIC', enabled: true, order: 10 },
      { key: 'fixtures', label: 'Fechas', render_mode: 'MATCH_LIST', enabled: true, order: 20 },
    ],
    stages: [],
  };
}

async function ensureLayout(options = {}) {
  if (state.layout && !options.forceLayoutRefresh) return state.layout;
  try {
    state.layout = await cached(`competitions/${SEASON}/layout`, {}, 300000, options);
  } catch (error) {
    console.warn('No se pudo cargar layout de competencia, usando fallback local.', error?.message || error);
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

function tournamentViewDefinitions() {
  const fromLayout = (state.layout?.tournament_views || [])
    .filter((item) => item && item.enabled !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if (fromLayout.length) return fromLayout;
  return fallbackLayout().tournament_views || [];
}

function applyCompetitionLayout() {
  const navByView = {};
  for (const item of navigationItems()) {
    const view = layoutKeyToView(item.key);
    // Keep first item by order to avoid legacy aliases (e.g. bracket) overriding tournament labels.
    if (!navByView[view]) navByView[view] = item;
  }
  for (const fallback of fallbackLayout().ui.navigation) {
    const view = layoutKeyToView(fallback.key);
    if (!navByView[view] && ['ev', 'model', 'stats', 'news'].includes(view)) {
      navByView[view] = fallback;
    }
  }
    document.querySelectorAll('.tab').forEach((button) => {
    const item = navByView[button.dataset.view];
    button.hidden = !item;
    if (item?.label) button.textContent = item.label;
  });
  if (!navByView[state.view]) {
    const defaultView = layoutKeyToView(state.layout?.ui?.default_view || navigationItems()[0]?.key || 'matches');
    state.view = navByView[defaultView] ? defaultView : layoutKeyToView(navigationItems()[0]?.key || 'matches');
  }
  // Set initial knockout stage from first bracket stage in layout
  if (!state.knockoutStage) {
    state.knockoutStage = knockoutStageDefinitions()[0]?.key || null;
  }
  // Sync competition label to league picker button
  const compName = competitionLabel();
  if (compName && compName !== SEASON) {
    const labelEl = document.getElementById('league-picker-label');
    if (labelEl && labelEl.textContent !== compName) labelEl.textContent = compName;
  }
}

const KNOCKOUT_VIEW_TYPES = ['BRACKET_ROUND', 'TWO_LEG_TIE'];

function knockoutStageDefinitions() {
  const layoutStages = state.layout?.stages || [];
  const stages = layoutStages
    .filter((stage) => KNOCKOUT_VIEW_TYPES.includes(String(stage.view_type || '').toUpperCase()))
    .sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0))
    .map((stage) => {
      const viewType = String(stage.view_type || 'BRACKET_ROUND').toUpperCase();
      const legs = num(stage.rules?.legs, viewType === 'TWO_LEG_TIE' ? 2 : 1) || 1;
      const matchCount = num(stage.expected_match_count || stage.match_count || stage.rules?.expected_matches);
      return {
        key: stage.stage_code || stage.stage_name,
        title: stage.stage_label || stage.stage_name || stage.stage_code || 'Eliminatoria',
        count: matchCount,
        legs,
        // Slots in the bracket = ties, not matches.
        slots: legs > 1 ? Math.ceil(matchCount / legs) : matchCount,
        viewType,
      };
    })
    .filter((stage) => stage.key);
  if (stages.length) return stages;
  if (state.layout && !state.layout._fallback && (state.layout.stages || []).length) return [];
  return _FALLBACK_KNOCKOUT_STAGES.map((stage) => ({ ...stage, legs: 1, slots: stage.count, viewType: 'BRACKET_ROUND' }));
}

function layoutStage(key) {
  return (state.layout?.stages || []).find((s) => (s.stage_code || s.stage_name) === key) || null;
}

const REQUEST_TIMEOUT_MS = 30000;

// Combines the caller's abort signal with a timeout. Uses AbortSignal.timeout/any
// when available and falls back to a manual setTimeout + AbortController.
function requestSignal(outerSignal, timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout && (AbortSignal.any || !outerSignal)) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = outerSignal ? AbortSignal.any([timeoutSignal, outerSignal]) : timeoutSignal;
    return { signal, cancel: () => {}, timedOut: () => timeoutSignal.aborted };
  }
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => { clearTimeout(timer); outerSignal?.removeEventListener('abort', onAbort); },
    timedOut: () => expired,
  };
}

async function apiGet(path, params = {}, options = {}) {
  if (!API_BASE_URL || API_BASE_URL.includes('tu-worker')) throw new Error('Configura API_BASE_URL en js/config.js');
  const url = new URL(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`);
  url.searchParams.set('season', SEASON);
  url.searchParams.set('timezone', BROWSER_TIMEZONE);
  url.searchParams.set('lang', BROWSER_LANG || 'en');
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const key = savedKey();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  // 30-second timeout so the page doesn't freeze when Render backend is waking up
  const { signal, cancel, timedOut } = requestSignal(options.signal, REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (err) {
    if (err.name === 'TimeoutError' || timedOut()) {
      const te = new Error('Servidor despertando: tardó demasiado en responder. Intenta de nuevo en unos segundos.');
      te.name = 'TimeoutError';
      throw te;
    }
    throw err;
  } finally {
    cancel();
  }
  const json = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearKey();
    renderLogin('Clave de lectura inválida o no configurada.');
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
    if (active && button.id) root.setAttribute('aria-labelledby', button.id);
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
  const waking = error?.name === 'TimeoutError';
  const title = waking ? 'Servidor despertando' : 'No se pudo cargar';
  root.innerHTML = `
    <div class="error" role="alert">
      <strong>${escapeHtml(title)}</strong>
      <div>${escapeHtml(error?.message || error)}</div>
      <div class="error-actions"><button type="button" class="retry-btn" data-retry>Reintentar</button></div>
    </div>`;
  root.querySelector('[data-retry]')?.addEventListener('click', () => render());
}

function emptyState(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function matchPenalties(match) {
  const meta = match?.metadata && typeof match.metadata === 'object' ? match.metadata : {};
  const pen = meta.penalties && typeof meta.penalties === 'object' ? meta.penalties : {};
  const home = match?.home_penalty_score ?? match?.penalty_home ?? match?.home_penalties ?? pen.home;
  const away = match?.away_penalty_score ?? match?.penalty_away ?? match?.away_penalties ?? pen.away;
  if (home === null || home === undefined || away === null || away === undefined) return null;
  return { home: num(home), away: num(away) };
}

function matchScore(match) {
  const homeScore = match.home_score ?? match.home?.score;
  const awayScore = match.away_score ?? match.away?.score;
  if (homeScore === null || homeScore === undefined || awayScore === null || awayScore === undefined) return '<div class="score pending">vs</div>';
  const pen = matchPenalties(match);
  const regular = `<div class="score">${num(homeScore)}<span>-</span>${num(awayScore)}</div>`;
  if (!pen) return regular;
  return `${regular}<div class="score-penalties">Pen: ${pen.home}-${pen.away}</div>`;
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
  const temp = weather.temperature_c ?? weather.temperature ?? weather.temp_c ?? weather.temp;
  const humidity = weather.humidity_pct ?? weather.humidity;
  const wind = weather.wind_kph ?? weather.wind_speed;
  const rain = weather.chance_of_rain;
  if (temp !== null && temp !== undefined) parts.push(`${Number(temp).toFixed(1)}°C`);
  if (rain !== null && rain !== undefined) parts.push(`${Number(rain).toFixed(0)}% lluvia`);
  else if (humidity !== null && humidity !== undefined) parts.push(`${Number(humidity).toFixed(0)}% hum`);
  if (wind !== null && wind !== undefined) parts.push(`${Number(wind).toFixed(0)} km/h`);
  // Label distinguishes forecast (at kickoff) vs current conditions
  const label = weather.forecast_type === 'kickoff_hour' ? 'Pronóstico al inicio' : '';
  const labelHtml = label ? `<span class="weather-label">${escapeHtml(label)}</span>` : '';
  return parts.length ? `<div class="weather">${labelHtml}<span aria-hidden="true">${weatherIcon(weather.condition)}</span>${escapeHtml(parts.join(' · '))}</div>` : '';
}

function venueDetailHtml(match) {
  if (!match.venue) return '<div class="venue">Sede por definir</div>';
  const main = [match.venue.display_name, match.venue.city].filter(Boolean).join(', ');
  const local = localVenueTimeLabel(match);
  return `<div class="venue">${deco('📍')} ${escapeHtml(main)}${local ? ` · ${escapeHtml(local)}` : ''}</div>`;
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
  const isLive = isLiveStatus(match.status);
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
    return { kickoff_from: range.kickoff_from, kickoff_to: chileOperationalRange(now, 30).kickoff_to };
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
    upcoming_to: chileOperationalRange(now, 30).kickoff_to,
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
            <button class="${state.dateMode === mode ? 'active' : ''}" data-date-mode="${mode}" type="button" role="tab" aria-selected="${state.dateMode === mode ? 'true' : 'false'}" aria-controls="view-root">
              ${deco(icon)}${escapeHtml(label)}
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
  state.hasLive = ['yesterday', 'today', 'tomorrow'].some((mode) => (data[mode] || []).some((m) => isLiveStatus(m.status)));
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
          const hasLive = block.matches.some((m) => isLiveStatus(m.status));
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
// RENDERERS (defined after the knockout helpers) maps a layout render_mode /
// view_type to an async renderer `(ctx) => html`. Unknown modes fall back to
// renderGenericTable / renderMatchList, so no render_mode ends in an error.

const ZONE_LABELS = {
  QUALIFIED: 'Clasificado',
  PLAYOFF: 'Playoff',
  CONTINENTAL_A: 'Copa internacional',
  CONTINENTAL_B: 'Copa internacional (2)',
  RELEGATION_PLAYOFF: 'Liguilla de descenso',
  RELEGATED: 'Descenso',
  ELIMINATED: 'Eliminado',
};

function zoneClass(code) {
  return `zone zone--${String(code).toLowerCase().replace(/_/g, '-')}`;
}

// Zones come from stage.rules.zones when present; otherwise derived from the
// legacy promotion_spots / relegation_spots / qualifies fields.
function zonesFromRules(rules = {}, total = 0, viewType = '', { groupDefault = 0 } = {}) {
  if (Array.isArray(rules.zones) && rules.zones.length) {
    return rules.zones
      .map((zone) => {
        const code = String(zone?.code || '').toUpperCase();
        const safeCode = ZONE_LABELS[code] ? code : 'QUALIFIED';
        return {
          from: num(zone?.from),
          to: num(zone?.to),
          code: safeCode,
          label: String(zone?.label || ZONE_LABELS[safeCode]),
        };
      })
      .filter((zone) => zone.from > 0 && zone.to >= zone.from);
  }
  const zones = [];
  const promote = num(rules.promotion_spots ?? rules.qualifies ?? rules.qualifiers_per_group ?? groupDefault);
  const playoff = num(rules.playoff_spots);
  const relegate = num(rules.relegation_spots);
  if (String(viewType).toUpperCase() === 'LEAGUE_PHASE_TABLE' && !promote && !playoff && total) {
    // UCL-style default: top 8 direct, 9-24 playoff, rest eliminated.
    zones.push({ from: 1, to: Math.min(8, total), code: 'QUALIFIED', label: 'Octavos directo' });
    if (total > 8) zones.push({ from: 9, to: Math.min(24, total), code: 'PLAYOFF', label: 'Playoff' });
    if (total > 24) zones.push({ from: 25, to: total, code: 'ELIMINATED', label: 'Eliminado' });
    return zones;
  }
  if (promote > 0) zones.push({ from: 1, to: promote, code: 'QUALIFIED', label: ZONE_LABELS.QUALIFIED });
  if (playoff > 0) zones.push({ from: promote + 1, to: promote + playoff, code: 'PLAYOFF', label: ZONE_LABELS.PLAYOFF });
  if (relegate > 0 && total > relegate) zones.push({ from: total - relegate + 1, to: total, code: 'RELEGATED', label: ZONE_LABELS.RELEGATED });
  return zones;
}

function zoneForPosition(zones, position) {
  return zones.find((zone) => position >= zone.from && position <= zone.to) || null;
}

function zoneLegendHtml(zones) {
  if (!zones.length) return '';
  return `
    <ul class="zone-legend-bar" aria-label="Leyenda de zonas">
      ${zones.map((zone) => `
        <li class="${zoneClass(zone.code)}">
          <span class="zone-swatch" aria-hidden="true"></span>
          ${escapeHtml(zone.label)}
          <span class="zone-legend-range">(${zone.from === zone.to ? zone.from : `${zone.from}–${zone.to}`})</span>
        </li>`).join('')}
    </ul>`;
}

function _standingsRow(row, index, zone = null) {
  const pos = num(row.position, index + 1) || index + 1;
  const posCls = pos <= 3 ? `standings-row--${pos === 1 ? '1st' : pos === 2 ? '2nd' : '3rd'}` : '';
  const cls = [posCls, zone ? zoneClass(zone.code) : ''].filter(Boolean).join(' ');
  return `
    <tr${cls ? ` class="${cls}"` : ''}>
      <td>${pos}${zone ? `<span class="sr-only"> (${escapeHtml(zone.label)})</span>` : ''}</td>
      <td><strong>${teamFlag(row)} ${escapeHtml(row.team_name || row.display_name || '-')}</strong></td>
      <td><strong>${num(row.points)}</strong></td><td>${num(row.played)}</td><td>${num(row.wins)}</td><td>${num(row.draws)}</td><td>${num(row.losses)}</td><td>${num(row.goals_for)}</td><td>${num(row.goals_against)}</td><td>${num(row.goal_difference)}</td>
    </tr>`;
}

function _standingsTable(rows, zones = []) {
  return `
    <div class="card table-card">
      <table>
        <thead><tr><th>#</th><th>Equipo</th><th>Pts</th><th>J</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DG</th></tr></thead>
        <tbody>${rows.map((row, i) => _standingsRow(row, i, zoneForPosition(zones, num(row.position, i + 1) || i + 1))).join('')}</tbody>
      </table>
    </div>`;
}

function sortStandingRows(rows) {
  return [...rows].sort((a, b) => {
    if (num(b.points) !== num(a.points)) return num(b.points) - num(a.points);
    if (num(b.goal_difference) !== num(a.goal_difference)) return num(b.goal_difference) - num(a.goal_difference);
    return num(b.goals_for) - num(a.goals_for);
  }).map((row, i) => ({ ...row, position: i + 1 }));
}

// Pick the standings groups that belong to a layout stage (layout stage.groups
// lists group ids/codes). Falls back to every group when nothing matches.
function groupsForStage(groups, stage) {
  const refs = new Set((stage?.groups || []).flatMap((g) => [g?.group_id, g?.group_code, typeof g === 'string' ? g : null]).filter(Boolean).map(String));
  if (!refs.size) return groups;
  const filtered = groups.filter((g) => refs.has(String(g.group_id)) || refs.has(String(g.group_code)));
  return filtered.length ? filtered : groups;
}

async function fetchStandingsGroups(options = {}, extraParams = {}) {
  const data = await cached('web/standings', extraParams, 90000, options);
  return data.groups || [];
}

function renderGroupTablesView(groups, stageRules = null) {
  const sorted = [...groups].sort((a, b) => (a.group_order || 0) - (b.group_order || 0));
  return sorted.map((group) => {
    const rows = [...(group.standings || [])].sort((a, b) => num(a.position, 99) - num(b.position, 99));
    // Legacy default of 2 qualifiers only when the layout gives no rules at all.
    const rules = { ...(stageRules || {}), ...(group.rules || {}) };
    const hasRules = stageRules !== null || group.rules;
    const zones = zonesFromRules(rules, rows.length, 'GROUP_TABLES', { groupDefault: hasRules ? 0 : 2 });
    return `
    <section class="group-block fade-in">
      <h2 class="section-title">${escapeHtml(groupLabel(group.group_name))}</h2>
      ${_standingsTable(rows, zones)}
      ${zoneLegendHtml(zones)}
    </section>`;
  }).join('');
}

function renderLeagueTableView(groups, stageRules = {}, viewType = 'LEAGUE_TABLE') {
  const single = groups.length === 1;
  const allRows = groups.flatMap((g) => g.standings || []);
  const hasPositions = single && allRows.every((row) => num(row.position) > 0);
  const sorted = hasPositions
    ? [...allRows].sort((a, b) => num(a.position) - num(b.position))
    : sortStandingRows(allRows);
  const zones = zonesFromRules(stageRules, sorted.length, viewType);
  return `
    <section class="group-block fade-in">
      ${_standingsTable(sorted, zones)}
      ${zoneLegendHtml(zones)}
    </section>`;
}

function aggregateStandings(groupSets) {
  const byTeam = new Map();
  for (const row of groupSets.flat().flatMap((g) => g.standings || [])) {
    const key = row.team_id || row.team_slug || row.team_name;
    if (!key) continue;
    const acc = byTeam.get(key) || { ...row, points: 0, played: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0, goal_difference: 0 };
    for (const field of ['points', 'played', 'wins', 'draws', 'losses', 'goals_for', 'goals_against', 'goal_difference']) {
      acc[field] = num(acc[field]) + num(row[field]);
    }
    byTeam.set(key, acc);
  }
  return sortStandingRows([...byTeam.values()]);
}

// Stage selector for Apertura/Clausura (F3.6).
function tableStageOptions(viewType = 'LEAGUE_TABLE') {
  const stages = (state.layout?.stages || [])
    .filter((s) => String(s.view_type || '').toUpperCase() === viewType)
    .sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0));
  const options = stages.map((s) => ({ key: s.stage_code || s.stage_name, title: s.stage_label || s.stage_name || s.stage_code, stage: s }))
    .filter((o) => o.key);
  const aggregateWith = stages.map((s) => s.rules?.aggregate_with).find(Boolean);
  if (aggregateWith) options.push({ key: '__aggregate', title: 'Acumulada', aggregateWith: String(aggregateWith) });
  return options;
}

function subTabsHtml(items, activeKey, dataAttr, label) {
  return `
    <div class="knockout-tabs stage-selector" role="tablist" aria-label="${escapeHtml(label)}">
      ${items.map((item) => `
        <button class="${item.key === activeKey ? 'active' : ''}" ${dataAttr}="${escapeHtml(item.key)}" type="button" role="tab"
                aria-selected="${item.key === activeKey ? 'true' : 'false'}" aria-controls="tournament-panel">
          ${escapeHtml(item.title)}
        </button>`).join('')}
    </div>`;
}

async function renderLeagueTableMode(ctx) {
  const viewType = String(ctx.viewType || 'LEAGUE_TABLE').toUpperCase();
  const options = tableStageOptions(viewType);
  const groups = await fetchStandingsGroups(ctx.options);
  if (!options.length) {
    return renderLeagueTableView(groups, {}, viewType) || emptyState('No hay tabla disponible.');
  }
  if (!state.tableStage || !options.some((o) => o.key === state.tableStage)) state.tableStage = options[0].key;
  const selected = options.find((o) => o.key === state.tableStage) || options[0];
  const selector = options.length > 1 ? subTabsHtml(options, selected.key, 'data-table-stage', 'Etapa') : '';
  let body;
  if (selected.key === '__aggregate') {
    let sibling = [];
    try {
      sibling = await fetchStandingsGroups(ctx.options, { season: selected.aggregateWith });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
    }
    const rows = aggregateStandings([groups, sibling]);
    const baseRules = options[0]?.stage?.rules || {};
    const zones = zonesFromRules(baseRules.aggregate_zones ? { zones: baseRules.aggregate_zones } : {}, rows.length, viewType);
    body = rows.length
      ? `<section class="group-block fade-in">${_standingsTable(rows, zones)}${zoneLegendHtml(zones)}
          ${sibling.length ? '' : '<p class="layout-notice">No se pudo cargar la otra etapa; se muestra solo la actual.</p>'}</section>`
      : emptyState('No hay tabla acumulada disponible.');
  } else {
    const stageGroups = groupsForStage(groups, selected.stage);
    body = stageGroups.length
      ? renderLeagueTableView(stageGroups, selected.stage?.rules || {}, viewType)
      : emptyState('No hay tabla disponible.');
  }
  return `${selector}${body}`;
}

async function renderGroupTablesMode(ctx) {
  const groups = await fetchStandingsGroups(ctx.options);
  const stage = stageDefinitionsByViewType('GROUP_TABLES')[0];
  const layoutStageDef = stage ? layoutStage(stage.key) : null;
  const stageGroups = groupsForStage(groups, layoutStageDef);
  setStatus('Torneo', `${stageGroups.length} grupos`);
  return renderGroupTablesView(stageGroups, layoutStageDef ? (layoutStageDef.rules || {}) : null) || emptyState('No hay grupos disponibles.');
}

async function renderLeaguePhaseMode(ctx) {
  return renderLeagueTableMode({ ...ctx, viewType: 'LEAGUE_PHASE_TABLE' });
}

// Generic fallback: a table if standings exist, otherwise the match list.
async function renderGenericTable(ctx) {
  let groups = [];
  try {
    groups = await fetchStandingsGroups(ctx.options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
  }
  const hasRows = groups.some((g) => (g.standings || []).length);
  if (!hasRows) return renderMatchList(ctx);
  return groups.length > 1 ? renderGroupTablesView(groups) : renderLeagueTableView(groups);
}

// ─── Match list / "Fechas" (F3.4) ─────────────────────────────────────────────

function matchdayOf(match) {
  const md = match.matchday ?? match.round_number ?? match.metadata?.matchday ?? match.metadata?.round;
  if (md !== null && md !== undefined && md !== '') {
    // Provider round text such as "Regular Season - 12" (API-Football) → matchday 12.
    const suffix = typeof md === 'string' && !/^round of/i.test(md.trim()) ? md.trim().match(/(\d+)$/) : null;
    const n = suffix ? Number(suffix[1]) : Number(md);
    return Number.isFinite(n)
      ? { key: `md-${n}`, label: `Fecha ${n}`, sort: n }
      : { key: `md-${String(md)}`, label: String(md), sort: Number.MAX_SAFE_INTEGER - 1 };
  }
  const day = match.kickoff_at ? ymd(new Date(match.kickoff_at)) : 'sin-fecha';
  return {
    key: `day-${day}`,
    label: match.kickoff_at
      ? new Date(match.kickoff_at).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: CHILE_TIMEZONE })
      : 'Sin fecha',
    sort: match.kickoff_at ? new Date(match.kickoff_at).getTime() : Number.MAX_SAFE_INTEGER,
  };
}

async function renderMatchList(ctx) {
  const data = await cached('web/matches', {}, 90000, ctx.options);
  let matches = data.matches || data.items || [];
  const stageCode = ctx.stageCode;
  if (stageCode) {
    const filtered = matches.filter((m) => m.stage_code === stageCode || m.source_stage_code === stageCode);
    if (filtered.length) matches = filtered;
  }
  if (!matches.length) return emptyState(`Sin partidos${ctx.stageTitle ? ` para ${ctx.stageTitle}` : ''}.`);

  const days = new Map();
  for (const match of matches) {
    const md = matchdayOf(match);
    if (!days.has(md.key)) days.set(md.key, { ...md, matches: [] });
    days.get(md.key).matches.push(match);
  }
  const ordered = [...days.values()].sort((a, b) => a.sort - b.sort);
  if (!state.matchday || !days.has(state.matchday)) {
    const current = ordered.find((d) => d.matches.some((m) => !isFinishedStatus(m.status))) || ordered[ordered.length - 1];
    state.matchday = current.key;
  }
  const index = ordered.findIndex((d) => d.key === state.matchday);
  const active = ordered[index];
  active.matches.sort((a, b) => (a.kickoff_at || '') < (b.kickoff_at || '') ? -1 : 1);
  setStatus('Torneo', `${active.label} · ${active.matches.length} partidos`);
  return `
    <div class="matchday-pager">
      <button type="button" data-matchday-step="-1" ${index > 0 ? '' : 'disabled'} aria-label="Fecha anterior">‹</button>
      <label class="sr-only" for="matchday-select">Seleccionar fecha</label>
      <select id="matchday-select" data-matchday-select>
        ${ordered.map((d) => `<option value="${escapeHtml(d.key)}" ${d.key === active.key ? 'selected' : ''}>${escapeHtml(d.label)} (${d.matches.length})</option>`).join('')}
      </select>
      <button type="button" data-matchday-step="1" ${index < ordered.length - 1 ? '' : 'disabled'} aria-label="Fecha siguiente">›</button>
    </div>
    <section class="kickoff-block fade-in" data-matchday-keys="${escapeHtml(ordered.map((d) => d.key).join('|'))}">
      <header class="kickoff-header"><span class="kickoff-time">${escapeHtml(active.label)}</span></header>
      <div class="grid">${active.matches.map(matchCard).join('')}</div>
    </section>`;
}

function attachMatchdayHandlers(rerender) {
  const select = root.querySelector('[data-matchday-select]');
  if (!select) return;
  const keys = [...select.options].map((o) => o.value);
  select.addEventListener('change', () => { state.matchday = select.value; rerender(); });
  root.querySelectorAll('[data-matchday-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = keys[keys.indexOf(state.matchday) + Number(btn.dataset.matchdayStep)];
      if (!next) return;
      state.matchday = next;
      rerender();
    });
  });
}

function qualificationStatusLabel(value) {
  const status = String(value || 'PENDING').toUpperCase();
  return {
    QUALIFIED_GROUP_WINNER: 'Clasificado',
    QUALIFIED_GROUP_RUNNER_UP: 'Clasificado',
    QUALIFIED_BEST_THIRD: 'Clasificado',
    THIRD_PLACE_CANDIDATE: 'Pendiente',
    PENDING_TIEBREAKER: 'Pendiente',
    PENDING: 'Pendiente',
    ELIMINATED: 'Eliminado',
  }[status] || status;
}

function standingsGlobalHtml(rows) {
  const tableRows = rows.map((row) => `
    <tr>
      <td><strong>${row.global_position != null ? num(row.global_position) : '-'}</strong></td>
      <td><strong>${teamFlag(row)} ${escapeHtml(row.team_name || '-')}</strong></td>
      <td>${escapeHtml(groupLabel(row.group_name || row.group_code || row.stage_name || row.stage_code || ''))}</td>
      <td><strong>${num(row.points)}</strong></td>
      <td>${num(row.played)}</td>
      <td>${num(row.wins)}</td>
      <td>${num(row.draws)}</td>
      <td>${num(row.losses)}</td>
      <td>${num(row.goals_for)}</td>
      <td>${num(row.goals_against)}</td>
      <td>${num(row.goal_difference)}</td>
      <td><span class="chip chip--muted">${escapeHtml(qualificationStatusLabel(row.status))}</span></td>
    </tr>`).join('');

  const cards = rows.map((row) => `
    <article class="card standings-global-card fade-in">
      <header>
        <strong>#${row.global_position != null ? num(row.global_position) : '-'}</strong>
        <span class="chip chip--muted">${escapeHtml(qualificationStatusLabel(row.status))}</span>
      </header>
      <div class="team-head" style="margin:.35rem 0 .25rem">
        <div class="flag">${teamFlag(row)}</div>
        <div>
          <h3 style="margin:0;font-size:.95rem">${escapeHtml(row.team_name || '-')}</h3>
          <p style="margin:0;color:var(--muted);font-size:.72rem">${escapeHtml(groupLabel(row.group_name || row.group_code || row.stage_name || row.stage_code || ''))}</p>
        </div>
      </div>
      <div class="stats-line">
        <div class="stat"><b>${num(row.points)}</b><span>PTS</span></div>
        <div class="stat"><b>${num(row.played)}</b><span>J</span></div>
        <div class="stat"><b>${num(row.goals_for)}</b><span>GF</span></div>
        <div class="stat"><b>${num(row.goal_difference)}</b><span>DG</span></div>
      </div>
    </article>`).join('');

  return `
    <section class="view-section fade-in">
      <div class="card table-card standings-global-table-wrap">
        <table class="standings-global-table">
          <thead><tr><th>#</th><th>Equipo</th><th>Grupo/Stage</th><th>PTS</th><th>J</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DG</th><th>Estado</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div class="standings-global-cards">${cards}</div>
    </section>`;
}

async function renderStandings(options = {}) {
  if (!options.silent) loading('Posiciones');
  // Prefer the stage-appropriate table (league / league phase) when the layout defines one.
  const tableType = ['LEAGUE_PHASE_TABLE', 'LEAGUE_TABLE'].find((vt) => stageDefinitionsByViewType(vt).length);
  if (tableType) {
    const html = await RENDERERS[tableType]({ options, viewType: tableType });
    setStatus('Posiciones', stageDefinitionsByViewType(tableType)[0]?.title || 'Tabla');
    root.innerHTML = `<div class="tournament-body" id="tournament-panel">${html}</div>`;
    root.querySelectorAll('[data-table-stage]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.tableStage === state.tableStage) return;
        state.tableStage = button.dataset.tableStage;
        renderStandings({ localOnly: true });
      });
    });
    return;
  }
  const data = await cached(`competitions/${SEASON}/standings/global`, {}, 90000, options);
  const rows = data.teams || [];
  setStatus('Posiciones', `${rows.length} equipos`);
  root.innerHTML = rows.length ? standingsGlobalHtml(rows) : emptyState('No hay posiciones globales disponibles.');
}

function teamCatalogCard(team) {
  const teamSlug = team.slug || team.team_slug;
  const teamId = team.team_id || team.id;
  return `
    <article class="card team-card clickable-card fade-in" data-team-slug="${escapeHtml(teamSlug || '')}" data-team-id="${escapeHtml(teamId || '')}" tabindex="0">
      <div class="team-card-top">
        <div class="team-head">
          <div class="flag">${teamFlag(team)}</div>
          <div>
            <h3>${escapeHtml(team.display_name || team.team_name)}</h3>
            <p>${escapeHtml(groupLabel(team.group_name || team.group_code || team.stage_name || ''))}</p>
          </div>
        </div>
        <strong class="points-pill">#${team.global_position ? num(team.global_position) : '-'} · ${num(team.points)} pts</strong>
      </div>
      <div class="team-rating">ELO <b>${team.elo_rating != null ? Number(team.elo_rating).toFixed(0) : '-'}</b></div>
      <div class="stats-line">
        <div class="stat"><b>${team.played ?? 0}</b><span>J</span></div>
        <div class="stat"><b>${team.goals_for ?? 0}</b><span>GF</span></div>
        <div class="stat"><b>${team.goal_difference ?? 0}</b><span>DG</span></div>
        <div class="stat"><b>${team.roster_count ?? 0}</b><span>Plantel</span></div>
      </div>
      <div style="margin-top:.55rem;display:flex;justify-content:space-between;align-items:center;gap:.5rem">
        <span class="chip chip--muted">${escapeHtml(qualificationStatusLabel(team.status))}</span>
        <small style="color:var(--muted)">${escapeHtml(team.country_code || '')}</small>
      </div>
    </article>`;
}

function teamsFilterControls(data) {
  const af = data.available_filters || {};
  const makeOptions = (items, current, label) => {
    const opts = [`<option value="">${label}</option>`]
      .concat((items || []).map((item) => `<option value="${escapeHtml(item)}" ${item === current ? 'selected' : ''}>${escapeHtml(item)}</option>`));
    return opts.join('');
  };
  return `
    <section class="view-section fade-in">
      <div class="card teams-filter-card">
        <div class="teams-filter-grid">
          <input id="teams-search" type="search" placeholder="Buscar equipo" value="${escapeHtml(state.teamsFilters.search)}">
          <select id="teams-sort">
            <option value="name" ${state.teamsFilters.sort === 'name' ? 'selected' : ''}>A-Z</option>
            <option value="position" ${state.teamsFilters.sort === 'position' ? 'selected' : ''}>Posición</option>
            <option value="points" ${state.teamsFilters.sort === 'points' ? 'selected' : ''}>Puntos</option>
            <option value="elo" ${state.teamsFilters.sort === 'elo' ? 'selected' : ''}>ELO</option>
          </select>
          <select id="teams-group">${makeOptions(af.groups, state.teamsFilters.group, 'Grupo/Stage')}</select>
          <select id="teams-status">${makeOptions(af.statuses, state.teamsFilters.status, 'Estado')}</select>
          <select id="teams-country">${makeOptions(af.countries, state.teamsFilters.country, 'País')}</select>
          <select id="teams-continent">${makeOptions(af.continents, state.teamsFilters.continent, 'Continente')}</select>
        </div>
      </div>
    </section>`;
}

async function renderTeams(options = {}) {
  if (!options.silent) loading('Equipos');
  const params = {
    search: state.teamsFilters.search || undefined,
    sort: state.teamsFilters.sort || 'name',
    group: state.teamsFilters.group || undefined,
    status: state.teamsFilters.status || undefined,
    country: state.teamsFilters.country || undefined,
    continent: state.teamsFilters.continent || undefined,
  };
  const data = await cached(`competitions/${SEASON}/teams`, params, 90000, options);
  const teams = data.teams || [];
  setStatus('Equipos', `${teams.length} equipos`);

  root.innerHTML = `
    ${teamsFilterControls(data)}
    <section class="view-section">
      <div class="grid team-grid">${teams.map(teamCatalogCard).join('')}</div>
    </section>
  `;
  if (!teams.length) {
    root.innerHTML += emptyState('No hay equipos para los filtros aplicados.');
  }

  const rerenderWithFilters = () => {
    state.teamsFilters.search = (document.getElementById('teams-search')?.value || '').trim();
    state.teamsFilters.sort = document.getElementById('teams-sort')?.value || 'name';
    state.teamsFilters.group = document.getElementById('teams-group')?.value || '';
    state.teamsFilters.status = document.getElementById('teams-status')?.value || '';
    state.teamsFilters.country = document.getElementById('teams-country')?.value || '';
    state.teamsFilters.continent = document.getElementById('teams-continent')?.value || '';
    renderTeams({ localOnly: true });
  };

  const searchInput = document.getElementById('teams-search');
  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(rerenderWithFilters, 220);
    });
  }
  ['teams-sort', 'teams-group', 'teams-status', 'teams-country', 'teams-continent'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', rerenderWithFilters);
  });

  root.querySelectorAll('[data-team-slug]').forEach((card) => {
    card.addEventListener('click', () => {
      const slug = card.dataset.teamSlug;
      const teamId = card.dataset.teamId;
      if (!slug && !teamId) return;
      openTeamModal({ teamSlug: slug, teamId });
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const slug = card.dataset.teamSlug;
      const teamId = card.dataset.teamId;
      if (!slug && !teamId) return;
      openTeamModal({ teamSlug: slug, teamId });
    });
  });
}

async function openTeamModal({ teamSlug, teamId } = {}) {
  if (!teamSlug && !teamId) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card"><div class="loading-head"><span>Cargando equipo</span><i></i></div>${skeletonCards(2)}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal(overlay);
  });
  try {
    const params = teamSlug ? { team_slug: teamSlug } : { team_id: teamId };
    const detail = await cached('web/team-detail', params, 60000);
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

// ─── Knockout: bracket rounds + two-legged ties (F3.3) ────────────────────────

function teamKey(team) {
  return String(team?.team_id || team?.id || team?.slug || team?.display_name || team?.slot_label || '');
}

function teamName(team) {
  return team?.display_name || team?.slot_label || 'Por definir';
}

// Group matches of a stage into ties: by tie_id when present, otherwise by the
// unordered pair of teams in the same stage. Single matches become 1-leg ties.
function groupTies(matches) {
  const ties = new Map();
  for (const match of matches) {
    const pair = [teamKey(match.home), teamKey(match.away)];
    const key = match.tie_id
      ? `tie-${match.tie_id}`
      : (pair[0] && pair[1] ? `pair-${pair.sort().join('|')}` : `match-${match.match_id || match.id || ties.size}`);
    if (!ties.has(key)) ties.set(key, { key, legs: [] });
    ties.get(key).legs.push(match);
  }
  return [...ties.values()].map((tie) => {
    tie.legs.sort((a, b) => (num(a.leg_number, 0) - num(b.leg_number, 0)) || ((a.kickoff_at || '') < (b.kickoff_at || '') ? -1 : 1));
    const first = tie.legs[0];
    // Team A = home side of leg 1.
    tie.teamA = first.home;
    tie.teamB = first.away;
    tie.aggregate = tieAggregate(tie);
    tie.winner = tieWinner(tie);
    tie.penalties = tie.legs.map(matchPenalties).filter(Boolean).pop() || null;
    tie.kickoff_at = first.kickoff_at;
    return tie;
  }).sort((a, b) => ((a.kickoff_at || '') < (b.kickoff_at || '') ? -1 : 1));
}

function tieAggregate(tie) {
  const last = tie.legs[tie.legs.length - 1];
  const aKey = teamKey(tie.teamA);
  if (last?.aggregate && last.aggregate.home != null && last.aggregate.away != null) {
    // aggregate is expressed from the perspective of that leg's home team.
    const lastHomeIsA = teamKey(last.home) === aKey;
    return lastHomeIsA
      ? { a: num(last.aggregate.home), b: num(last.aggregate.away) }
      : { a: num(last.aggregate.away), b: num(last.aggregate.home) };
  }
  let a = 0;
  let b = 0;
  let scored = 0;
  for (const leg of tie.legs) {
    if (leg.home_score == null || leg.away_score == null) continue;
    scored += 1;
    if (teamKey(leg.home) === aKey) { a += num(leg.home_score); b += num(leg.away_score); }
    else { a += num(leg.away_score); b += num(leg.home_score); }
  }
  return scored ? { a, b } : null;
}

function tieWinner(tie) {
  const winnerId = tie.legs.map((l) => l.tie_winner_team_id).find(Boolean)
    || (tie.legs.length === 1 ? tie.legs[0].winner_team_id : null);
  if (winnerId) {
    if (String(tie.teamA?.team_id || tie.teamA?.id) === String(winnerId)) return tie.teamA;
    if (String(tie.teamB?.team_id || tie.teamB?.id) === String(winnerId)) return tie.teamB;
  }
  const done = tie.legs.every((l) => isFinishedStatus(l.status));
  if (!done || !tie.aggregate) return null;
  if (tie.aggregate.a > tie.aggregate.b) return tie.teamA;
  if (tie.aggregate.b > tie.aggregate.a) return tie.teamB;
  return null;
}

function tieCard(tie) {
  if (tie.legs.length === 1 && !tie.legs[0].leg_number) return knockoutCard(tie.legs[0]);
  const legRow = (leg, i) => {
    const hasScore = leg.home_score != null && leg.away_score != null;
    const score = hasScore ? `${num(leg.home_score)}-${num(leg.away_score)}` : 'vs';
    const legNo = num(leg.leg_number, i + 1) || i + 1;
    const pen = matchPenalties(leg);
    return `
      <div class="tie-leg">
        <span class="tie-leg-label">${legNo === 1 ? 'Ida' : legNo === 2 ? 'Vuelta' : `Partido ${legNo}`}</span>
        <span>${escapeHtml(teamShortName(leg.home))} <b>${escapeHtml(score)}</b> ${escapeHtml(teamShortName(leg.away))}${pen ? ` <small>(pen ${pen.home}-${pen.away})</small>` : ''}</span>
        <span>${escapeHtml(leg.kickoff_at ? dateLabel(leg.kickoff_at).toLowerCase() : 'Por definir')}</span>
      </div>`;
  };
  const agg = tie.aggregate;
  return `
    <article class="card bracket-card tie-card fade-in">
      <div class="bracket-team">${teamFlag(tie.teamA)} <strong>${escapeHtml(teamName(tie.teamA))}</strong></div>
      <div class="bracket-team">${teamFlag(tie.teamB)} <strong>${escapeHtml(teamName(tie.teamB))}</strong></div>
      <div class="tie-legs">${tie.legs.map(legRow).join('')}</div>
      <div class="tie-aggregate">
        <span>Global <strong>${agg ? `${agg.a}-${agg.b}` : '—'}</strong>${tie.penalties ? ` · Pen ${tie.penalties.home}-${tie.penalties.away}` : ''}</span>
        ${tie.winner ? `<span class="tie-winner">Avanza: ${escapeHtml(teamName(tie.winner))}</span>` : ''}
      </div>
    </article>`;
}

function tieBracketNode(tie) {
  if (tie.legs.length === 1) return bracketNodeCard(tie.legs[0]);
  const agg = tie.aggregate;
  const aWin = tie.winner && teamKey(tie.winner) === teamKey(tie.teamA);
  const bWin = tie.winner && teamKey(tie.winner) === teamKey(tie.teamB);
  const live = tie.legs.some((l) => isLiveStatus(l.status));
  return `
    <div class="bracket-node${live ? ' bracket-node--live' : ''}">
      <div class="bracket-node-team${aWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamFlag(tie.teamA)}</span>
        <span class="bracket-node-name">${escapeHtml(teamName(tie.teamA))}</span>
        ${agg ? `<span class="bracket-node-score${aWin ? ' bracket-node-score--win' : ''}">${agg.a}</span>` : ''}
      </div>
      <div class="bracket-node-divider"></div>
      <div class="bracket-node-team${bWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamFlag(tie.teamB)}</span>
        <span class="bracket-node-name">${escapeHtml(teamName(tie.teamB))}</span>
        ${agg ? `<span class="bracket-node-score${bWin ? ' bracket-node-score--win' : ''}">${agg.b}</span>` : ''}
      </div>
      <div class="bracket-node-agg">Global${tie.penalties ? ` · pen ${tie.penalties.home}-${tie.penalties.away}` : ''}</div>
    </div>`;
}

function isTwoLegStage(stage, matches) {
  return stage.viewType === 'TWO_LEG_TIE' || stage.legs > 1 || matches.some((m) => m.tie_id || m.leg_number);
}

async function renderBracketMode(ctx) {
  const stages = knockoutStageDefinitions();
  if (!stages.length) return renderMatchList(ctx);
  const data = await cached('web/knockout', {}, 90000, ctx.options);
  const matches = data.matches || [];
  setStatus('Torneo', `${matches.length} partidos`);
  const byStage = matches.reduce((acc, match) => {
    const key = knockoutStageKey(match);
    (acc[key] ||= []).push(match);
    return acc;
  }, {});
  if (!state.knockoutStage || !stages.some((s) => s.key === state.knockoutStage)) {
    state.knockoutStage = stages.find((s) => byStage[s.key]?.length)?.key || stages[0].key;
  }
  const active = stages.find((stage) => stage.key === state.knockoutStage) || stages[0];
  const activeMatches = byStage[active.key] || [];
  const activeIndex = stages.findIndex((s) => s.key === active.key);
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex < stages.length - 1;
  const countFor = (stage) => num((byStage[stage.key] || []).length || stage.count);

  return `
    <div class="knockout-view fade-in">
      <div class="bracket-tree-wrap">
        ${renderBracketTree(byStage, stages)}
      </div>
      <div class="knockout-mobile-view">
        <div class="knockout-stage-header">
          <button class="knockout-nav-btn${hasPrev ? '' : ' disabled'}" data-dir="-1" ${hasPrev ? '' : 'disabled'} aria-label="Etapa anterior">‹</button>
          <div class="knockout-stage-info">
            <h2 class="knockout-stage-title">${escapeHtml(String(active.title).toUpperCase())}</h2>
            <span class="knockout-stage-count">${countFor(active)} partidos</span>
          </div>
          <button class="knockout-nav-btn${hasNext ? '' : ' disabled'}" data-dir="1" ${hasNext ? '' : 'disabled'} aria-label="Etapa siguiente">›</button>
        </div>
        <div class="knockout-tabs" role="tablist" aria-label="Fases eliminatorias">
          ${stages.map((stage) => `
            <button class="${stage.key === active.key ? 'active' : ''}" data-knockout-stage="${escapeHtml(stage.key)}" type="button" role="tab"
                    aria-selected="${stage.key === active.key ? 'true' : 'false'}" aria-controls="knockout-panel">
              ${escapeHtml(stage.title)}
              <span>${countFor(stage)}</span>
            </button>`).join('')}
        </div>
        <div id="knockout-panel" role="tabpanel">${knockoutColumn(active, activeMatches)}</div>
      </div>
    </div>`;
}

function renderBracketTree(byStage, stages) {
  const rounds = stages.filter((s) => !['GROUP_STAGE', 'LEAGUE_PHASE'].includes(s.key));
  if (!rounds.length) return '';
  const slotsOf = (stage) => {
    const stageMatches = byStage[stage.key] || [];
    return isTwoLegStage(stage, stageMatches) ? groupTies(stageMatches) : stageMatches.map((m) => ({ legs: [m] }));
  };
  const maxSlots = Math.max(...rounds.map((s) => Math.max(num(s.slots || s.count), slotsOf(s).length, 1)), 1);
  const NODE_H = 64;
  const NODE_GAP = 6;
  const bracketH = maxSlots * (NODE_H + NODE_GAP);
  return `
    <div class="bracket-tree">
      <div class="bracket-rounds" style="--bracket-height:${num(bracketH)}px">
        ${rounds.map((stage) => {
          const items = slotsOf(stage);
          const total = Math.max(num(stage.slots || stage.count), items.length, 1);
          const nodes = Array.from({ length: total }, (_, i) => items[i] || null);
          return `
            <div class="bracket-round">
              <div class="bracket-round-label">${escapeHtml(stage.title)}</div>
              <div class="bracket-round-slots">
                ${nodes.map((item) => item ? tieBracketNode(item) : `
                  <div class="bracket-node bracket-node--placeholder">
                    <div class="bracket-node-team">
                      <span class="placeholder-icon" aria-hidden="true">◇</span>
                      <span class="bracket-node-name" style="color:var(--faint);font-style:italic">Por definir</span>
                    </div>
                    <div class="bracket-node-divider"></div>
                    <div class="bracket-node-team">
                      <span class="placeholder-icon" aria-hidden="true">◇</span>
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
  const isLive = isLiveStatus(match.status);
  const hasScore = match.home_score != null && match.away_score != null;
  const homeWin = hasScore && num(match.home_score) > num(match.away_score);
  const awayWin = hasScore && num(match.away_score) > num(match.home_score);
  const dateStr = match.kickoff_at ? dateLabel(match.kickoff_at).toLowerCase() : '';
  const timeStr = match.kickoff_at ? timeLabel(match.kickoff_at) : '';
  return `
    <div class="bracket-node${isLive ? ' bracket-node--live' : ''}">
      ${dateStr ? `<div class="bracket-node-date">${escapeHtml(dateStr)} · ${escapeHtml(timeStr)} CL</div>` : ''}
      <div class="bracket-node-team${homeWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamFlag(match.home)}</span>
        <span class="bracket-node-name">${escapeHtml(match.home?.display_name || match.home?.slot_label || '?')}</span>
        ${hasScore ? `<span class="bracket-node-score${homeWin ? ' bracket-node-score--win' : ''}">${num(match.home_score)}</span>` : ''}
      </div>
      <div class="bracket-node-divider"></div>
      <div class="bracket-node-team${awayWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamFlag(match.away)}</span>
        <span class="bracket-node-name">${escapeHtml(match.away?.display_name || match.away?.slot_label || '?')}</span>
        ${hasScore ? `<span class="bracket-node-score${awayWin ? ' bracket-node-score--win' : ''}">${num(match.away_score)}</span>` : ''}
      </div>
    </div>`;
}

function knockoutColumn(stage, matches) {
  const twoLeg = isTwoLegStage(stage, matches);
  const slots = Math.max(num(twoLeg ? stage.slots : stage.count), 1);
  let cards;
  if (!matches.length) {
    cards = Array.from({ length: slots }).map((_, index) => placeholderKnockoutCard(stage, index + 1)).join('');
  } else if (twoLeg) {
    cards = groupTies(matches).map(tieCard).join('');
  } else {
    cards = matches.map(knockoutCard).join('');
  }
  const label = twoLeg ? `${num(stage.slots) || groupTies(matches).length} llaves` : `${num(stage.count) || matches.length} partidos`;
  return `
    <section class="knockout-column">
      <header><h2>${escapeHtml(stage.title)}</h2><span>${escapeHtml(label)}</span></header>
      <div class="knockout-list">${cards}</div>
    </section>`;
}

function adjacentKnockoutStage(direction) {
  const stages = knockoutStageDefinitions().map((stage) => stage.key);
  const current = stages.indexOf(state.knockoutStage);
  const next = current + direction;
  return stages[next] || null;
}

function attachKnockoutSwipe(container, rerender) {
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
    rerender();
  }, { passive: true });
}

function knockoutCard(match) {
  return `
    <article class="card bracket-card fade-in">
      <div class="bracket-top"><span>${escapeHtml(match.match_number ? `Partido ${match.match_number}` : 'Partido')}</span><b>${escapeHtml(chileDateTimeLabel(match.kickoff_at))}</b></div>
      <div class="bracket-team">${teamFlag(match.home)} <strong>${escapeHtml(match.home?.display_name || match.home?.slot_label || 'Por definir')}</strong></div>
      <div class="bracket-vs">${matchScore(match)}</div>
      <div class="bracket-team">${teamFlag(match.away)} <strong>${escapeHtml(match.away?.display_name || match.away?.slot_label || 'Por definir')}</strong></div>
      <div class="venue compact">${deco('📍')} ${escapeHtml(match.venue?.display_name || 'Sede por definir')}</div>
    </article>`;
}

function placeholderKnockoutCard(stage, index) {
  const label = 'Clasificado por definir';
  return `
    <article class="card bracket-card placeholder">
      <div class="bracket-top"><span>${stage.legs > 1 ? 'Llave' : 'Partido'} ${num(index)}</span><b>Por definir</b></div>
      <div class="bracket-team"><span class="placeholder-icon" aria-hidden="true">◇</span> <strong>${escapeHtml(label)}</strong></div>
      <div class="bracket-vs">vs</div>
      <div class="bracket-team"><span class="placeholder-icon" aria-hidden="true">◇</span> <strong>${escapeHtml(label)}</strong></div>
      <div class="venue compact">${deco('📍')} Sede por confirmar</div>
    </article>`;
}

function tournamentTabsHtml(activeKey, views) {
  return `
    <div class="tournament-tabs knockout-tabs" role="tablist" aria-label="Secciones de torneo">
      ${views.map((view) => `
        <button class="${view.key === activeKey ? 'active' : ''}" data-tournament-view="${escapeHtml(view.key)}" type="button" role="tab"
                aria-selected="${view.key === activeKey ? 'true' : 'false'}" aria-controls="tournament-panel">
          ${escapeHtml(view.label || view.key)}
        </button>`).join('')}
    </div>`;
}

function qualificationSummaryHtml(data) {
  const groups = data.groups || [];
  const bestThirds = data.best_thirds || [];
  const slots = data.tournament_slots || [];
  const byStatus = (status) => bestThirds.filter((item) => String(item.qualification_status || '').toUpperCase() === status);

  const winnerRows = groups.flatMap((g) => (g.teams || []).filter((t) => t.position === 1));
  const runnerRows = groups.flatMap((g) => (g.teams || []).filter((t) => t.position === 2));
  const bestQualified = byStatus('QUALIFIED_BEST_THIRD');
  const bestPending = byStatus('THIRD_PLACE_CANDIDATE').concat(byStatus('PENDING_TIEBREAKER'));
  const eliminated = groups.flatMap((g) => (g.teams || []).filter((t) => String(t.qualification_status || '').toUpperCase() === 'ELIMINATED'));
  const pendingSlots = slots.filter((s) => !s.resolved);

  const teamList = (rows) => rows.length
    ? `<ul>${rows.map((row) => `<li>${escapeHtml(row.team_name || '-')} <small>${escapeHtml(row.group_code || '')}</small></li>`).join('')}</ul>`
    : '<p class="news-empty">Sin datos.</p>';

  return `
    <section class="view-section fade-in">
      <div class="grid">
        <article class="card">
          <h3 class="section-title">Primeros de grupo</h3>
          ${teamList(winnerRows)}
        </article>
        <article class="card">
          <h3 class="section-title">Segundos de grupo</h3>
          ${teamList(runnerRows)}
        </article>
        <article class="card">
          <h3 class="section-title">Mejores terceros</h3>
          ${teamList(bestQualified)}
        </article>
        <article class="card">
          <h3 class="section-title">Terceros pendientes</h3>
          ${teamList(bestPending)}
        </article>
        <article class="card">
          <h3 class="section-title">Eliminados</h3>
          ${teamList(eliminated)}
        </article>
        <article class="card">
          <h3 class="section-title">Slots pendientes</h3>
          ${pendingSlots.length ? `<ul>${pendingSlots.map((slot) => `<li>${escapeHtml(slot.slot_label || slot.slot_code || '')}</li>`).join('')}</ul>` : '<p class="news-empty">Sin slots pendientes.</p>'}
        </article>
      </div>
    </section>`;
}

async function renderQualificationMode(ctx) {
  try {
    const data = await cached(`competitions/${SEASON}/qualification-picture`, {}, 90000, ctx.options);
    setStatus('Torneo', 'Clasificados');
    return qualificationSummaryHtml(data);
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    return renderGenericTable(ctx);
  }
}

async function renderMatchListMode(ctx) {
  const stage = stageDefinitionsByViewType('MATCH_LIST')[0];
  return renderMatchList({ ...ctx, stageCode: ctx.stageCode || stage?.key, stageTitle: ctx.stageTitle || stage?.title });
}

// Registry keyed by tournament_views[].render_mode and stages[].view_type (F3.1).
const RENDERERS = {
  GROUP_TABLES: renderGroupTablesMode,
  LEAGUE_TABLE: renderLeagueTableMode,
  LEAGUE_PHASE_TABLE: renderLeaguePhaseMode,
  MATCH_LIST: renderMatchListMode,
  BRACKET: renderBracketMode,
  BRACKET_ROUND: renderBracketMode,
  TWO_LEG_TIE: renderBracketMode,
  QUALIFICATION_SUMMARY: renderQualificationMode,
  GENERIC: renderGenericTable,
};

function resolveRenderer(view) {
  const mode = String(view?.render_mode || view?.view_type || '').toUpperCase();
  if (RENDERERS[mode]) return RENDERERS[mode];
  // Legacy keys without a render_mode.
  const byKey = { groups: 'GROUP_TABLES', table: 'LEAGUE_TABLE', fixtures: 'MATCH_LIST', knockout: 'BRACKET', qualified: 'QUALIFICATION_SUMMARY' }[view?.key];
  return RENDERERS[byKey] || renderGenericTable;
}

async function renderTournament(options = {}) {
  if (!options.silent) loading('Torneo');
  await ensureLayout();

  const views = tournamentViewDefinitions();
  if (!state.tournamentView || !views.some((view) => view.key === state.tournamentView)) {
    state.tournamentView = views[0]?.key || null;
  }
  const selected = views.find((view) => view.key === state.tournamentView) || { key: 'generic', label: 'Tabla', render_mode: 'GENERIC' };
  setStatus('Torneo', selected.label || 'Torneo');
  const renderer = resolveRenderer(selected);
  const bodyHtml = await renderer({ options, view: selected, viewType: selected.render_mode });
  const notice = state.layout?._fallback
    ? '<p class="layout-notice">Formato no disponible: se muestra una vista genérica.</p>'
    : '';

  root.innerHTML = `
    <div class="fade-in tournament-view tournament-view--${escapeHtml(selected.key)}">
      ${views.length > 1 ? tournamentTabsHtml(selected.key, views) : ''}
      ${notice}
      <div class="tournament-body" id="tournament-panel" role="tabpanel">${bodyHtml || emptyState('Sin datos para esta vista.')}</div>
    </div>`;

  const rerender = () => renderTournament({ localOnly: true, silent: true });
  root.querySelectorAll('[data-tournament-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextView = button.dataset.tournamentView;
      if (!nextView || nextView === state.tournamentView) return;
      state.tournamentView = nextView;
      renderTournament({ localOnly: true });
    });
  });
  root.querySelectorAll('[data-table-stage]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.tableStage === state.tableStage) return;
      state.tableStage = button.dataset.tableStage;
      rerender();
    });
  });
  root.querySelectorAll('[data-knockout-stage]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.knockoutStage === state.knockoutStage) return;
      state.knockoutStage = button.dataset.knockoutStage;
      rerender();
    });
  });
  root.querySelectorAll('[data-dir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextStage = adjacentKnockoutStage(Number(btn.dataset.dir));
      if (!nextStage) return;
      state.knockoutStage = nextStage;
      rerender();
    });
  });
  attachMatchdayHandlers(rerender);
  const view = root.querySelector('.knockout-view');
  if (view) attachKnockoutSwipe(view, rerender);
}

function eloBadge(rank) {
  if (rank === 1) return '<span class="chip chip--ok">#1</span>';
  if (rank <= 4) return '<span class="chip chip--warn">Top 4</span>';
  if (rank <= 8) return '<span class="chip chip--muted">Top 8</span>';
  return '<span class="chip chip--muted">Resto</span>';
}

function eloTableHtml(data) {
  const teams = data.teams || [];
  const maxRating = Math.max(...teams.map((t) => Number(t.rating || 0)), 1);
  return `
    <section class="view-section fade-in">
      <div class="card teams-filter-card" style="margin-bottom:.75rem">
        <div class="teams-filter-grid" style="grid-template-columns:minmax(180px, 260px)">
          <select id="elo-rating-type">
            ${(data.rating_types || []).map((value) => `<option value="${escapeHtml(value)}" ${value === data.rating_type ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="card table-card">
        <table>
          <thead><tr><th>#</th><th>Equipo</th><th>Rating</th><th>Delta</th><th>Barra</th><th>Badge</th></tr></thead>
          <tbody>
            ${teams.map((team) => {
              const rating = Number(team.rating || 0);
              const prev = team.previous_rating != null ? Number(team.previous_rating) : null;
              const delta = team.delta != null ? Number(team.delta) : (prev != null ? rating - prev : null);
              const width = Math.max(2, Math.round((rating / maxRating) * 100));
              return `<tr>
                <td><strong>${team.rank || '-'}</strong></td>
                <td><strong>${escapeHtml(team.flag || '')} ${escapeHtml(team.team_name || '-')}</strong></td>
                <td>${team.rating != null ? rating.toFixed(0) : '-'}</td>
                <td>${delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}` : '-'}</td>
                <td><div class="prob-bar-track"><div class="prob-bar-fill prob-bar-fill--model" style="width:${width}%"></div></div></td>
                <td>${eloBadge(team.rank || 999)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

async function renderElo(options = {}) {
  if (!options.silent) loading('ELO');
  const params = state.eloRatingType ? { rating_type: state.eloRatingType } : {};
  const data = await cached(`competitions/${SEASON}/elo`, params, 90000, options);
  const teams = data.teams || [];
  setStatus('ELO', `${teams.length} equipos · ${data.rating_type || ''}`.trim());
  root.innerHTML = teams.length ? eloTableHtml(data) : emptyState('No hay ratings ELO disponibles para esta season.');

  const select = document.getElementById('elo-rating-type');
  if (select) {
    select.addEventListener('change', () => {
      state.eloRatingType = select.value;
      renderElo({ localOnly: true });
    });
  }
}

// ─── Quant adapters ────────────────────────────────────────────────────────

function adaptEVOpportunity(raw) {
  let explanation = raw.explanation;
  if (typeof explanation === 'string') {
    try {
      explanation = JSON.parse(explanation);
    } catch (_err) {
      explanation = null;
    }
  }
  const lambda = explanation?.lambda_components || null;
  const homeLambda = lambda?.home_lambda != null ? Number(lambda.home_lambda) : null;
  const awayLambda = lambda?.away_lambda != null ? Number(lambda.away_lambda) : null;

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
    confidenceScore: raw.confidence_score != null ? Math.min(Number(raw.confidence_score), 1) : null,
    decisionStatus: raw.decision_status,
    predictionStatus: raw.prediction_status,
    blockReasons: Array.isArray(raw.block_reasons) ? raw.block_reasons : (raw.block_reason ? [raw.block_reason] : []),
    modelName: raw.model_name,
    modelFamily: raw.model_family,
    oddsAgeMinutes: raw.odds_age_minutes,
    homeLambda,
    awayLambda,
    over25Prob: probOver25(homeLambda, awayLambda),
    bttsYesProb: probBttsYes(homeLambda, awayLambda),
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
  if (value == null || isNaN(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function fmtNum(value, decimals = 2) {
  if (value == null) return '—';
  return Number(value).toFixed(decimals);
}

function probOver25(homeLambda, awayLambda) {
  if (homeLambda == null || awayLambda == null) return null;
  const lambdaTot = homeLambda + awayLambda;
  const pLe2 = Math.exp(-lambdaTot) * (1 + lambdaTot + (lambdaTot * lambdaTot) / 2);
  const pOver = 1 - pLe2;
  return Math.max(0, Math.min(1, pOver));
}

function probBttsYes(homeLambda, awayLambda) {
  if (homeLambda == null || awayLambda == null) return null;
  const pHome0 = Math.exp(-homeLambda);
  const pAway0 = Math.exp(-awayLambda);
  const pBoth0 = Math.exp(-(homeLambda + awayLambda));
  const pYes = 1 - pHome0 - pAway0 + pBoth0;
  return Math.max(0, Math.min(1, pYes));
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
  const hasLambdaBlock = opp.homeLambda != null && opp.awayLambda != null;
  const lambdaBlock = hasLambdaBlock
    ? `λ: ${fmtNum(opp.homeLambda)}-${fmtNum(opp.awayLambda)} · Over 2.5: ${fmtPct(opp.over25Prob)} · BTTS: ${fmtPct(opp.bttsYesProb)}`
    : '';
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
        ${lambdaBlock ? `<div class="ev-match-insights">${escapeHtml(lambdaBlock)}</div>` : ''}
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
  const confList = opportunities.map((o) => o.confidenceScore).filter((c) => c != null && !isNaN(Number(c)));
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

// F4.6: daily model metrics history (Brier, log-loss, ECE, CLV, paper ROI) — last 30 days.
function metricsHistoryChart(series) {
  const id = 'metrics-history-chart';
  if (!series.length) return `<div class="chart-wrap">${quantEmptyState('📈', 'Sin historial de métricas', 'La serie aparece cuando el loop diario registra métricas por competición.')}</div>`;
  return `
    <div class="chart-wrap"><canvas id="${id}" aria-label="${escapeHtml('Historial diario de métricas del modelo')}" role="img"></canvas></div>
    <p style="font-size:.74rem;color:var(--muted);margin:.4rem 0 0">${escapeHtml('Eje izq.: Brier, log-loss, ECE (menor = mejor). Eje der.: CLV y ROI paper.')}</p>`;
}

function initMetricsHistoryChart(series) {
  destroyChart('metrics-history-chart');
  const canvas = document.getElementById('metrics-history-chart');
  if (!canvas || !series.length || typeof Chart === 'undefined') return;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const labels = series.map((p) => String(p.date || ''));
  const line = (label, key, color, axis, dash) => ({
    type: 'line', label, yAxisID: axis, data: series.map((p) => num(p[key])),
    borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 2, spanGaps: true, fill: false,
    ...(dash ? { borderDash: [4, 4] } : {}),
  });
  new Chart(canvas, {
    data: {
      labels,
      datasets: [
        line('Brier', 'brier_score', 'rgba(53,194,255,.9)', 'y'),
        line('Log-loss', 'log_loss', 'rgba(159,176,195,.9)', 'y'),
        line('ECE', 'ece', 'rgba(244,197,66,.9)', 'y'),
        line('CLV', 'clv_avg', 'rgba(30,215,96,.9)', 'y1', true),
        line('ROI paper', 'paper_roi', 'rgba(255,99,117,.9)', 'y1', true),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#9fb0c3', font: { size: 11 } } } },
      scales: {
        y: { position: 'left', ticks: { color: '#9fb0c3', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.06)' } },
        y1: { position: 'right', ticks: { color: '#9fb0c3', font: { size: 10 }, callback: (v) => `${(v * 100).toFixed(1)}%` }, grid: { display: false } },
        x: { ticks: { color: '#9fb0c3', font: { size: 9 }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
      },
    },
  });
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
  let calibration = [], buckets = [], decisions = [], history = [];
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
  // Optional (F4.6): an older backend without the endpoint must not break the view.
  try {
    const histData = await cached('model/metrics/history', { days: 30 }, 300000, options);
    history = Array.isArray(histData?.series) ? histData.series : [];
  } catch (error) {
    if (error.name === 'AbortError') return;
    history = [];
  }

  setStatus('Stats', `${decisions.length} picks`);

  const hasData = decisions.length > 0 || calibration.length > 0 || history.length > 0;

  root.innerHTML = `
    <div class="stats-view">
      ${!hasData ? statsRoadmapEmpty() : `
      <section class="stats-section">
        <h3>KPIs del Modelo</h3>
        ${statsKpiBar(calibration, buckets)}
      </section>
      <section class="stats-section">
        <h3>Evolución diaria (30 días)</h3>
        ${metricsHistoryChart(history)}
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
    initMetricsHistoryChart(history);
    initCalibrationChart(calibration);
    initRoiChart(buckets);
    initPicksDonut(decisions);
  }, 0);
}

// ─── News view ───────────────────────────────────────────────────────────────

function newsArticleCard(article) {
  const title = escapeHtml(article.title || '');
  const source = escapeHtml(article.source || '');
  const url = safeUrl(article.url);
  const pub = article.published_at ? escapeHtml(timeLabel(article.published_at)) : '';
  const team = article.home_team || article.away_team
    ? `<span class="news-team-tag">${escapeHtml(article.home_team || article.away_team)}</span>`
    : '';
  return `<a class="news-article" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
    <div class="news-article__header">${team}<span class="news-article__meta">${source}${pub ? ` · ${pub}` : ''}</span></div>
    <span class="news-article__title">${title}</span>
    <span class="news-article__link">Leer más →</span>
  </a>`;
}

async function renderNews(options = {}) {
  root.innerHTML = skeletonCards(3);

  let matches = [];
  try {
    const resp = await apiGet('web/news', {}, options);
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
          <span class="chip chip--muted">${escapeHtml(timeLabel(m.kickoff_at))}</span>
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
    else if (state.view === 'tournament' || state.view === 'knockout') { hideDateFilterBar(); await renderTournament(renderOptions); }
    else if (state.view === 'elo') { hideDateFilterBar(); await renderElo(renderOptions); }
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
    root.setAttribute('aria-labelledby', button.id || '');
    updateTabs();
    render();
  });
});

// Arrow-key / Home / End navigation for every role="tablist" (main tabs and subtabs).
document.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tab = event.target.closest?.('[role="tab"]');
  const list = tab?.closest('[role="tablist"]');
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')].filter((t) => !t.hidden && !t.disabled);
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  let next = index;
  if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  event.preventDefault();
  const target = tabs[next];
  const selector = target.id ? `#${CSS.escape(target.id)}` : null;
  target.click();
  // Subtabs are re-rendered on click: restore focus on the equivalent tab.
  requestAnimationFrame(() => {
    const again = (selector && document.querySelector(selector))
      || [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].find((t) => t.textContent.trim() === target.textContent.trim())
      || target;
    again.focus();
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
  const paths = quantPaths[state.view]
    ? [quantPaths[state.view]]
    : state.view === 'standings' ? [`competitions/${SEASON}/standings/global`, 'web/standings']
    : state.view === 'teams' ? [`competitions/${SEASON}/teams`]
    : state.view === 'tournament' || state.view === 'knockout' ? ['web/knockout', 'web/standings', 'web/matches']
    : state.view === 'elo' ? [`competitions/${SEASON}/elo`]
    : ['web/matches-overview'];
  paths.forEach(invalidateViewCache);
  render({ silent: true });
}

// Auto-refresh: AUTO_REFRESH_MS while there are live matches, ≥60 s otherwise,
// and fully paused while the tab is hidden (F3.10).
function refreshIntervalMs() {
  return state.hasLive ? AUTO_REFRESH_MS : Math.max(60000, AUTO_REFRESH_MS);
}

function scheduleRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  if (AUTO_REFRESH_MS <= 0 || document.hidden) return;
  state.refreshTimer = window.setTimeout(() => {
    refreshSilently();
    scheduleRefresh();
  }, refreshIntervalMs());
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    return;
  }
  const stale = !state.lastUpdatedAt || Date.now() - state.lastUpdatedAt.getTime() > refreshIntervalMs();
  if (stale) refreshSilently();
  scheduleRefresh();
});

scheduleRefresh();

// ── League picker ─────────────────────────────────────────────────────────────
// Built dynamically from GET competitions/catalog (F3.7). The static groups,
// icons and catalog below are used ONLY when that request fails.

const COMPETITION_GROUPS = [
  {
    label: 'Mundiales',
    icon: '🌍',
    slugs: ['wc2026'],
  },
  {
    label: 'Eliminatorias 2030',
    icon: '🎯',
    slugs: [
      'conmebol-qualifiers-wc2030',
      'uefa-qualifiers-wc2030',
      'concacaf-qualifiers-wc2030',
      'caf-qualifiers-wc2030',
      'afc-qualifiers-wc2030',
      'ofc-qualifiers-wc2030',
    ],
  },
  {
    label: 'Champions League',
    icon: '⭐',
    slugs: ['ucl-2026-2027', 'ucl-2025-2026'],
  },
  {
    label: 'Ligas',
    icon: '🏆',
    slugs: ['chile-primera-2026', 'chile-apertura-2026', 'chile-clausura-2026', 'premier-league-2026-2027'],
  },
  {
    label: 'Copas',
    icon: '🏅',
    slugs: ['libertadores-2026'],
  },
];

const COMPETITION_ICONS = {
  'wc2026': '🌍',
  'conmebol-qualifiers-wc2030': '🇦🇷',
  'uefa-qualifiers-wc2030': '🇪🇺',
  'concacaf-qualifiers-wc2030': '🇲🇽',
  'caf-qualifiers-wc2030': '🌍',
  'afc-qualifiers-wc2030': '🌏',
  'ofc-qualifiers-wc2030': '🌊',
  'ucl-2026-2027': '⭐',
  'ucl-2025-2026': '⭐',
  'chile-primera-2026': '🇨🇱',
  'chile-apertura-2026': '🇨🇱',
  'chile-clausura-2026': '🇨🇱',
  'premier-league-2026-2027': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
  'libertadores-2026': '🏆',
};

let _catalogCache = null;

// Static fallback: shown immediately while the API call resolves (or if it fails).
// Keys must match catalog.py slugs. Add new competitions here when seeded.
const STATIC_CATALOG_FALLBACK = {
  'wc2026':                      { competition_season_slug: 'wc2026',                      name: 'FIFA World Cup',                  season_label: '2026',        region: 'Global' },
  'conmebol-qualifiers-wc2030':  { competition_season_slug: 'conmebol-qualifiers-wc2030',  name: 'Eliminatorias Sudamericanas 2030', season_label: '2026–2029',   region: 'South America' },
  'uefa-qualifiers-wc2030':      { competition_season_slug: 'uefa-qualifiers-wc2030',      name: 'Clasificación Europea 2030',      season_label: '2026–2029',   region: 'Europe' },
  'concacaf-qualifiers-wc2030':  { competition_season_slug: 'concacaf-qualifiers-wc2030',  name: 'Clasificación CONCACAF 2030',     season_label: '2026–2029',   region: 'North & Central America' },
  'caf-qualifiers-wc2030':       { competition_season_slug: 'caf-qualifiers-wc2030',       name: 'Clasificación Africana 2030',     season_label: '2026–2029',   region: 'Africa' },
  'afc-qualifiers-wc2030':       { competition_season_slug: 'afc-qualifiers-wc2030',       name: 'Clasificación Asiática 2030',     season_label: '2027–2029',   region: 'Asia' },
  'ofc-qualifiers-wc2030':       { competition_season_slug: 'ofc-qualifiers-wc2030',       name: 'Clasificación OFC 2030',          season_label: '2027–2029',   region: 'Oceania' },
  'ucl-2026-2027':               { competition_season_slug: 'ucl-2026-2027',               name: 'UEFA Champions League',           season_label: '2026/2027',   region: 'Europe' },
  'ucl-2025-2026':               { competition_season_slug: 'ucl-2025-2026',               name: 'UEFA Champions League',           season_label: '2025/2026',   region: 'Europe' },
  'chile-primera-2026':          { competition_season_slug: 'chile-primera-2026',          name: 'Chile Primera División',          season_label: '2026',        region: 'South America' },
  'chile-apertura-2026':         { competition_season_slug: 'chile-apertura-2026',         name: 'Torneo Apertura',                 season_label: 'Apertura 2026', region: 'South America' },
  'chile-clausura-2026':         { competition_season_slug: 'chile-clausura-2026',         name: 'Torneo Clausura',                 season_label: 'Clausura 2026', region: 'South America' },
  'premier-league-2026-2027':    { competition_season_slug: 'premier-league-2026-2027',    name: 'Premier League',                  season_label: '2026/2027',   region: 'Europe' },
  'libertadores-2026':           { competition_season_slug: 'libertadores-2026',           name: 'Copa Libertadores',               season_label: '2026',        region: 'South America' },
};

const COMPETITION_TYPE_LABELS = {
  WORLD_CUP: 'Mundiales',
  INTERNATIONAL_TOURNAMENT: 'Torneos internacionales',
  QUALIFIERS: 'Eliminatorias',
  QUALIFIER: 'Eliminatorias',
  CONTINENTAL_CLUB: 'Copas internacionales',
  CLUB_INTERNATIONAL: 'Copas internacionales',
  CONTINENTAL_CUP: 'Copas internacionales',
  LEAGUE: 'Ligas',
  DOMESTIC_LEAGUE: 'Ligas',
  CUP: 'Copas',
  DOMESTIC_CUP: 'Copas',
};

function catalogSlug(entry) {
  return String(entry?.competition_season_slug || entry?.slug || '');
}

function catalogName(entry) {
  return entry?.display_name || entry?.name || catalogSlug(entry);
}

function catalogTypeLabel(type) {
  const raw = String(type || '').toUpperCase();
  if (!raw) return 'Otras';
  return COMPETITION_TYPE_LABELS[raw] || (raw.charAt(0) + raw.slice(1).toLowerCase()).replace(/_/g, ' ');
}

// Returns { source: 'api' | 'static', entries: [...] }.
async function loadCompetitionCatalog() {
  if (_catalogCache) return _catalogCache;
  try {
    const data = await apiGet('competitions/catalog');
    const list = Array.isArray(data) ? data : (data?.competitions || data?.items || []);
    const entries = list.filter((c) => c && catalogSlug(c));
    if (!entries.length) throw new Error('Catálogo vacío');
    _catalogCache = { source: 'api', entries };
  } catch {
    // Keep static fallback — picker still works offline. Not cached so it retries next open.
    return { source: 'static', entries: Object.values(STATIC_CATALOG_FALLBACK) };
  }
  return _catalogCache;
}

function leaguePickerItem(comp, icon) {
  const slug = catalogSlug(comp);
  const isActive = slug === SEASON;
  const meta = [comp.season_label, comp.region].filter(Boolean).join(' · ');
  return `
    <button class="league-picker-item${isActive ? ' league-picker-item--active' : ''}"
            data-season="${escapeHtml(slug)}" type="button"
            role="option" aria-selected="${isActive ? 'true' : 'false'}">
      <span class="league-picker-item-icon" aria-hidden="true">${escapeHtml(icon || '🏆')}</span>
      <span class="league-picker-item-info">
        <span class="league-picker-item-name">${escapeHtml(catalogName(comp))}</span>
        <span class="league-picker-item-meta">${escapeHtml(meta)}</span>
      </span>
    </button>`;
}

function leaguePickerGroup(label, icon, items) {
  if (!items.length) return '';
  return `
    <div class="league-picker-group" role="group" aria-label="${escapeHtml(label)}">
      <div class="league-picker-group-label">${icon ? `${deco(icon)} ` : ''}${escapeHtml(label)}</div>
      ${items.join('')}
    </div>`;
}

function buildLeaguePickerDropdown(catalog) {
  if (catalog.source === 'api') {
    // Group by competition_type, then order by region/name. Icons come from the catalog.
    const groups = new Map();
    for (const comp of catalog.entries) {
      const label = catalogTypeLabel(comp.competition_type || comp.domain_type);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(comp);
    }
    return [...groups.entries()].map(([label, comps]) => {
      comps.sort((a, b) => String(a.region || '').localeCompare(String(b.region || '')) || catalogName(a).localeCompare(catalogName(b)));
      return leaguePickerGroup(label, '', comps.map((comp) => leaguePickerItem(comp, comp.ui?.icon || '🏆')));
    }).join('');
  }

  // Static fallback (API unreachable).
  const bySlug = Object.fromEntries(catalog.entries.map((c) => [catalogSlug(c), c]));
  const knownSlugs = new Set(COMPETITION_GROUPS.flatMap((g) => g.slugs));
  const html = COMPETITION_GROUPS.map((group) => leaguePickerGroup(
    group.label,
    group.icon,
    group.slugs.map((slug) => bySlug[slug]).filter(Boolean).map((comp) => leaguePickerItem(comp, COMPETITION_ICONS[catalogSlug(comp)] || group.icon)),
  ));
  const others = catalog.entries.filter((c) => !knownSlugs.has(catalogSlug(c))).map((comp) => leaguePickerItem(comp, '🏆'));
  html.push(leaguePickerGroup('Otras', '🏆', others));
  return html.filter(Boolean).join('');
}

function switchSeason(slug) {
  const url = new URL(location.href);
  url.searchParams.set('season', slug);
  location.href = url.toString();
}

(function initLeaguePicker() {
  const btn = document.getElementById('league-picker-btn');
  const dropdown = document.getElementById('league-picker-dropdown');
  if (!btn || !dropdown) return;

  // Keep the dropdown at document root so it is not affected by topbar
  // stacking/overflow behavior on small screens.
  if (dropdown.parentElement !== document.body) {
    document.body.appendChild(dropdown);
  }

  let isOpen = false;

  function positionPicker() {
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = `${Math.round(rect.bottom + 8)}px`;
    dropdown.style.left = `${Math.round(rect.left)}px`;
  }

  function openPicker() {
    isOpen = true;
    btn.setAttribute('aria-expanded', 'true');
    positionPicker();
    dropdown.removeAttribute('hidden');
    dropdown.innerHTML = '<div class="league-picker-group"><div class="league-picker-group-label">Cargando…</div></div>';
    loadCompetitionCatalog().then((catalog) => {
      dropdown.innerHTML = buildLeaguePickerDropdown(catalog);
      dropdown.querySelectorAll('[data-season]').forEach((item) => {
        item.addEventListener('click', () => switchSeason(item.dataset.season));
      });
    });
  }

  function closePicker() {
    isOpen = false;
    btn.setAttribute('aria-expanded', 'false');
    dropdown.setAttribute('hidden', '');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen ? closePicker() : openPicker();
  });

  window.addEventListener('resize', () => {
    if (isOpen) positionPicker();
  });

  document.addEventListener('click', (e) => {
    if (isOpen && !dropdown.contains(e.target) && e.target !== btn) closePicker();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closePicker();
  });

  // Label is kept in sync by applyCompetitionLayout().
  // Do an initial safe sync without observing the full DOM.
  const labelEl = document.getElementById('league-picker-label');
  if (labelEl) {
    const name = competitionLabel();
    if (name && labelEl.textContent !== name) {
      labelEl.textContent = name;
    }
  }
})();

render();
