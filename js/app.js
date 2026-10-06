const CFG = window.MATCH_ALPHA_CONFIG || {};
const API_BASE_URL = String(CFG.API_BASE_URL || '').replace(/\/+$/, '');
// Competition: ?season= (league picker links) → last one the user picked → config default.
const SEASON_STORAGE = 'ma_last_season';
const SEASON = (() => {
  const fromUrl = new URLSearchParams(location.search).get('season');
  try {
    if (fromUrl) localStorage.setItem(SEASON_STORAGE, fromUrl);
    return fromUrl || localStorage.getItem(SEASON_STORAGE) || CFG.DEFAULT_SEASON || 'chile-primera-2026';
  } catch { return fromUrl || CFG.DEFAULT_SEASON || 'chile-primera-2026'; }
})();
const KEY_STORAGE = CFG.KEY_STORAGE || 'poolteam2026'; // storage key name kept so saved keys survive; replaced by accounts (SaaS F4)
const AUTO_REFRESH_MS = Number(CFG.AUTO_REFRESH_MS || 30000);
// Every date / time is shown in the USER's time zone (browser setting); ?tz=America/Bogota overrides it for
// testing. "Today / tomorrow" and the day grouping follow that zone too.
const FALLBACK_TIMEZONE = 'America/Santiago';
function validTimeZone(zone) {
  try { return zone ? Boolean(new Intl.DateTimeFormat('es', { timeZone: zone })) && zone : null; } catch { return null; }
}
const BROWSER_TIMEZONE = validTimeZone(new URLSearchParams(location.search).get('tz'))
  || Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIMEZONE;
const USER_TIMEZONE = BROWSER_TIMEZONE;
// "Chile", "Colombia", "Argentina"… from the zone (Intl long generic name), used as the time suffix.
const UI_LANG = (window.MA_I18N && window.MA_I18N.lang) || 'es';
const UI_LOCALE = (window.MA_I18N && window.MA_I18N.locale) || 'es-CL';
const USER_ZONE_LABEL = (() => {
  try {
    const name = new Intl.DateTimeFormat(UI_LANG, { timeZone: USER_TIMEZONE, timeZoneName: 'longGeneric' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
    const city = USER_TIMEZONE.split('/').pop().replace(/_/g, ' ');
    // es "hora estándar de Colombia" · en "Colombia Standard Time" · pt "Horário Padrão da Colômbia"
    const m = name.match(/^hora (?:estándar |de verano )?(?:de |del |de la )?(.+)$/i)
      || name.match(/^(.+?) (?:Standard |Daylight |Summer )?Time$/)
      || name.match(/^Horário (?:Padrão |de Verão )?(?:de |do |da |dos )?(.+)$/i);
    // "Chile", "Colombia", "Europa central"; generic names ("central", "del Pacífico") → the zone's city
    return m && /^[A-ZÁÉÍÓÚÑ]/.test(m[1]) ? m[1] : city;
  } catch { return USER_TIMEZONE.split('/').pop().replace(/_/g, ' '); }
})();
const BROWSER_LANG = (window.MA_I18N && window.MA_I18N.lang) || (navigator.language || 'es').toLowerCase().split('-')[0];

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
  return new Intl.DateTimeFormat('sv-SE', { timeZone: USER_TIMEZONE }).format(date);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateLabel(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(UI_LOCALE, { day: '2-digit', month: 'short', timeZone: USER_TIMEZONE })
    .format(new Date(value))
    .replace('.', '')
    .replace(/\s+/g, '-')
    .toUpperCase();
}

function timeLabel(value, timeZone = USER_TIMEZONE) {
  if (!value) return '';
  return new Intl.DateTimeFormat(UI_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(value));
}

function userDateTimeLabel(value) {
  if (!value) return '';
  return `${dateLabel(value).toLowerCase()} · ${timeLabel(value)} ${USER_ZONE_LABEL}`;
}

function userParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: USER_TIMEZONE,
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

function userDateToUtcIso(ymdValue, hour = 0, minute = 0) {
  const [year, month, day] = String(ymdValue).split('-').map(Number);
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i += 1) {
    const parts = userParts(guess);
    const diffMinutes =
      (Date.UTC(year, month - 1, day, hour, minute, 0) -
       Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)) / 60000;
    guess = new Date(guess.getTime() + diffMinutes * 60000);
  }
  return guess.toISOString();
}

function userOperationalRange(baseDate, offsetDays = 0) {
  const startYmd = ymd(addDays(baseDate, offsetDays));
  const nextYmd = ymd(addDays(baseDate, offsetDays + 1));
  return {
    kickoff_from: userDateToUtcIso(startYmd, 0, 0),
    kickoff_to: userDateToUtcIso(nextYmd, 1, 0),
    label: startYmd
  };
}

function localVenueTimeLabel(match) {
  const zone = match.venue?.timezone_name;
  if (!zone || timeLabel(match.kickoff_at, zone) === timeLabel(match.kickoff_at)) return '';
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

// Team flag / crest / nation rendering lives in js/team-identity.js (MA_TEAM, unit-tested). The competition
// scope comes from the layout (metadata.team_scope), never from competition names.
function teamScope() {
  return state.layout?.metadata?.team_scope || null;
}

function teamIdentity(team) {
  return team?.identity || {};
}

function teamMark(team) {
  return window.MA_TEAM.mark(team, teamScope());
}

// "🇦🇷 Argentina" under a club name, only in international club competitions (redundant elsewhere).
function teamNationHtml(team) {
  return window.MA_TEAM.nation(team, teamScope());
}

// Broken / blocked crest image → initials badge (error events do not bubble: capture phase).
document.addEventListener('error', (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('team-crest')) return;
  const span = document.createElement('span');
  span.className = 'team-crest team-crest--fallback';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = img.dataset.initials || '?';
  img.replaceWith(span);
}, true);

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
  // Fase H: views registered by js/picks.js / js/push.js (window.MA_VIEWS) are not layout-driven.
  const extView = Boolean(window.MA_VIEWS && Object.prototype.hasOwnProperty.call(window.MA_VIEWS, state.view));
  if (!isAdminView(state.view) && !navByView[state.view] && !extView) {
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

const KNOCKOUT_VIEW_TYPES = ['BRACKET_ROUND', 'TWO_LEG_TIE', 'PLAYOFF_BRACKET'];

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
        // Phase G: format notes (single leg + ET/penalties, best-of-N series), seeding and origins.
        rules: stage.rules || {},
        origins: Array.isArray(stage.origins) ? stage.origins : [],
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
  if (!API_BASE_URL) throw new Error('Configura API_BASE_URL en js/config.js');
  const url = new URL(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`);
  url.searchParams.set('season', SEASON);
  url.searchParams.set('timezone', BROWSER_TIMEZONE);
  url.searchParams.set('lang', BROWSER_LANG || 'en');
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const key = savedKey();
  // Read key travels as X-API-Key (accepted by require_read_key); the service worker only
  // caches requests WITHOUT an Authorization header, so internal Bearer keys are never cached.
  const headers = key ? { 'X-API-Key': key } : {};
  // Timeout so the page doesn't freeze when the Render free backend is waking up (~50 s): one automatic
  // retry with a longer timeout, telling the user what is going on, before giving up.
  let response;
  for (let attempt = 1; ; attempt += 1) {
    const { signal, cancel, timedOut } = requestSignal(options.signal, attempt === 1 ? REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS * 2);
    try {
      response = await fetch(url, { headers, signal });
      break;
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || timedOut();
      if (isTimeout && attempt === 1 && !options.signal?.aborted) {
        setStatus('Conectando…', 'reintentando');
        continue;
      }
      if (isTimeout) {
        const te = new Error('Servidor despertando: tardó demasiado en responder. Intenta de nuevo en unos segundos.');
        te.name = 'TimeoutError';
        throw te;
      }
      throw err;
    } finally {
      cancel();
    }
  }
  setOfflineBanner(response.headers.get('x-ma-offline') === '1');
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
  // Bottom nav / "Más" sheet mirror the top tabs (visibility comes from the layout).
  const hiddenViews = new Set([...document.querySelectorAll('.tab')].filter((t) => t.hidden).map((t) => t.dataset.view));
  let moreActive = false;
  document.querySelectorAll('.bottom-tab[data-view], .more-item[data-view]').forEach((button) => {
    const view = button.dataset.view;
    button.hidden = hiddenViews.has(view);
    const active = view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    if (active && button.classList.contains('more-item')) moreActive = true;
  });
  document.querySelector('.bottom-tab[data-more]')?.classList.toggle('active', moreActive);
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
      <div>${escapeHtml(/failed to fetch|networkerror|load failed/i.test(String(error?.message || '')) ? 'Sin conexión con el servidor. Revisa tu red e intenta de nuevo.' : (error?.message || error))}</div>
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
  return `${label} · ${escapeHtml(userDateTimeLabel(match.kickoff_at))}`;
}

function matchCard(match) {
  const home = match.home || { display_name: 'Por definir', is_placeholder: true };
  const away = match.away || { display_name: 'Por definir', is_placeholder: true };
  const group = matchGroupLabel(match);
  const stage = matchStageLabel(match);
  const meta = [stage, group].filter(Boolean).join(' · ');
  const isLive = isLiveStatus(match.status);
  return `
    <article class="card match-card fade-in" data-status="${escapeHtml(match.status || 'SCHEDULED')}"${match.match_id ? ` data-match-id="${escapeHtml(match.match_id)}" tabindex="0" role="button" aria-label="${escapeHtml(`Ver detalle: ${home.display_name || ''} vs ${away.display_name || ''}`)}"` : ''}>
      <div class="match-meta">
        <span class="stage-chip${isLive ? ' stage-chip--live' : ''}">${escapeHtml(meta || 'Partido')}</span>
        <span class="match-time ${statusClass(match.status)}">${matchTimeHtml(match)}</span>
      </div>
      <div class="teams-row">
        <div class="team-side"><div class="flag">${teamMark(home)}</div><div class="name" title="${escapeHtml(home.display_name)}">${escapeHtml(teamShortName(home))}</div>${teamNationHtml(home)}</div>
        ${matchScore(match)}
        <div class="team-side"><div class="flag">${teamMark(away)}</div><div class="name" title="${escapeHtml(away.display_name)}">${escapeHtml(teamShortName(away))}</div>${teamNationHtml(away)}</div>
      </div>
      ${venueDetailHtml(match)}
      ${weatherHtml(match)}
    </article>`;
}

function matchesOverviewParams() {
  const now = new Date();
  const yesterday = userOperationalRange(now, -1);
  const today = userOperationalRange(now, 0);
  const tomorrow = userOperationalRange(now, 1);
  return {
    yesterday_from: yesterday.kickoff_from,
    yesterday_to: yesterday.kickoff_to,
    today_from: today.kickoff_from,
    today_to: today.kickoff_to,
    tomorrow_from: tomorrow.kickoff_from,
    tomorrow_to: tomorrow.kickoff_to,
    upcoming_from: tomorrow.kickoff_from,
    upcoming_to: userOperationalRange(now, 30).kickoff_to,
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
                <span class="kickoff-time">${escapeHtml(block.timeKey)} ${escapeHtml(USER_ZONE_LABEL)}</span>
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
  const cls = ['standings-main', posCls, zone ? zoneClass(zone.code) : ''].filter(Boolean).join(' ');
  const name = row.team_name || row.display_name || '-';
  const key = String(row.team_id || row.team_slug || `pos-${pos}`);
  const dg = num(row.goal_difference);
  return `
    <tr class="${cls}" data-standings-toggle="${escapeHtml(key)}" data-team-id="${escapeHtml(row.team_id || '')}" tabindex="0" aria-expanded="false" aria-label="${escapeHtml(`${pos}. ${name}: ${num(row.points)} puntos. Ver detalle`)}">
      <td>${pos}${zone ? `<span class="sr-only"> (${escapeHtml(zone.label)})</span>` : ''}</td>
      <td class="col-team"><strong>${teamMark(row)} <span class="team-label">${escapeHtml(name)}</span></strong>${teamNationHtml(row)}</td>
      <td>${num(row.played)}</td>
      <td class="col-extra">${num(row.wins)}</td><td class="col-extra">${num(row.draws)}</td><td class="col-extra">${num(row.losses)}</td>
      <td class="col-extra">${num(row.goals_for)}</td><td class="col-extra">${num(row.goals_against)}</td>
      <td>${dg > 0 ? '+' : ''}${dg}</td>
      <td class="col-pts"><strong>${num(row.points)}</strong></td>
    </tr>
    <tr class="standings-detail" data-standings-detail="${escapeHtml(key)}" hidden>
      <td colspan="10">
        <div class="standings-detail-grid">
          <span><b>${num(row.wins)}</b>G</span><span><b>${num(row.draws)}</b>E</span><span><b>${num(row.losses)}</b>P</span>
          <span><b>${num(row.goals_for)}</b>GF</span><span><b>${num(row.goals_against)}</b>GC</span>
        </div>
        <div class="form-strip" data-form-slot><span class="form-label">Últimos 5</span><span class="form-loading">…</span></div>
      </td>
    </tr>`;
}

function _standingsTable(rows, zones = []) {
  return `
    <div class="card table-card standings-card">
      <table class="standings-table">
        <thead><tr><th scope="col">#</th><th scope="col">Equipo</th><th scope="col" title="Partidos jugados">PJ</th><th scope="col" class="col-extra" title="Ganados">G</th><th scope="col" class="col-extra" title="Empatados">E</th><th scope="col" class="col-extra" title="Perdidos">P</th><th scope="col" class="col-extra" title="Goles a favor">GF</th><th scope="col" class="col-extra" title="Goles en contra">GC</th><th scope="col" title="Diferencia de gol">DG</th><th scope="col" title="Puntos">Pts</th></tr></thead>
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
  // Phase G: several group stages (Argentina Apertura / Clausura zones) → stage selector.
  const groupStages = tableStageOptions('GROUP_TABLES');
  if (groupStages.length > 1) {
    if (!groupStages.some((o) => o.key === state.tableStage)) state.tableStage = groupStages[0].key;
    const sel = groupStages.find((o) => o.key === state.tableStage) || groupStages[0];
    const stageGroups = groups.filter((g) => g.stage_code === sel.key);
    setStatus('Torneo', `${stageGroups.length} grupos`);
    return `${subTabsHtml(groupStages, sel.key, 'data-table-stage', 'Etapa')}${
      renderGroupTablesView(stageGroups, sel.stage?.rules || {}) || emptyState('No hay grupos disponibles.')}`;
  }
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
      ? new Date(match.kickoff_at).toLocaleDateString(UI_LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: USER_TIMEZONE })
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

const ELO_TYPE_LABEL = { GLOBAL: 'Global', DOMESTIC: 'Liga local', INTERNATIONAL: 'Selecciones' };

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
  }[status] || ZONE_LABELS[status] || 'Pendiente';
}

function standingsGlobalHtml(rows) {
  const tableRows = rows.map((row) => `
    <tr>
      <td><strong>${row.global_position != null ? num(row.global_position) : '-'}</strong></td>
      <td><strong>${teamMark(row)} ${escapeHtml(row.team_name || '-')}</strong></td>
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
        <div class="flag">${teamMark(row)}</div>
        <div>
          <h3 style="margin:0;font-size:.95rem">${escapeHtml(row.team_name || '-')}</h3>
          <p style="margin:0;color:var(--muted);font-size:.75rem">${escapeHtml(groupLabel(row.group_name || row.group_code || row.stage_name || row.stage_code || ''))}</p>
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
          <div class="flag">${teamMark(team)}</div>
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
        ${teamNationHtml(team)}
      </div>
    </article>`;
}

function teamsFilterControls(data) {
  const af = data.available_filters || {};
  const makeOptions = (items, current, label, text = (v) => v) => {
    const opts = [`<option value="">${label}</option>`]
      .concat((items || []).map((item) => `<option value="${escapeHtml(item)}" ${item === current ? 'selected' : ''}>${escapeHtml(text(item))}</option>`));
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
          <select id="teams-status">${makeOptions(af.statuses, state.teamsFilters.status, 'Estado', qualificationStatusLabel)}</select>
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
  const overlay = createModalOverlay('Cargando equipo');
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
    attachRosterInteractions(overlay, detail.roster || []);
  } catch (error) {
    overlay.innerHTML = `<div class="modal-card"><button class="modal-close" data-close-modal>×</button><div class="error">${escapeHtml(error.message || error)}</div></div>`;
    overlay.querySelector('[data-close-modal]').addEventListener('click', () => closeModal(overlay));
  }
}

function createModalOverlay(loadingLabel) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card"><div class="loading-head"><span>${escapeHtml(loadingLabel)}</span><i></i></div>${skeletonCards(2)}</div>`;
  overlay._returnFocus = document.activeElement;
  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
  return overlay;
}

function closeModal(overlay) {
  const returnFocus = overlay._returnFocus;
  overlay.remove();
  if (!document.querySelector('.modal-overlay')) document.body.classList.remove('modal-open');
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.();
}

function attachRosterInteractions(overlay, roster) {
  let sort = { key: 'minutes', dir: -1 };
  const statsPanel = overlay.querySelector('[data-modal-panel="stats"]');
  const openPlayer = (index) => {
    const player = roster[num(index, -1)];
    if (!player) return;
    overlay.querySelector('.player-card-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'player-card-layer';
    layer.innerHTML = playerCardHtml(player);
    overlay.appendChild(layer);
    const close = () => layer.remove();
    layer.addEventListener('click', (event) => { if (event.target === layer || event.target.closest('[data-close-player]')) close(); });
    layer.querySelector('[data-close-player]')?.focus();
  };
  overlay.addEventListener('click', (event) => {
    const sortBtn = event.target.closest('[data-sort-key]');
    if (sortBtn && statsPanel) {
      const key = sortBtn.dataset.sortKey;
      const column = ROSTER_STAT_COLUMNS.find((c) => c.key === key);
      sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: column?.text ? 1 : -1 };
      statsPanel.innerHTML = rosterStatsTable(roster, sort);
      statsPanel.querySelector(`[data-sort-key="${CSS.escape(key)}"]`)?.focus();
      return;
    }
    const playerEl = event.target.closest('[data-player-index]');
    if (playerEl && !event.target.closest('.player-card-layer')) { openPlayer(playerEl.dataset.playerIndex); return; }
    const matchEl = event.target.closest('[data-match-id]');
    if (matchEl && !event.target.closest('.player-card-layer')) openMatchDetail(matchEl.dataset.matchId);
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-player-index], .team-result-row[data-match-id]');
    if (!row || event.target !== row) return;
    event.preventDefault();
    row.click();
  });
}

function setModalTab(overlay, tab) {
  overlay.querySelectorAll('[data-modal-tab]').forEach((button) => {
    const active = button.dataset.modalTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  overlay.querySelectorAll('[data-modal-panel]').forEach((panel) => { panel.hidden = panel.dataset.modalPanel !== tab; });
}

function teamModalHtml(detail) {
  const team = detail.team || {};
  const matches = detail.matches || [];
  const roster = detail.roster || [];
  return `
    <div class="modal-card team-modal" role="dialog" aria-modal="true" aria-labelledby="team-modal-title">
      <button class="modal-close" data-close-modal aria-label="Cerrar">×</button>
      <header class="modal-header">
        <div class="flag">${teamMark(team)}</div>
        <div>
          <h2 id="team-modal-title">${escapeHtml(team.display_name || 'Equipo')}</h2>
          <p>${escapeHtml(groupLabel(team.group_name || team.group_code) || teamIdentity(team).nation_name || '')}</p>
        </div>
      </header>
      <section class="modal-section">
        <h3>Resultados ${escapeHtml(competitionLabel())}</h3>
        <div class="team-results">${matches.map((m) => teamResultRow(m, team)).join('') || emptyState('No hay partidos publicados para este equipo.')}</div>
      </section>
      <div class="modal-tabs" role="tablist" aria-label="Plantel y estadísticas">
        <button class="active" data-modal-tab="roster" id="modal-tab-roster" type="button" role="tab" aria-selected="true" aria-controls="modal-panel-roster">Plantel</button>
        <button data-modal-tab="stats" id="modal-tab-stats" type="button" role="tab" aria-selected="false" aria-controls="modal-panel-stats">Stats</button>
      </div>
      <section data-modal-panel="roster" id="modal-panel-roster" role="tabpanel" aria-labelledby="modal-tab-roster">${rosterGrid(roster)}</section>
      <section data-modal-panel="stats" id="modal-panel-stats" role="tabpanel" aria-labelledby="modal-tab-stats" hidden>${rosterStatsTable(roster)}</section>
    </div>`;
}

// W/D/L for `teamId` in `match`: team_result when the API sends it, else derived from the score.
function teamSideResult(match, teamId) {
  const given = String(match?.team_result || '').toUpperCase();
  if (['W', 'D', 'L'].includes(given)) return given;
  if (!isFinishedStatus(match?.status)) return '';
  const hs = match?.home_score;
  const as = match?.away_score;
  if (hs === null || hs === undefined || as === null || as === undefined || !teamId) return '';
  const isHome = String(match.home?.team_id || '') === String(teamId);
  const isAway = String(match.away?.team_id || '') === String(teamId);
  if (!isHome && !isAway) return '';
  let mine = num(hs);
  let theirs = num(as);
  if (isAway) [mine, theirs] = [theirs, mine];
  if (mine === theirs) {
    // Penalty shoot-out decides a drawn knockout match.
    const winner = match.winner_team_id;
    if (winner) return String(winner) === String(teamId) ? 'W' : 'L';
    return 'D';
  }
  return mine > theirs ? 'W' : 'L';
}

const RESULT_LABELS = { W: 'G', D: 'E', L: 'P' };
const RESULT_TITLES = { W: 'Ganado', D: 'Empatado', L: 'Perdido' };

function resultChip(result) {
  if (!result) return '<em class="result-chip result-none" aria-label="Sin resultado">-</em>';
  const cls = result === 'W' ? 'result-win' : result === 'L' ? 'result-loss' : 'result-draw';
  return `<em class="result-chip ${cls}" title="${escapeHtml(RESULT_TITLES[result])}">${escapeHtml(RESULT_LABELS[result])}</em>`;
}

function teamResultRow(match, team = {}) {
  const home = match.home || {};
  const away = match.away || {};
  const result = teamSideResult(match, team.team_id);
  const score = match.home_score !== null && match.home_score !== undefined ? `${num(match.home_score)}-${num(match.away_score)}` : 'vs';
  return `
    <div class="team-result-row${match.match_id ? ' clickable-row' : ''}"${match.match_id ? ` data-match-id="${escapeHtml(match.match_id)}" tabindex="0" role="button"` : ''}>
      <span>${escapeHtml(dateLabel(match.kickoff_at).toLowerCase())}</span>
      <strong>${teamMark(home)} ${escapeHtml(home.display_name || 'Por definir')} vs ${teamMark(away)} ${escapeHtml(away.display_name || 'Por definir')}</strong>
      <b>${escapeHtml(score)}</b>
      ${resultChip(result)}
      <small>${escapeHtml(match.venue?.city || match.venue?.display_name || '')}</small>
    </div>`;
}

function rosterGrid(roster) {
  return `<div class="roster-grid">${roster.map((player, index) => `
    <button class="player-pill" type="button" data-player-index="${index}" aria-label="${escapeHtml(`Ver ficha de ${player.display_name || 'jugador'}`)}">
      <span>${escapeHtml(player.position || 'UNK')}</span>
      <strong>${escapeHtml(player.display_name || '')}</strong>
    </button>`).join('') || emptyState('Plantel no disponible.')}</div>`;
}

const ROSTER_STAT_COLUMNS = [
  { key: 'position', label: 'POS', text: true, get: (p) => p.position || '' },
  { key: 'name', label: 'Jugador', text: true, get: (p) => p.display_name || '' },
  { key: 'appearances', label: 'J', title: 'Partidos jugados' },
  { key: 'minutes', label: 'Min', title: 'Minutos' },
  { key: 'goals', label: 'G', title: 'Goles' },
  { key: 'assists', label: 'A', title: 'Asistencias' },
  { key: 'shots_on', label: 'TA arco', title: 'Tiros al arco' },
  { key: 'key_passes', label: 'PC', title: 'Pases clave' },
  { key: 'pass_accuracy', label: 'Pase %', title: 'Precisión de pase', optional: true },
  { key: 'yellow_cards', label: 'TA', title: 'Tarjetas amarillas' },
  { key: 'red_cards', label: 'TR', title: 'Tarjetas rojas' },
  { key: 'avg_rating', label: 'Rating', title: 'Rating promedio', optional: true },
];

function rosterStatValue(player, column) {
  if (column.get) return column.get(player);
  const value = (player.stats || {})[column.key];
  return value === null || value === undefined ? null : num(value);
}

function sortRoster(roster, sort) {
  const column = ROSTER_STAT_COLUMNS.find((c) => c.key === sort.key) || ROSTER_STAT_COLUMNS[3];
  return roster.map((player, index) => ({ player, index })).sort((a, b) => {
    const va = rosterStatValue(a.player, column);
    const vb = rosterStatValue(b.player, column);
    if (column.text) return String(va).localeCompare(String(vb)) * sort.dir;
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // missing values always last
    if (vb === null) return -1;
    return (va - vb) * sort.dir;
  });
}

function rosterStatsTable(roster, sort = { key: 'minutes', dir: -1 }) {
  const rows = sortRoster(roster, sort);
  const head = ROSTER_STAT_COLUMNS.map((column) => {
    const active = column.key === sort.key;
    const ariaSort = active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${ariaSort}"${column.title ? ` title="${escapeHtml(column.title)}"` : ''}><button type="button" class="sort-btn${active ? ' active' : ''}" data-sort-key="${escapeHtml(column.key)}">${escapeHtml(column.label)}${active ? `<span aria-hidden="true">${sort.dir > 0 ? ' ▲' : ' ▼'}</span>` : ''}</button></th>`;
  }).join('');
  return `
    <div class="table-card modal-table">
      <table class="roster-stats-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows.map(({ player, index }) => `<tr data-player-index="${index}" tabindex="0" class="clickable-row">${ROSTER_STAT_COLUMNS.map((column) => {
          const value = rosterStatValue(player, column);
          if (column.key === 'name') return `<td><strong>${escapeHtml(value)}</strong></td>`;
          if (column.text) return `<td>${escapeHtml(value || 'UNK')}</td>`;
          return `<td>${value === null ? '-' : value}</td>`;
        }).join('')}</tr>`).join('') || `<tr><td colspan="${ROSTER_STAT_COLUMNS.length}">${escapeHtml('Sin estadísticas de jugadores para esta temporada.')}</td></tr>`}</tbody>
      </table>
    </div>`;
}

function playerAge(player) {
  if (player.birth_date) {
    const birth = new Date(player.birth_date);
    if (!Number.isNaN(birth.getTime())) {
      const now = new Date();
      let age = now.getFullYear() - birth.getFullYear();
      if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age -= 1;
      if (age > 10 && age < 60) return age;
    }
  }
  const fallback = num(player.metadata_age ?? player.age, 0);
  return fallback > 10 && fallback < 60 ? fallback : null;
}

const POSITION_LABELS = { G: 'Arquero', GK: 'Arquero', GOALKEEPER: 'Arquero', D: 'Defensa', DEFENDER: 'Defensa', M: 'Mediocampista', MIDFIELDER: 'Mediocampista', F: 'Delantero', FORWARD: 'Delantero', ATTACKER: 'Delantero' };

function playerCardHtml(player) {
  const stats = player.stats || {};
  const photo = player.photo_url ? safeUrl(player.photo_url) : '#';
  const age = playerAge(player);
  const position = POSITION_LABELS[String(player.position || '').toUpperCase()] || player.position || 'Sin posición';
  const optional = (value, digits = 0) => (value === null || value === undefined ? '-' : num(value).toFixed(digits));
  const initials = String(player.display_name || '?').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  return `
    <div class="player-card" role="dialog" aria-modal="true" aria-labelledby="player-card-name">
      <button class="modal-close" data-close-player aria-label="Cerrar ficha">×</button>
      <div class="player-card-head">
        ${photo !== '#'
          ? `<img class="player-photo" src="${escapeHtml(photo)}" alt="" loading="lazy" width="72" height="72">`
          : `<div class="player-photo player-photo--empty" aria-hidden="true">${escapeHtml(initials)}</div>`}
        <div>
          <h3 id="player-card-name">${escapeHtml(player.display_name || 'Jugador')}</h3>
          <p>${escapeHtml(position)}${player.shirt_number != null ? ` · #${num(player.shirt_number)}` : ''}${age ? ` · ${num(age)} años` : ''}</p>
        </div>
      </div>
      <div class="player-card-stats">
        <div><b>${num(stats.appearances)}</b><span>Partidos</span></div>
        <div><b>${num(stats.minutes)}</b><span>Minutos</span></div>
        <div><b>${num(stats.goals)}</b><span>Goles</span></div>
        <div><b>${num(stats.assists)}</b><span>Asistencias</span></div>
        <div><b>${optional(stats.avg_rating, 2)}</b><span>Rating</span></div>
        <div><b>${num(stats.yellow_cards)}/${num(stats.red_cards)}</b><span>TA/TR</span></div>
      </div>
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
      <div class="tie-leg"${matchDetailAttrs(leg)}>
        <span class="tie-leg-label">${legNo === 1 ? 'Ida' : legNo === 2 ? 'Vuelta' : `Partido ${legNo}`}</span>
        <span>${escapeHtml(teamShortName(leg.home))} <b>${escapeHtml(score)}</b> ${escapeHtml(teamShortName(leg.away))}${pen ? ` <small>(pen ${pen.home}-${pen.away})</small>` : ''}</span>
        <span>${escapeHtml(leg.kickoff_at ? dateLabel(leg.kickoff_at).toLowerCase() : 'Por definir')}</span>
      </div>`;
  };
  const agg = tie.aggregate;
  return `
    <article class="card bracket-card tie-card fade-in">
      <div class="bracket-team">${teamMark(tie.teamA)} <strong>${escapeHtml(teamName(tie.teamA))}</strong>${teamBadges(tie.teamA)}</div>
      <div class="bracket-team">${teamMark(tie.teamB)} <strong>${escapeHtml(teamName(tie.teamB))}</strong>${teamBadges(tie.teamB)}</div>
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
        <span class="bracket-node-flag">${teamMark(tie.teamA)}</span>
        <span class="bracket-node-name">${escapeHtml(teamName(tie.teamA))}</span>${teamBadges(tie.teamA)}
        ${agg ? `<span class="bracket-node-score${aWin ? ' bracket-node-score--win' : ''}">${agg.a}</span>` : ''}
      </div>
      <div class="bracket-node-divider"></div>
      <div class="bracket-node-team${bWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamMark(tie.teamB)}</span>
        <span class="bracket-node-name">${escapeHtml(teamName(tie.teamB))}</span>${teamBadges(tie.teamB)}
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
  await loadBracketBadges(stages, ctx.options);
  setStatus('Torneo', matches.length ? `${matches.length} partidos` : 'Llaves por definir');
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
        <span class="bracket-node-flag">${teamMark(match.home)}</span>
        <span class="bracket-node-name">${escapeHtml(match.home?.display_name || match.home?.slot_label || '?')}</span>${teamBadges(match.home)}
        ${hasScore ? `<span class="bracket-node-score${homeWin ? ' bracket-node-score--win' : ''}">${num(match.home_score)}</span>` : ''}
      </div>
      <div class="bracket-node-divider"></div>
      <div class="bracket-node-team${awayWin ? ' bracket-node-team--winner' : ''}">
        <span class="bracket-node-flag">${teamMark(match.away)}</span>
        <span class="bracket-node-name">${escapeHtml(match.away?.display_name || match.away?.slot_label || '?')}</span>${teamBadges(match.away)}
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
      ${stageFormatNote(stage)}
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
    <article class="card bracket-card fade-in"${matchDetailAttrs(match)}>
      <div class="bracket-top"><span>${escapeHtml(match.match_number ? `Partido ${match.match_number}` : 'Partido')}</span><b>${escapeHtml(userDateTimeLabel(match.kickoff_at))}</b></div>
      <div class="bracket-team">${teamMark(match.home)} <strong>${escapeHtml(match.home?.display_name || match.home?.slot_label || 'Por definir')}</strong>${teamBadges(match.home)}</div>
      <div class="bracket-vs">${matchScore(match)}</div>
      <div class="bracket-team">${teamMark(match.away)} <strong>${escapeHtml(match.away?.display_name || match.away?.slot_label || 'Por definir')}</strong>${teamBadges(match.away)}</div>
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

// ─── Phase G: derived tables (acumulada / promedios), seeds, "viene de" ─────────

function derivedStage(viewType) {
  return (state.layout?.stages || []).find((s) => String(s.view_type || '').toUpperCase() === viewType) || null;
}

function derivedRows(groups, stage) {
  const rows = groups.filter((g) => stage && g.stage_code === stage.stage_code).flatMap((g) => g.standings || []);
  return [...rows].sort((a, b) => num(a.position, 999) - num(b.position, 999));
}

async function renderAggregateTableMode(ctx) {
  const stage = derivedStage('AGGREGATE_TABLE');
  const rows = derivedRows(await fetchStandingsGroups(ctx.options), stage);
  if (!rows.length) return emptyState('La tabla acumulada se calcula tras el próximo refresco de posiciones.');
  const zones = zonesFromRules(stage?.rules || {}, rows.length, 'AGGREGATE_TABLE');
  const sources = (stage?.rules?.aggregate_of || []).map((code) => layoutStage(code)?.stage_label || code);
  setStatus('Torneo', 'Tabla acumulada');
  return `
    <section class="group-block fade-in">
      <h2 class="section-title">${escapeHtml(stage?.stage_label || 'Tabla acumulada')}</h2>
      ${sources.length ? `<p class="derived-note">Suma de ${escapeHtml(sources.join(' + '))}</p>` : ''}
      ${_standingsTable(rows, zones)}
      ${zoneLegendHtml(zones)}
    </section>`;
}

function averageValue(row) {
  const avg = Number(row?.derived?.average);
  return Number.isFinite(avg) ? avg : (num(row.played) ? num(row.points) / num(row.played) : 0);
}

async function renderAveragesTableMode(ctx) {
  const stage = derivedStage('AVERAGES_TABLE');
  const rows = derivedRows(await fetchStandingsGroups(ctx.options), stage);
  if (!rows.length) return emptyState('La tabla de promedios se calcula tras el próximo refresco de posiciones.');
  const zones = zonesFromRules(stage?.rules || {}, rows.length, 'AVERAGES_TABLE');
  const seasons = num(stage?.rules?.averages?.seasons, 3) || 3;
  setStatus('Torneo', 'Promedios');
  const body = rows.map((row, i) => {
    const pos = num(row.position, i + 1) || i + 1;
    const zone = zoneForPosition(zones, pos);
    const used = num(row.derived?.seasons_used);
    return `
      <tr class="${['standings-main', zone ? zoneClass(zone.code) : ''].filter(Boolean).join(' ')}">
        <td>${pos}${zone ? `<span class="sr-only"> (${escapeHtml(zone.label)})</span>` : ''}</td>
        <td class="col-team"><strong>${teamMark(row)} <span class="team-label">${escapeHtml(row.team_name || '-')}</span></strong>${used && used < seasons ? ` <small class="avg-seasons">${num(used)} temp.</small>` : ''}</td>
        <td>${num(row.played)}</td>
        <td>${num(row.points)}</td>
        <td class="col-pts"><strong>${escapeHtml(averageValue(row).toFixed(3))}</strong></td>
      </tr>`;
  }).join('');
  return `
    <section class="group-block fade-in">
      <h2 class="section-title">${escapeHtml(stage?.stage_label || 'Promedios')}</h2>
      <p class="derived-note">Puntos por partido de las últimas ${num(seasons)} temporadas (ascendidos: solo las jugadas).</p>
      <div class="card table-card standings-card">
        <table class="standings-table averages-table">
          <thead><tr><th scope="col">#</th><th scope="col">Equipo</th><th scope="col" title="Partidos jugados">PJ</th><th scope="col" title="Puntos">Pts</th><th scope="col" title="Promedio">Prom.</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${zoneLegendHtml(zones)}
    </section>`;
}

// team_id → { seed, origin } for the knockout view (seeds from rules.seeding, origins from layout).
async function loadBracketBadges(stages, options) {
  const badges = new Map();
  for (const stage of stages) {
    for (const origin of stage.origins || []) {
      if (origin?.team_id) badges.set(String(origin.team_id), { ...(badges.get(String(origin.team_id)) || {}), origin: String(origin.label || '') });
    }
  }
  const seedStage = stages.map((s) => s.rules?.seeding?.from_stage).find(Boolean);
  if (seedStage) {
    try {
      const groups = await fetchStandingsGroups(options);
      const wanted = new Set((stages.find((s) => s.rules?.seeding)?.rules?.seeding?.positions || []).map(Number));
      for (const row of groups.filter((g) => g.stage_code === seedStage).flatMap((g) => g.standings || [])) {
        const pos = num(row.position);
        if (!row.team_id || !pos || (wanted.size && !wanted.has(pos))) continue;
        badges.set(String(row.team_id), { ...(badges.get(String(row.team_id)) || {}), seed: pos });
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
    }
  }
  state.bracketBadges = badges;
}

function teamBadges(team) {
  const id = String(team?.team_id || team?.id || '');
  const badge = id && state.bracketBadges ? state.bracketBadges.get(id) : null;
  if (!badge) return '';
  const seed = badge.seed ? `<span class="seed-badge" title="Sembrado ${num(badge.seed)}">${num(badge.seed)}</span>` : '';
  const origin = badge.origin ? `<span class="origin-badge" title="Viene de: ${escapeHtml(badge.origin)}" aria-label="Viene de: ${escapeHtml(badge.origin)}">${escapeHtml(badge.origin)}</span>` : '';
  return ` ${seed}${origin}`;
}

function stageFormatNote(stage) {
  const rules = stage?.rules || {};
  const notes = [];
  if (rules.series === 'BEST_OF_3') notes.push('Serie al mejor de 3');
  else if (num(stage?.legs) > 1) notes.push('Ida y vuelta');
  else if (rules.single_leg || num(stage?.legs) === 1) notes.push('Partido único');
  if (rules.extra_time && num(stage?.legs) <= 1 && rules.series !== 'BEST_OF_3') notes.push('alargue');
  if (rules.penalties) notes.push('penales');
  if (rules.seeding) notes.push('sembrados por tabla');
  return notes.length ? `<p class="stage-format-note">${escapeHtml(notes.join(' · '))}</p>` : '';
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
  PLAYOFF_BRACKET: renderBracketMode,
  AGGREGATE_TABLE: renderAggregateTableMode,
  AVERAGES_TABLE: renderAveragesTableMode,
  QUALIFICATION_SUMMARY: renderQualificationMode,
  GENERIC: renderGenericTable,
};

function resolveRenderer(view) {
  const mode = String(view?.render_mode || view?.view_type || '').toUpperCase();
  if (RENDERERS[mode]) return RENDERERS[mode];
  // Legacy keys without a render_mode.
  const byKey = { groups: 'GROUP_TABLES', table: 'LEAGUE_TABLE', fixtures: 'MATCH_LIST', knockout: 'BRACKET', qualified: 'QUALIFICATION_SUMMARY', aggregate: 'AGGREGATE_TABLE', averages: 'AVERAGES_TABLE' }[view?.key];
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
            ${(data.rating_types || []).map((value) => `<option value="${escapeHtml(value)}" ${value === data.rating_type ? 'selected' : ''}>${escapeHtml(ELO_TYPE_LABEL[value] || value)}</option>`).join('')}
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
  setStatus('ELO', `${teams.length} equipos · ${ELO_TYPE_LABEL[data.rating_type] || data.rating_type || ''}`.trim());
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
  const aiAdj = explanation?.ai_adjustment || null;
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
    aiMode: aiAdj?.policy?.mode || null,
    aiFactors: Array.isArray(aiAdj?.factors) ? aiAdj.factors.slice(0, 4) : [],
    aiKeyFactors: Array.isArray(aiAdj?.key_factors) ? aiAdj.key_factors.slice(0, 3) : [],
    marketLabel: marketLabel(raw.market_code, explanation),
    topFactors: topModelFactors(explanation),
  };
}

// Phase F: market label (1X2 / O-U 2.5 / BTTS) and top model factors (feature contributions + Dixon-Coles).
function marketLabel(code, explanation) {
  const c = String(code || '').toUpperCase();
  if (c === 'OVER_UNDER') return `O/U ${explanation?.line != null ? Number(explanation.line) : 2.5}`;
  if (c === 'BTTS') return 'BTTS';
  return c || '1X2';
}

function topModelFactors(explanation) {
  const out = [];
  const dc = explanation?.dixon_coles;
  if (dc && Array.isArray(dc.top_scores) && dc.top_scores.length) {
    out.push(`Marcador probable ${dc.top_scores[0].score} (${Math.round(Number(dc.top_scores[0].p || 0) * 100)}%)`);
  }
  const contrib = Array.isArray(explanation?.feature_contributions) ? explanation.feature_contributions : [];
  const labels = { elo_diff: 'Dif. ELO', attack_strength: 'Ataque', defense_strength: 'Defensa rival', rest_days: 'Descanso' };
  contrib.filter((f) => f && f.value != null && f.feature !== 'rest_days').slice(0, 2).forEach((f) => {
    out.push(`${labels[f.feature] || f.feature} ${Number(f.value).toFixed(f.feature === 'elo_diff' ? 0 : 2)}`);
  });
  const mk = explanation?.market;
  if (mk && mk.n_books) out.push(`${mk.n_books} casas`);
  return out.slice(0, 3);
}

function modelFactorsLine(opp) {
  if (!opp.topFactors || !opp.topFactors.length) return '';
  return `<div class="ev-model-factors">${opp.topFactors.map((f) => `<span class="chip chip--muted">${escapeHtml(f)}</span>`).join('')}</div>`;
}

function aiFactorsBlock(opp) {
  if (!opp.aiFactors.length && !opp.aiKeyFactors.length) return '';
  const mode = opp.aiMode ? ` (${aiModeLabel(opp.aiMode)})` : '';
  const items = opp.aiFactors.length
    ? opp.aiFactors.map((f) => `<li><span class="chip chip--muted">${escapeHtml(f.category || 'other')}</span> ${escapeHtml(f.description || '')}${f.impact_pp != null && Number(f.impact_pp) !== 0 ? ` <b>${Number(f.impact_pp) > 0 ? '+' : ''}${escapeHtml(Number(f.impact_pp).toFixed(1))}pp</b>` : ''}</li>`).join('')
    : opp.aiKeyFactors.map((k) => `<li>${escapeHtml(k)}</li>`).join('');
  return `<details class="ev-ai-factors"><summary>Factores IA${escapeHtml(mode)}</summary><ul style="margin:.3rem 0 0;padding-left:1rem;font-size:.75rem">${items}</ul></details>`;
}

function aiModeLabel(mode) {
  return { ACTIVE: 'activa', SHADOW: 'sombra', OFF: 'apagada' }[mode] || String(mode || '—');
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
  LEGACY_IMPORT: 'Dato histórico',
  ODDS_CAPTURED_AFTER_KICKOFF: 'Cuota posterior al inicio',
  PAPER_ONLY_BACKFILL: 'Análisis histórico',
  EV_OUTLIER: 'Valor atípico',
};

const BLOCK_REASON_DESC = {
  NO_CALIBRATION: 'El modelo de esta liga aún no está calibrado: necesita al menos 30 resultados.',
  LOW_CONFIDENCE: 'La confianza de la predicción es baja (faltan datos del partido).',
  ODDS_STALE: 'La última cuota disponible tiene más de 2 horas.',
  LOW_LIQUIDITY: 'Mercado con poca liquidez: la cuota puede no ser representativa.',
  COMPETITION_NOT_BETTABLE: 'Esta competición está en observación: el modelo aún se está validando.',
  LEGACY_IMPORT: 'Registro importado de datos históricos.',
  ODDS_CAPTURED_AFTER_KICKOFF: 'La cuota se registró después del inicio del partido.',
  PAPER_ONLY_BACKFILL: 'Registro histórico, solo para análisis.',
  EV_OUTLIER: 'Valor esperado mayor a 40%: muy improbable en mercados líquidos, se descarta por precaución.',
};

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
          <div class="ev-hero-match-date">${escapeHtml(opp.kickoffAt ? userDateTimeLabel(opp.kickoffAt) : '')}</div>
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
          <span class="chip chip--warn">${escapeHtml(opp.marketLabel || opp.marketCode || '1X2')}</span>
          <span class="chip chip--blue">${escapeHtml(opp.selectionLabel || opp.selectionCode || '—')}</span>
          ${confPct != null ? `<div class="confidence-ring" data-level="${confLevel}" title="Confidence: ${confPct}%">${confPct}</div>` : ''}
        </div>
        ${modelFactorsLine(opp)}
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

  const kickoff = opp.kickoffAt ? userDateTimeLabel(opp.kickoffAt) : '';
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
        ${modelFactorsLine(opp)}
        ${aiFactorsBlock(opp)}
      </td>
      <td class="ev-td-market">${escapeHtml(opp.marketLabel || opp.marketCode || '—')}</td>
      <td class="ev-td-sel"><b>${escapeHtml(opp.selectionLabel || opp.selectionCode || '—')}</b></td>
      <td class="ev-td-num">${opp.modelProb != null ? `<b>${fmtPct(opp.modelProb)}</b>` : '—'}</td>
      <td class="ev-td-num ev-market-prob">${opp.marketProb != null ? fmtPct(opp.marketProb) : '—'}</td>
      <td class="ev-td-odds">${fairArrow}${overlay}</td>
      <td class="ev-td-num ${edgeHeat}">${opp.edge != null ? `${opp.edge >= 0 ? '+' : ''}${(opp.edge * 100).toFixed(1)}pp` : '—'}</td>
      <td class="ev-td-num ${evHeat}">${opp.ev != null ? fmtPct(opp.ev) : '—'}${isOutlier ? ' <span class="chip chip--muted" title="EV outlier — modelo descalibrado">OUTLIER</span>' : ''}</td>
      <td class="ev-td-num">${opp.kellyFraction != null ? `${fmtPct(opp.kellyFraction)}<br><span class="ev-kelly-label">${opp.decisionStatus === 'BETTABLE' ? 'Apostable' : opp.decisionStatus === 'PAPER_ONLY' ? 'Solo papel' : 'Bloqueado'}</span>` : '—'}</td>
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
    { label: 'Apostables', value: bettable, cls: bettable ? 'metric-card--ok' : '' },
    { label: 'Solo papel', value: paper, cls: paper ? 'metric-card--warn' : '' },
    { label: 'Bloqueados', value: blocked.length, cls: '' },
    { label: 'EV promedio', value: avgEV != null ? fmtPct(avgEV) : '—', cls: avgEV > 0 ? 'metric-card--ok' : '' },
    { label: 'Kelly prom.', value: avgKelly != null ? fmtPct(avgKelly) : '—', cls: '' },
    { label: 'Confianza', value: avgConf != null ? fmtPct(avgConf) : '—', cls: avgConf != null && avgConf >= 0.6 ? 'metric-card--ok' : avgConf != null && avgConf >= 0.3 ? 'metric-card--warn' : '' },
  ];
  return `<div class="ev-summary-bar">${cards.map((c) => `
    <div class="metric-card ${c.cls}">
      <div class="metric-card__value">${escapeHtml(String(c.value))}</div>
      <div class="metric-card__label">${escapeHtml(c.label)}${c.help ? ` ${metricHelp(c.help)}` : ''}</div>
    </div>`).join('')}</div>`;
}

function blockReasonsSection(blocked) {
  if (!blocked.length) return infoEmptyState('🔒', 'Sin bloqueos activos', 'No hay decisiones bloqueadas en este momento.');
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
  if (!tooltip.dataset.bound) {
    // Bound once: renderEV runs on every refresh and must not stack document listeners.
    document.addEventListener('click', () => tooltip.classList.remove('visible'));
    tooltip.dataset.bound = '1';
  }
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
    : infoEmptyState('📊', 'Sin oportunidades EV+', 'Hoy el modelo no encuentra diferencias favorables frente a las cuotas del mercado. Aparecerán aquí cuando las haya.');

  const overpricedHtml = negativeEV.length
    ? `<div class="ev-table-wrap"><table class="ev-table">${EV_TABLE_HEAD}<tbody>${negativeEV.map((o) => evOpportunityRow({ ...o, decisionStatus: 'BLOCKED' })).join('')}</tbody></table></div>`
    : infoEmptyState('✅', 'Sin mercados sobrepreciados', 'No hay selecciones con EV negativo en este momento.');

  const calibrationNote = positiveEV.length && positiveEV.every((o) => o.predictionStatus === 'RAW_ONLY')
    ? infoEmptyState('🔬', 'Modelo en calibración', 'El modelo aún no está calibrado (necesita al menos 30 resultados). Las oportunidades se muestran solo como seguimiento.')
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

// Real coverage from GET /model/feature-health (no hardcoded values).
function featureHealthGrid(items) {
  if (!Array.isArray(items) || !items.length) return emptyState('Cobertura de features no disponible.');
  return `<div class="feature-health-grid">${items.map((f) => {
    const status = ['ok', 'partial'].includes(f.status) ? f.status : 'pending';
    const dotCls = status === 'ok' ? 'health-dot--ok' : status === 'partial' ? 'health-dot--partial' : 'health-dot--pending';
    const chipCls = status === 'ok' ? 'chip--ok' : status === 'partial' ? 'chip--warn' : 'chip--muted';
    const chipLabel = status === 'ok' ? 'OK' : status === 'partial' ? 'Parcial' : 'Pendiente';
    const total = num(f.total);
    const coverage = total ? `${num(f.have)}/${total} · ${num(f.coverage_pct)}%` : 'sin partidos en ventana';
    const detail = `${f.scope || ''}${f.freshness ? ` · actualizado ${dateLabel(f.freshness)}` : ''}`;
    return `
      <div class="feature-health-item" title="${escapeHtml(detail)}">
        <span class="health-dot ${dotCls}"></span>
        <div class="feature-health-meta">
          <span class="feature-health-name">${escapeHtml(f.label || f.key || '')}</span>
          <span class="feature-health-sub">${escapeHtml(f.scope || '')} · ${escapeHtml(coverage)}</span>
        </div>
        <span class="chip ${chipCls}" style="margin-left:auto;font-size:.75rem;flex-shrink:0">${chipLabel}</span>
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

// User-facing names for internal model / method codes.
const MODEL_NAME_LABEL = { poisson_elo_v1: 'Poisson + ELO', dixon_coles_v1: 'Dixon-Coles', lgbm_v1: 'Gradient boosting' };
const MODEL_FAMILY_LABEL = { POISSON: 'Goles (Poisson)', DIXON_COLES: 'Goles (Dixon-Coles)', LIGHTGBM: 'Aprendizaje automático', LGBM: 'Aprendizaje automático' };
const CALIBRATION_METHOD_LABEL = { ISOTONIC: 'Isotónica', PLATT: 'Platt', PENDING: 'Pendiente' };

function modelStatusCards(diagnostics) {
  if (!diagnostics.length) return infoEmptyState('🤖', 'Modelo en preparación', 'Todavía no hay un modelo activo para mostrar.');
  const champion = diagnostics.find((d) => d.champion_status === 'CHAMPION') || diagnostics[0];
  const cards = [
    { label: 'Modelo activo', value: MODEL_NAME_LABEL[champion.model_name] || 'Modelo estadístico', cls: 'metric-card--blue' },
    { label: 'Versión', value: champion.model_version || '—', cls: '' },
    { label: 'Tipo', value: MODEL_FAMILY_LABEL[String(champion.model_family || '').toUpperCase()] || 'Estadístico', cls: '' },
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
  if (!calibration.length) return infoEmptyState('🔬', 'Sin calibración', 'El modelo aún no está calibrado: necesita al menos 30 resultados.');
  const latest = calibration[0];
  const n = latest.sample_size ?? 0;
  const lowN = n < 30;
  return `
    <div class="cal-summary-row">
      <span>ECE: <b>${fmtNum(latest.ece, 4)}</b></span>
      <span>Brier: <b>${fmtNum(latest.brier_score, 4)}</b></span>
      <span>Método: <b>${escapeHtml(CALIBRATION_METHOD_LABEL[String(latest.method || '').toUpperCase()] || '—')}</b></span>
      <span>n: <b>${n}</b></span>
    </div>
    ${lowN ? '<div class="cal-warn">⚠️ Datos insuficientes: el gráfico de calibración aparece en Stats con 30 resultados o más</div>' : ''}
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
        <span class="cal-progress-count${ready ? ' cal-progress-count--ready' : ''}">${settled}/${target} resultados</span>
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
  let diagnostics = [], calibration = [], healthItems = [];
  try {
    const [diagData, calData, healthData] = await Promise.all([
      cached('model/diagnostics', {}, 120000, options),
      cached('calibration/summary', { limit: 5 }, 120000, options),
      cached('model/feature-health', {}, 120000, options).catch(() => ({ items: [] })),
    ]);
    diagnostics = diagData.models || [];
    calibration = calData.calibration || [];
    healthItems = healthData?.items || [];
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
        ${featureHealthGrid(healthItems)}
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

let _chartJsPromise = null;

// Chart.js is only needed by the Stats view: inject it on first use (F-A.7).
function loadChartJs() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!_chartJsPromise) {
    _chartJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(window.Chart);
      script.onerror = () => { _chartJsPromise = null; reject(new Error('No se pudo cargar Chart.js')); };
      document.head.appendChild(script);
    });
  }
  return _chartJsPromise;
}

function destroyChart(id) {
  if (typeof Chart === 'undefined') return;
  const existing = Chart.getChart(id);
  if (existing) existing.destroy();
}

function calibrationBucketChart(calibrationData) {
  const id = 'cal-bucket-chart';
  const bins = Array.from({ length: 10 }, (_, i) => `${i * 10}-${i * 10 + 10}%`);
  if (!calibrationData.length) return `<div class="chart-wrap">${infoEmptyState('📊', 'Sin datos de calibración', 'Se necesitan al menos 30 resultados.')}</div>`;
  return `
    <div class="chart-wrap">
      <canvas id="${id}"></canvas>
    </div>
    <p style="font-size:.75rem;color:var(--muted);margin:.4rem 0 0">Barras = tasa observada. Línea = predicha. La diagonal perfecta = calibración ideal.</p>`;
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
  if (!window.MA_STATS.roiByEvReadiness(buckets).points.length) return `<div class="chart-wrap">${infoEmptyState('📊', 'Sin datos', 'Se necesitan picks con resultado para calcular el ROI por rango de EV.')}</div>`;
  return `<div class="chart-wrap"><canvas id="${id}"></canvas></div>`;
}

function initRoiChart(buckets) {
  destroyChart('roi-ev-chart');
  const canvas = document.getElementById('roi-ev-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  // Buckets without a ROI are left out: a 0 bar would read as a real break-even result.
  const points = window.MA_STATS.roiByEvReadiness(buckets).points;
  if (!points.length) return;
  const labels = points.map((b) => b.ev_bucket);
  const roiData = points.map((b) => Number(b.roi_pct));
  const colors = roiData.map((v) => v >= 0 ? 'rgba(30,215,96,.6)' : 'rgba(255,99,117,.6)');
  new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'ROI %', data: roiData, backgroundColor: colors, borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#9fb0c3', font: { size: 10 }, callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,.06)' } }, x: { ticks: { color: '#9fb0c3', font: { size: 10 } }, grid: { display: false } } } },
  });
}

function picksByStatusChart(summary) {
  const id = 'picks-donut-chart';
  if (!summary.decisionRows.length) return `<div class="chart-wrap">${infoEmptyState('🍩', 'Sin picks', 'No hay decisiones registradas aún.')}</div>`;
  return `<div class="chart-wrap"><canvas id="${id}"></canvas></div>`;
}

function initPicksDonut(summary) {
  destroyChart('picks-donut-chart');
  const canvas = document.getElementById('picks-donut-chart');
  if (!canvas || typeof Chart === 'undefined' || !summary.decisionRows.length) return;
  const STATUS_COLORS = { BETTABLE: '#1ed760', PAPER_ONLY: '#f4c542', NO_EDGE: '#6f8399', BLOCKED: '#3d4f61' };
  const rows = summary.decisionRows;
  new Chart(canvas, {
    type: 'doughnut',
    data: { labels: rows.map((r) => r.label), datasets: [{ data: rows.map((r) => r.count), backgroundColor: rows.map((r) => STATUS_COLORS[r.status] || '#3d4f61'), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#9fb0c3', font: { size: 11 }, padding: 12 } } } },
  });
}

function statsKpiBar(calibration, buckets) {
  const latest = calibration[0] || {};
  // Same ROI as the summary card (buckets without a ROI are not averaged in as 0).
  const totalROI = window.MA_STATS.performanceSummary({ calibration, buckets, clv: null }).roi;
  const cards = [
    { label: 'Brier Score', value: fmtNum(latest.brier_score, 4), cls: '' },
    { label: 'Log Loss', value: fmtNum(latest.log_loss, 4), cls: '' },
    { label: 'ECE', value: fmtNum(latest.ece, 4), cls: '' },
    { label: 'ROI (stake del modelo)', value: totalROI != null ? `${fmtNum(totalROI, 1)}%` : '—', cls: totalROI > 0 ? 'metric-card--ok' : totalROI < 0 ? 'metric-card--danger' : '' },
    { label: 'Muestra Brier / LL / ECE', value: latest.sample_size ?? 0, cls: '', help: 'sample_calibration' },
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
  if (!window.MA_STATS.historyReadiness(series).show) return infoEmptyState('📈', 'Sin datos en los últimos 30 días', 'La serie aparece cuando hay métricas diarias con resultados (Brier, log-loss, ECE, CLV o ROI).');
  return `
    <div class="chart-wrap"><canvas id="${id}" aria-label="${escapeHtml('Historial diario de métricas del modelo')}" role="img"></canvas></div>
    <p style="font-size:.75rem;color:var(--muted);margin:.4rem 0 0">${escapeHtml('Eje izq.: Brier, log-loss, ECE (menor = mejor). Eje der.: CLV y ROI (stake del modelo).')}</p>`;
}

function initMetricsHistoryChart(series) {
  destroyChart('metrics-history-chart');
  const canvas = document.getElementById('metrics-history-chart');
  if (!canvas || !window.MA_STATS.historyReadiness(series).show || typeof Chart === 'undefined') return;
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
        line('ROI', 'paper_roi', 'rgba(255,99,117,.9)', 'y1', true),
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
          <div><strong>Resultados automáticos</strong><small>Resultados registrados y picks liquidados</small></div>
        </div>
        <div class="stats-roadmap-step">
          <span class="stats-step-dot">◯</span>
          <div><strong>Stats y calibración</strong><small>Brier score, ROI, calibration chart disponibles</small></div>
        </div>
      </div>
    </div>`;
}

// Phase F: model stage names used in the market comparison details.
const MARKET_STAGE_LABEL = { calibrated: 'calibrado', ensemble: 'ensamble', pre: 'pre-calib.', dixon_coles: 'Dixon-Coles', poisson: 'Poisson' };

// ─── Stats view ──────────────────────────────────────────────────────────────
// Three internal tabs (Rendimiento / Modelo / IA). Interpretation (sample maturity, verdicts, AI impact)
// lives in js/stats-insights.js (MA_STATS, unit-tested); this section only renders.

const METRIC_HELP = {
  brier: 'Error de las probabilidades. Menor es mejor.',
  logloss: 'Penaliza especialmente las predicciones muy seguras que fallan. Menor es mejor.',
  ece: 'Qué tan bien calibradas están las probabilidades. Menor es mejor.',
  clv: 'Compara la cuota obtenida con la cuota de cierre del mercado. Positivo es mejor.',
  roi: 'ROI simulado (sin dinero real) con el stake que sugiere el modelo para cada pick: ganancia ÷ total apostado. Difiere del Historial, que usa 1 unidad fija por pick.',
  sample_settled: 'Decisiones del sistema (una por predicción y selección) cuyo partido ya tiene resultado. Cada métrica indica debajo su propio n.',
  sample_calibration: 'Predicciones con resultado (una fila por selección: local, empate, visita) de la última calibración, de una liga y mercado. Brier, log-loss y ECE se calculan sobre ellas.',
  decisions: 'Una decisión es la evaluación de una selección de un partido (p. ej. Local en 1X2). Estado y resultado son dimensiones distintas: cada decisión tiene uno de cada.',
};

function metricHelp(key) {
  const text = METRIC_HELP[key];
  if (!text) return '';
  return `<details class="metric-help"><summary aria-label="${escapeHtml(`Qué significa: ${text}`)}">?</summary><span>${escapeHtml(text)}</span></details>`;
}

function sampleBadge(maturity) {
  const cls = maturity.sufficient ? 'sample-badge--ok' : 'sample-badge--warn';
  const icon = maturity.sufficient ? '🟢' : '🟡';
  return `
    <div class="sample-badge ${cls}">
      <span class="sample-badge__label">${deco(icon)} ${escapeHtml(maturity.label)}</span>
      <span class="sample-badge__count">${escapeHtml(maturity.countLabel)}</span>
      <span class="sample-badge__bar" role="progressbar" aria-valuemin="0" aria-valuemax="${maturity.min}" aria-valuenow="${Math.min(maturity.n, maturity.min)}" aria-label="${escapeHtml(maturity.countLabel)}"><i style="width:${Math.round(maturity.progress * 100)}%"></i></span>
    </div>`;
}

// Empty state that tells "no observations" (NO_DATA) apart from "some, below the minimum" (INSUFFICIENT).
function sampleEmptyState(icon, maturity, { noData, insufficient }) {
  const [title, text] = maturity.status === 'NO_DATA' ? noData : insufficient;
  return infoEmptyState(icon, title, text, maturity.status === 'NO_DATA' ? null : maturity);
}

// The one rich empty state (icon + title + text, optional sample badge). emptyState() is the one-line variant.
function infoEmptyState(icon, title, text, maturity) {
  return `
    <div class="quant-empty stats-empty">
      <div class="quant-empty__icon">${icon}</div>
      <div class="quant-empty__title">${escapeHtml(title)}</div>
      <div class="quant-empty__text">${escapeHtml(text)}</div>
      ${maturity ? sampleBadge(maturity) : ''}
    </div>`;
}

const fmt4 = (v) => (v != null && !Number.isNaN(Number(v)) ? Number(v).toFixed(4) : '—');
const fmtPctFrac = (v) => (v != null && !Number.isNaN(Number(v)) ? `${(Number(v) * 100).toFixed(1)}%` : '—');

function performanceSummaryCard(summary) {
  const roiCls = summary.roi > 0 ? 'metric-card--ok' : summary.roi < 0 ? 'metric-card--danger' : '';
  const clvLabel = summary.clvDays ? `CLV (${summary.clvDays} días)` : 'CLV';
  const nLine = (n, what) => (n == null ? '' : `<div class="metric-card__n">n = ${escapeHtml(String(n))} ${escapeHtml(what)}</div>`);
  return `
    <article class="card perf-summary">
      <header class="perf-summary__head">
        <h3>Rendimiento del modelo</h3>
        <span class="perf-summary__n"><b>${escapeHtml(String(summary.settled))}</b> decisiones con resultado ${metricHelp('sample_settled')}</span>
      </header>
      <div class="kpi-bar perf-summary__kpis">
        <div class="metric-card ${roiCls}"><div class="metric-card__value">${summary.roi != null ? `${fmtNum(summary.roi, 1)}%` : '—'}</div><div class="metric-card__label">ROI (stake del modelo) ${metricHelp('roi')}</div>${nLine(summary.roiN, 'con stake')}</div>
        <div class="metric-card"><div class="metric-card__value">${summary.clv != null ? escapeHtml(fmtPctFrac(summary.clv)) : '—'}</div><div class="metric-card__label">${escapeHtml(clvLabel)} ${metricHelp('clv')}</div>${nLine(summary.clvN, 'con cierre')}</div>
        <div class="metric-card"><div class="metric-card__value">${escapeHtml(fmt4(summary.brier))}</div><div class="metric-card__label">Brier ${metricHelp('brier')}</div>${summary.brier != null ? nLine(summary.brierN, summary.brierScope ? `predicciones · ${summary.brierScope}` : 'predicciones') : ''}</div>
      </div>
      ${sampleBadge(summary.maturity)}
      ${summary.maturity.sufficient ? '' : '<p class="perf-summary__note">Resultados preliminares: todavía no son evidencia estadística concluyente.</p>'}
    </article>`;
}

function marketTechGrid(c) {
  const diff = c.vs_market_ll_diff;
  const diffCls = diff == null ? '' : diff < 0 ? 'market-card__diff--good' : 'market-card__diff--bad';
  return `
    <div class="market-card__grid">
      <span>Log-loss ${escapeHtml(MARKET_STAGE_LABEL[c.model_stage] || 'modelo')}</span><b>${escapeHtml(fmt4(c.model_log_loss))}</b>
      <span>Log-loss mercado</span><b>${escapeHtml(fmt4(c.market_log_loss))}</b>
      <span>Diferencia vs mercado</span><b class="${diffCls}">${diff == null ? '—' : escapeHtml(`${diff > 0 ? '+' : ''}${Number(diff).toFixed(4)}`)}</b>
      <span>ECE</span><b>${escapeHtml(fmt4(c.model_ece))}</b>
      <span>CLV medio</span><b>${escapeHtml(fmtPctFrac(c.clv_avg))}</b>
      <span>ROI (stake del modelo)</span><b>${escapeHtml(fmtPctFrac(c.roi))}${c.roi_ci_low != null ? ` <small>[${escapeHtml(fmtPctFrac(c.roi_ci_low))}, ${escapeHtml(fmtPctFrac(c.roi_ci_high))}]</small>` : ''}</b>
      <span>n</span><b>${escapeHtml(String(c.n ?? 0))}</b>
    </div>`;
}

const MARKET_LABEL = { OVER_UNDER: 'Más/Menos 2,5', BTTS: 'Ambos marcan', '1X2': '1X2' };
const VERDICT_ICON = { good: '🟢', bad: '🔴', pending: '🟡', neutral: '⚪' };

function marketVerdictCard(c, { open = false } = {}) {
  const v = window.MA_STATS.marketVerdict(c);
  const metric = v.improvement != null
    ? `<div class="verdict-card__metric"><span>Mejora de log-loss ${metricHelp('logloss')}</span><b>${escapeHtml(fmt4(v.improvement))}</b></div>`
    : v.diff != null ? `<div class="verdict-card__metric"><span>Diferencia de log-loss ${metricHelp('logloss')}</span><b>${escapeHtml(`${v.diff > 0 ? '+' : ''}${fmt4(v.diff)}`)}</b></div>` : '';
  return `
    <article class="card verdict-card verdict-card--${v.tone}">
      <header class="verdict-card__head">
        <strong>${escapeHtml(c.competition_name || c.competition || '')}</strong>
        <span class="chip chip--muted">${escapeHtml(MARKET_LABEL[c.market] || c.market || '')}</span>
      </header>
      <div class="verdict-card__title">${deco(VERDICT_ICON[v.tone] || '⚪')} ${escapeHtml(v.title)}</div>
      ${metric}
      ${sampleBadge(v.maturity)}
      <details class="verdict-card__details"${open ? ' open' : ''}><summary>Ver detalles</summary>${marketTechGrid(c)}</details>
    </article>`;
}

function marketVerdictList(cards, options) {
  if (!cards.length) return infoEmptyState('📊', 'Sin métricas por mercado', 'Aparecerán cuando haya partidos con resultado y cuotas para comparar.');
  return `<div class="market-card-grid">${cards.map((c) => marketVerdictCard(c, options)).join('')}</div>`;
}

function aiCaseRow(r) {
  const adj = r.adjustment_pp || null;
  const d = Number(r.brier_delta);
  const tag = d < 0 ? ['chip--ok', 'AYUDÓ'] : d > 0 ? ['chip--danger', 'EMPEORÓ'] : ['chip--muted', 'NEUTRAL'];
  const adjText = adj ? `L ${Number(adj.HOME || 0).toFixed(1)} · E ${Number(adj.DRAW || 0).toFixed(1)} · V ${Number(adj.AWAY || 0).toFixed(1)} pp` : '';
  return `<li class="ai-case">
      <span class="ai-case__match">${escapeHtml(r.home_team || '?')} <b>${escapeHtml(r.score || '')}</b> ${escapeHtml(r.away_team || '?')}</span>
      <span class="chip ${tag[0]}">${tag[1]}</span>
      <small>${escapeHtml([adjText, Number.isFinite(d) ? `ΔBrier ${d > 0 ? '+' : ''}${d.toFixed(4)}` : ''].filter(Boolean).join(' · '))}</small>
    </li>`;
}

function aiImpactCard(policy, track) {
  const imp = window.MA_STATS.aiImpact(policy, track);
  const items = (track && Array.isArray(track.items) && track.items.length ? track.items : (track && track.largest_recent)) || [];
  const reason = typeof policy.reason === 'string' ? policy.reason : '';
  const diffText = imp.diff == null ? '—' : `${imp.diff > 0 ? '+' : ''}${imp.diff.toFixed(4)}`;
  return `
    <article class="card verdict-card ai-impact verdict-card--${imp.verdict.tone}">
      <header class="verdict-card__head">
        <strong>${escapeHtml(policy.competition_name || policy.competition || '')}</strong>
        <span class="chip ${imp.mode.applied ? 'chip--ok' : 'chip--warn'}">${escapeHtml(imp.mode.label)}</span>
      </header>
      <p class="ai-impact__mode">${escapeHtml(imp.mode.text)}</p>
      ${imp.counts.total ? `<div class="ai-impact__counts">
        <span>${deco('🟢')} Ayudó <b>${imp.counts.helped}</b></span>
        <span>${deco('🔴')} Empeoró <b>${imp.counts.worsened}</b></span>
        <span>${deco('⚪')} Neutral <b>${imp.counts.neutral}</b></span>
      </div>` : ''}
      <div class="verdict-card__title">${deco(VERDICT_ICON[imp.verdict.tone] || '⚪')} ${escapeHtml(imp.verdict.title)}</div>
      <div class="market-card__grid ai-impact__brier">
        <span>Brier modelo ${metricHelp('brier')}</span><b>${escapeHtml(fmt4(imp.brierModel))}</b>
        <span>Brier IA</span><b>${escapeHtml(fmt4(imp.brierAi))}</b>
        <span>Brier calibrado</span><b>${escapeHtml(fmt4(imp.brierCalibrated))}</b>
        <span>Diferencia (IA − modelo)</span><b>${escapeHtml(diffText)}</b>
      </div>
      ${sampleBadge(imp.maturity)}
      <details class="verdict-card__details">
        <summary>Ver casos analizados${imp.casesPartial ? ` (últimos ${imp.casesShown} de ${imp.n})` : ''}</summary>
        ${items.length ? `<ul class="ai-case-list">${items.map(aiCaseRow).join('')}</ul>` : '<p class="perf-summary__note">Sin ajustes de IA liquidados aún.</p>'}
        <div class="market-card__grid">
          <span>alpha (peso IA)</span><b>${escapeHtml(Number(policy.alpha || 0).toFixed(2))}</b>
          <span>Partidos evaluados (IA)</span><b>${escapeHtml(String(policy.n_settled ?? 0))}</b>
          <span>Estado</span><b>${escapeHtml(window.MA_STATS.reasonLabel(reason) || '—')}</b>
          ${policy.p_value != null ? `<span>p-valor (test de signo)</span><b>${escapeHtml(Number(policy.p_value).toFixed(3))}</b>` : ''}
          ${reason ? `<span>Código</span><b><code>${escapeHtml(reason)}</code></b>` : ''}
        </div>
      </details>
    </article>`;
}

function aiImpactList(policies, track) {
  if (!policies.length) return infoEmptyState('🤖', 'IA sin evaluar aún', 'La evaluación de la IA aparece cuando haya partidos con resultado.');
  const trackBy = new Map(track.map((t) => [t.competition, t]));
  return `<div class="market-card-grid">${policies.map((p) => aiImpactCard(p, trackBy.get(p.competition) || {})).join('')}</div>`;
}

function picksStatusSection(decisions, totals, limit) {
  const s = window.MA_STATS.pickStatusSummary(decisions, totals, limit);
  if (!s.total) return infoEmptyState('🍩', 'Sin decisiones', 'No hay decisiones registradas aún.');
  const scope = s.source === 'all' ? `${s.total} decisiones en total` : `Últimas ${s.total} decisiones`;
  return `
    <p class="perf-summary__note">${escapeHtml(scope)} ${metricHelp('decisions')}</p>
    <div class="pick-status-groups">
      <div>
        <h4 class="pick-status-groups__title">Decisión del sistema</h4>
        <ul class="pick-status-list">
          ${s.decisionRows.map((r) => `<li><span>${deco(r.icon)} ${escapeHtml(r.label)}</span><b>${r.count}</b></li>`).join('')}
        </ul>
      </div>
      <div>
        <h4 class="pick-status-groups__title">Resultado del partido</h4>
        <ul class="pick-status-list">
          <li><span>${deco('⏳')} Pendientes</span><b>${s.resolution.pending}</b></li>
          <li><span>${deco('✅')} Liquidadas</span><b>${s.resolution.settled}</b></li>
          ${s.resolution.other ? `<li><span>${deco('↩️')} Anuladas</span><b>${s.resolution.other}</b></li>` : ''}
        </ul>
      </div>
    </div>
    ${s.useDonut ? picksByStatusChart(s) : ''}`;
}

function statsTabsHtml(active) {
  const tabs = [['performance', 'Rendimiento'], ['model', 'Modelo'], ['ai', 'IA']];
  return `<div class="segment stats-tabs" role="tablist" aria-label="Secciones de estadísticas">
    ${tabs.map(([key, label]) => `<button type="button" role="tab" id="stats-tab-${key}" data-stats-tab="${key}" aria-controls="stats-panel" aria-selected="${active === key}" class="${active === key ? 'active' : ''}">${escapeHtml(label)}</button>`).join('')}
  </div>`;
}

function statsPerformancePanel(d) {
  const summary = window.MA_STATS.performanceSummary(d);
  const roiReady = window.MA_STATS.roiByEvReadiness(d.buckets);
  return `
    ${performanceSummaryCard(summary)}
    <section class="stats-section">
      <h3>Match Alpha vs mercado</h3>
      ${marketVerdictList(d.marketCards)}
    </section>
    <section class="stats-section">
      <h3>Estado de las decisiones</h3>
      ${picksStatusSection(d.decisions, d.totals, d.decisionsLimit)}
    </section>
    <section class="stats-section">
      <h3>ROI por rango de EV</h3>
      ${roiReady.show ? roiByEvChart(d.buckets) : sampleEmptyState('⏳', roiReady.maturity, {
        noData: ['Aún no hay resultados', 'El rendimiento por rango de EV aparecerá cuando haya picks con stake liquidados.'],
        insufficient: ['Aún no hay suficientes resultados', 'Necesitamos más picks con stake liquidados para comparar el rendimiento por rango de EV.'],
      })}
    </section>`;
}

function statsModelPanel(d) {
  const latest = d.calibration[0] || {};
  const calReady = window.MA_STATS.chartReadiness(latest.sample_size, window.MA_STATS.MIN_CALIBRATION_SAMPLE, 'predicciones');
  const hasBuckets = d.calibration.some((r) => Array.isArray(r.buckets) && r.buckets.length);
  let calibrationHtml;
  if (!calReady.show) {
    calibrationHtml = sampleEmptyState('⏳', calReady.maturity, {
      noData: ['Aún no hay calibración', 'La calibración aparece cuando haya predicciones con resultado.'],
      insufficient: ['Recopilando resultados', 'La calibración por tramos necesita más predicciones con resultado para ser interpretable.'],
    });
  }
  else if (!hasBuckets) calibrationHtml = infoEmptyState('📊', 'Calibración por tramos no disponible', 'El servidor todavía no entrega la tasa observada por tramo; se muestran Brier, log-loss y ECE arriba.');
  else calibrationHtml = calibrationBucketChart(d.calibration);
  return `
    <section class="stats-section">
      <h3>Métricas del modelo</h3>
      <div class="model-help">
        <span><b>Brier</b> ${metricHelp('brier')}</span><span><b>Log loss</b> ${metricHelp('logloss')}</span>
        <span><b>ECE</b> ${metricHelp('ece')}</span><span><b>CLV</b> ${metricHelp('clv')}</span>
      </div>
      ${statsKpiBar(d.calibration, d.buckets)}
    </section>
    <section class="stats-section">
      <h3>Evolución diaria (30 días)</h3>
      ${metricsHistoryChart(d.history)}
    </section>
    <section class="stats-section">
      <h3>Calibración</h3>
      ${calibrationHtml}
    </section>
    <section class="stats-section">
      <h3>Modelo vs mercado (detalle)</h3>
      ${marketVerdictList(d.marketCards, { open: true })}
    </section>`;
}

function statsAiPanel(d) {
  return `
    <section class="stats-section">
      <h3>Impacto de la IA por liga</h3>
      <p class="perf-summary__note">En <b>modo sombra</b> la IA se evalúa sin modificar las predicciones; solo se activa si demuestra
        menor error con un test estadístico (p ≤ ${window.MA_STATS.AI_MAX_P_VALUE.toFixed(2)}) y ${window.MA_STATS.MIN_AI_ACTIVATION_SAMPLE}+ partidos.</p>
      ${aiImpactList(d.aiPolicies, d.aiTrack)}
    </section>`;
}

function renderStatsPanel() {
  const d = state.statsData;
  const panel = document.getElementById('stats-panel');
  if (!d || !panel) return;
  const tab = window.MA_STATS.normalizeStatsTab(state.statsTab);
  panel.setAttribute('aria-labelledby', `stats-tab-${tab}`);
  panel.innerHTML = tab === 'model' ? statsModelPanel(d) : tab === 'ai' ? statsAiPanel(d) : statsPerformancePanel(d);
  document.querySelectorAll('[data-stats-tab]').forEach((b) => {
    const on = b.dataset.statsTab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  loadChartJs().catch(() => null).then(() => {
    if (state.view !== 'stats' || typeof Chart === 'undefined') return;
    initMetricsHistoryChart(d.history);
    initCalibrationChart(d.calibration);
    initRoiChart(d.buckets);
    initPicksDonut(window.MA_STATS.pickStatusSummary(d.decisions, d.totals, d.decisionsLimit));
  });
}

document.addEventListener('click', (event) => {
  const btn = event.target.closest?.('[data-stats-tab]');
  if (!btn) return;
  state.statsTab = window.MA_STATS.normalizeStatsTab(btn.dataset.statsTab);
  renderStatsPanel();
});

async function renderStats(options = {}) {
  if (!options.silent) {
    root.innerHTML = `<div class="stats-view"><div class="loading-head"><span>Cargando estadísticas</span><i></i></div></div>`;
  }
  let calibration = [], buckets = [], decisions = [], totals = [], decisionsLimit = null, history = [], aiPolicies = [], aiTrack = [], marketCards = [], clv = null;
  try {
    const [calData, roiData, bankData] = await Promise.all([
      cached('calibration/summary', { limit: 5 }, 120000, options),
      cached('stats/roi-by-ev', {}, 120000, options),
      cached('stats/bankroll', { limit: 200 }, 120000, options),
    ]);
    calibration = calData.calibration || [];
    buckets = roiData.buckets || [];
    decisions = bankData.decisions || [];
    totals = Array.isArray(bankData.totals) ? bankData.totals : []; // every decision (older API: absent)
    decisionsLimit = bankData.limit ?? 200;
  } catch (error) {
    if (error.name === 'AbortError') return;
    root.innerHTML = `<div class="stats-view"><div class="error">${escapeHtml(error.message)}</div></div>`;
    return;
  }
  // Optional sources: an older backend without one of these endpoints must not break the view.
  try {
    const histData = await cached('model/metrics/history', { days: 30 }, 300000, options);
    history = Array.isArray(histData?.series) ? histData.series : [];
    aiPolicies = Array.isArray(histData?.ai_policy) ? histData.ai_policy : [];
    marketCards = Array.isArray(histData?.market_cards) ? histData.market_cards : [];
  } catch (error) {
    if (error.name === 'AbortError') return;
  }
  try {
    // limit 200 (API max): enough to count helped / worsened / neutral cases per league
    const trackData = await cached('model/ai-track-record', { days: 90, limit: 200 }, 300000, options);
    aiTrack = Array.isArray(trackData?.competitions) ? trackData.competitions : [];
  } catch (error) {
    if (error.name === 'AbortError') return;
  }
  try {
    clv = await cached('stats/clv', { days: 30 }, 300000, options);
  } catch (error) {
    if (error.name === 'AbortError') return;
  }

  setStatus('Estadísticas', `${window.MA_STATS.pickStatusSummary(decisions, totals, decisionsLimit).total} decisiones`);
  const hasData = decisions.length > 0 || calibration.length > 0 || history.length > 0 || aiPolicies.length > 0 || marketCards.length > 0;
  if (!hasData) {
    root.innerHTML = `<div class="stats-view">${statsRoadmapEmpty()}</div>`;
    return;
  }
  state.statsData = { calibration, buckets, decisions, totals, decisionsLimit, history, aiPolicies, aiTrack, marketCards, clv };
  state.statsTab = window.MA_STATS.normalizeStatsTab(state.statsTab);
  root.innerHTML = `
    <div class="stats-view">
      ${statsTabsHtml(state.statsTab)}
      <div id="stats-panel" role="tabpanel"></div>
    </div>`;
  renderStatsPanel();
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
  if (isAdminView(state.view)) {
    await window.MA_ADMIN.render(state.view, options);
    return;
  }
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
    // Fase H: views from js/picks.js / js/push.js (window.MA_VIEWS)
    else if (window.MA_VIEWS && Object.prototype.hasOwnProperty.call(window.MA_VIEWS, state.view)) { hideDateFilterBar(); await window.MA_VIEWS[state.view](renderOptions); }
    else await renderToday(renderOptions);
  } catch (error) {
    if (error.name === 'AbortError' || seq !== state.renderSeq) return;
    if (String(error.message) !== 'Unauthorized') errorState(error);
  }
}

function switchView(view) {
  closeMoreSheet();
  if (!view || state.view === view) return;
  state.view = view;
  const topTab = document.querySelector(`.tab[data-view="${CSS.escape(view)}"]`);
  root.setAttribute('aria-labelledby', topTab?.id || '');
  updateTabs();
  window.scrollTo({ top: 0 });
  render();
}

document.querySelectorAll('.tab, .bottom-tab[data-view], .more-item[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.hidden) return;
    switchView(button.dataset.view);
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

// Interface language (es / en / pt): js/i18n.js picks it from the time zone; the user can override it here.
const langSelect = document.getElementById('lang-select');
if (langSelect && window.MA_I18N) {
  langSelect.value = window.MA_I18N.lang;
  langSelect.addEventListener('change', () => window.MA_I18N.setLang(langSelect.value));
}

$('#refresh-btn').addEventListener('click', () => {
  state.cache.clear();
  state.layout = null;
  render();
});

function refreshSilently() {
  if (document.hidden) return;
  if (isAdminView(state.view)) return;
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
  DOMESTIC_CUP: 'Copas nacionales',
  INTERNATIONAL_CUP: 'Selecciones',
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
  const fav = favoriteLeagues().includes(slug);
  const search = `${catalogName(comp)} ${meta} ${slug}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return `
    <div class="league-picker-row" data-search="${escapeHtml(search)}">
      <button class="league-picker-item${isActive ? ' league-picker-item--active' : ''}"
              data-season="${escapeHtml(slug)}" type="button"
              role="option" aria-selected="${isActive ? 'true' : 'false'}">
        <span class="league-picker-item-icon" aria-hidden="true">${escapeHtml(icon || '🏆')}</span>
        <span class="league-picker-item-info">
          <span class="league-picker-item-name">${escapeHtml(catalogName(comp))}</span>
          <span class="league-picker-item-meta">${escapeHtml(meta)}</span>
        </span>
      </button>
      <button class="league-fav-btn${fav ? ' is-fav' : ''}" type="button" data-fav="${escapeHtml(slug)}"
              aria-pressed="${fav ? 'true' : 'false'}" aria-label="${escapeHtml(`${fav ? 'Quitar de' : 'Agregar a'} favoritos: ${catalogName(comp)}`)}">${fav ? '★' : '☆'}</button>
    </div>`;
}

function leaguePickerGroup(label, icon, items) {
  if (!items.length) return '';
  return `
    <div class="league-picker-group" role="group" aria-label="${escapeHtml(label)}">
      <div class="league-picker-group-label">${icon ? `${deco(icon)} ` : ''}${escapeHtml(label)}</div>
      ${items.join('')}
    </div>`;
}

// Favorites: only competition slugs are stored (no PII).
const FAVORITES_STORAGE = 'match_alpha_fav_leagues';

function favoriteLeagues() {
  try {
    const list = JSON.parse(localStorage.getItem(FAVORITES_STORAGE) || '[]');
    return Array.isArray(list) ? list.filter((v) => typeof v === 'string' && /^[a-z0-9-]{1,80}$/.test(v)) : [];
  } catch {
    return [];
  }
}

function toggleFavoriteLeague(slug) {
  const list = favoriteLeagues();
  const next = list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug].slice(-20);
  localStorage.setItem(FAVORITES_STORAGE, JSON.stringify(next));
}

function leaguePickerFavorites(catalog) {
  const favs = favoriteLeagues();
  const items = catalog.entries.filter((c) => favs.includes(catalogSlug(c)));
  return leaguePickerGroup('Favoritas', '★', items.map((comp) => leaguePickerItem(comp, comp.ui?.icon || COMPETITION_ICONS[catalogSlug(comp)] || '🏆')));
}

function buildLeaguePickerDropdown(catalog) {
  return leaguePickerFavorites(catalog) + buildLeaguePickerGroups(catalog);
}

function buildLeaguePickerGroups(catalog) {
  if (catalog.source === 'api') {
    // Group by domain_type (Phase G: ligas / copas nacionales / copas internacionales / selecciones),
    // falling back to competition_type, then order by region/name. Icons come from the catalog.
    const groups = new Map();
    for (const comp of catalog.entries) {
      const label = catalogTypeLabel(comp.domain_type || comp.competition_type);
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

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop league-sheet-backdrop';
  backdrop.hidden = true;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', () => closePicker());
  const isSheet = () => window.matchMedia('(max-width: 680px)').matches;

  function wirePicker(catalog) {
    dropdown.innerHTML = `
      <div class="league-picker-head">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <label class="sr-only" for="league-search">Buscar competición</label>
        <input id="league-search" class="league-search" type="search" placeholder="Buscar liga o copa…" autocomplete="off" enterkeyhint="search">
      </div>
      <div class="league-picker-list">${buildLeaguePickerDropdown(catalog)}</div>`;
    const search = dropdown.querySelector('.league-search');
    const applyFilter = () => {
      const q = search.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      dropdown.querySelectorAll('.league-picker-row').forEach((row) => { row.hidden = Boolean(q) && !row.dataset.search.includes(q); });
      dropdown.querySelectorAll('.league-picker-group').forEach((group) => {
        group.hidden = ![...group.querySelectorAll('.league-picker-row')].some((row) => !row.hidden);
      });
    };
    search.addEventListener('input', applyFilter);
    dropdown.querySelector('.league-picker-list').addEventListener('click', (event) => {
      const favBtn = event.target.closest('[data-fav]');
      if (favBtn) {
        event.stopPropagation();
        toggleFavoriteLeague(favBtn.dataset.fav);
        const query = search.value;
        wirePicker(catalog);
        const again = dropdown.querySelector('.league-search');
        again.value = query;
        again.dispatchEvent(new Event('input'));
        dropdown.querySelector(`[data-fav="${CSS.escape(favBtn.dataset.fav)}"]`)?.focus();
        return;
      }
      const item = event.target.closest('[data-season]');
      if (item) switchSeason(item.dataset.season);
    });
    if (!isSheet()) search.focus({ preventScroll: true });
  }

  function positionPicker() {
    if (isSheet()) {
      dropdown.style.top = '';
      dropdown.style.left = '';
      return;
    }
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = `${Math.round(rect.bottom + 8)}px`;
    dropdown.style.left = `${Math.round(rect.left)}px`;
  }

  function openPicker() {
    isOpen = true;
    btn.setAttribute('aria-expanded', 'true');
    positionPicker();
    dropdown.removeAttribute('hidden');
    backdrop.hidden = !isSheet();
    dropdown.innerHTML = '<div class="league-picker-group"><div class="league-picker-group-label">Cargando…</div></div>';
    loadCompetitionCatalog().then((catalog) => { if (isOpen) wirePicker(catalog); });
  }

  function closePicker() {
    isOpen = false;
    btn.setAttribute('aria-expanded', 'false');
    dropdown.setAttribute('hidden', '');
    backdrop.hidden = true;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen ? closePicker() : openPicker();
  });

  window.addEventListener('resize', () => {
    if (isOpen) positionPicker();
  });

  document.addEventListener('click', (e) => {
    if (isOpen && !dropdown.contains(e.target) && !btn.contains(e.target)) closePicker();
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

// Sticky sub-bars (knockout tabs, toolbar) sit right below the header; its height varies on mobile.
(function syncTopbarHeight() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const apply = () => document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
  apply();
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(topbar);
  else window.addEventListener('resize', apply);
})();

// ─── Standings: expandable rows with last-5 form (F-A.2) ─────────────────────

async function teamLastFive(teamId) {
  if (!teamId) return [];
  const data = await cached('web/matches', {}, 120000);
  return (data.matches || [])
    .filter((m) => isFinishedStatus(m.status) && [m.home?.team_id, m.away?.team_id].map(String).includes(String(teamId)))
    .sort((a, b) => (a.kickoff_at < b.kickoff_at ? 1 : -1))
    .slice(0, 5)
    .map((m) => ({ match: m, result: teamSideResult(m, teamId) }));
}

async function fillFormSlot(slot, teamId) {
  if (!slot || slot.dataset.loaded) return;
  slot.dataset.loaded = '1';
  try {
    const items = await teamLastFive(teamId);
    const chips = items.map(({ match, result }) => {
      const rival = String(match.home?.team_id) === String(teamId) ? match.away : match.home;
      const label = `${RESULT_TITLES[result] || 'Sin resultado'} vs ${rival?.display_name || 'rival'} ${num(match.home_score)}-${num(match.away_score)}`;
      return `<span class="form-chip-wrap" title="${escapeHtml(label)}">${resultChip(result)}<span class="sr-only">${escapeHtml(label)}</span></span>`;
    }).join('');
    slot.innerHTML = `<span class="form-label">Últimos 5</span>${chips || '<span class="form-empty">Sin partidos finalizados</span>'}`;
  } catch {
    slot.dataset.loaded = '';
    slot.innerHTML = '<span class="form-label">Últimos 5</span><span class="form-empty">No disponible</span>';
  }
}

function toggleStandingsRow(tr) {
  const key = tr.dataset.standingsToggle;
  const detail = tr.parentElement?.querySelector(`[data-standings-detail="${CSS.escape(key)}"]`);
  if (!detail) return;
  const open = detail.hidden;
  detail.hidden = !open;
  tr.setAttribute('aria-expanded', open ? 'true' : 'false');
  tr.classList.toggle('is-expanded', open);
  if (open) fillFormSlot(detail.querySelector('[data-form-slot]'), tr.dataset.teamId);
}

// One delegated listener for the whole view root (no per-render rebinding).
root.addEventListener('click', (event) => {
  const standingsRow = event.target.closest('[data-standings-toggle]');
  if (standingsRow) { toggleStandingsRow(standingsRow); return; }
  const card = event.target.closest('[data-match-id]');
  if (card) openMatchDetail(card.dataset.matchId);
});
root.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[data-standings-toggle], [data-match-id]');
  if (!target || target !== event.target) return;
  event.preventDefault();
  target.click();
});

// ─── Match detail sheet (F-A.4) ──────────────────────────────────────────────

// Attributes that make a card/row open the match detail sheet (delegated on #view-root).
function matchDetailAttrs(match) {
  if (!match?.match_id) return '';
  const label = `Ver detalle: ${match.home?.display_name || 'Por definir'} vs ${match.away?.display_name || 'Por definir'}`;
  return ` data-match-id="${escapeHtml(match.match_id)}" tabindex="0" role="button" aria-label="${escapeHtml(label)}"`;
}

const MATCH_STAT_LABELS = [
  ['ball_possession', 'Posesión', '%'],
  ['expected_goals', 'xG', ''],
  ['total_shots', 'Tiros', ''],
  ['shots_on_goal', 'Tiros al arco', ''],
  ['shots_insidebox', 'Tiros dentro del área', ''],
  ['blocked_shots', 'Tiros bloqueados', ''],
  ['corner_kicks', 'Córners', ''],
  ['total_passes', 'Pases', ''],
  ['passes_accurate', 'Pases precisos', ''],
  ['goalkeeper_saves', 'Atajadas', ''],
  ['fouls', 'Faltas', ''],
  ['offsides', 'Fueras de juego', ''],
  ['yellow_cards', 'Amarillas', ''],
  ['red_cards', 'Rojas', ''],
];

const OFFICIAL_ROLE_LABELS = { REFEREE: 'Árbitro', MAIN_REFEREE: 'Árbitro', ASSISTANT: 'Asistente', ASSISTANT_REFEREE: 'Asistente', FOURTH_OFFICIAL: 'Cuarto árbitro', VAR: 'VAR' };

function matchStatsCompareHtml(stats) {
  const byKey = Object.fromEntries((stats || []).map((s) => [s.key, s]));
  const rows = MATCH_STAT_LABELS.filter(([key]) => byKey[key]).map(([key, label, suffix]) => {
    const h = num(byKey[key].home);
    const a = num(byKey[key].away);
    const total = h + a;
    const hp = total > 0 ? Math.round((h / total) * 100) : 50;
    const fmt = (v) => (key === 'expected_goals' ? v.toFixed(2) : String(Math.round(v))) + suffix;
    return `
      <div class="stat-compare">
        <div class="stat-compare-head"><b>${escapeHtml(fmt(h))}</b><span>${escapeHtml(label)}</span><b>${escapeHtml(fmt(a))}</b></div>
        <div class="stat-compare-bar" aria-hidden="true">
          <i class="home${h >= a ? ' lead' : ''}" style="width:${hp}%"></i><i class="away${a > h ? ' lead' : ''}" style="width:${100 - hp}%"></i>
        </div>
      </div>`;
  }).join('');
  return rows || emptyState('Estadísticas del partido no disponibles.');
}

function lineupPitchHtml(side, team) {
  const starters = side?.starters || [];
  const bench = side?.bench || [];
  if (!starters.length && !bench.length) return '';
  const playerChip = (p) => `
    <span class="lineup-player">
      <b>${p.shirt_number != null ? num(p.shirt_number) : ''}</b>
      <span>${escapeHtml(p.display_name || '')}${p.is_captain ? ' (C)' : ''}</span>
    </span>`;
  let main;
  const gridOk = side.formation && starters.every((p) => /^\d+:\d+$/.test(p.grid || ''));
  if (gridOk) {
    const rows = {};
    starters.forEach((p) => { const [r, c] = p.grid.split(':').map(Number); (rows[r] ||= []).push({ ...p, col: c }); });
    main = `<div class="pitch">${Object.keys(rows).map(Number).sort((a, b) => a - b).map((r) => `
      <div class="pitch-row">${rows[r].sort((x, y) => x.col - y.col).map(playerChip).join('')}</div>`).join('')}</div>`;
  } else {
    main = `<div class="lineup-list">${starters.map(playerChip).join('')}</div>`;
  }
  return `
    <div class="lineup-team">
      <h4>${teamMark(team)} ${escapeHtml(team?.display_name || '')}${side.formation ? ` <small>${escapeHtml(side.formation)}</small>` : ''}</h4>
      ${main}
      ${bench.length ? `<details class="lineup-bench"><summary>Suplentes (${bench.length})</summary><div class="lineup-list">${bench.map(playerChip).join('')}</div></details>` : ''}
    </div>`;
}

function eventIcon(type, detail) {
  const t = String(type || '').toLowerCase();
  const d = String(detail || '').toLowerCase();
  if (t === 'goal') return d.includes('own') ? '⚽ (ag)' : d.includes('penalty') ? '⚽ (p)' : '⚽';
  if (t === 'card') return d.includes('red') ? '🟥' : '🟨';
  if (t === 'subst') return '🔁';
  if (t === 'var') return '📺';
  return '•';
}

const EVENT_DETAIL_LABELS = {
  'yellow card': 'Amarilla', 'red card': 'Roja', 'second yellow card': 'Segunda amarilla',
  'normal goal': 'Gol', penalty: 'Gol de penal', 'own goal': 'Autogol', 'missed penalty': 'Penal fallado',
  'goal cancelled': 'Gol anulado (VAR)', 'goal disallowed - offside': 'Gol anulado por fuera de juego', 'penalty confirmed': 'Penal confirmado (VAR)',
};

function eventDetailLabel(type, detail) {
  const d = String(detail || '').toLowerCase();
  if (String(type || '').toLowerCase() === 'subst' || d.startsWith('substitution')) return 'Cambio';
  return EVENT_DETAIL_LABELS[d] || detail || type || '';
}

function eventsTimelineHtml(events) {
  if (!events?.length) return emptyState('Sin eventos registrados.');
  return `<ol class="event-timeline">${events.map((e) => {
    const minute = e.minute != null ? `${num(e.minute)}${e.stoppage_minute ? `+${num(e.stoppage_minute)}` : ''}'` : '';
    const isSub = String(e.type || '').toLowerCase() === 'subst';
    const who = isSub
      ? `${escapeHtml(e.related_player_name || '')}${e.related_player_name ? ' ↔ ' : ''}${escapeHtml(e.player_name || '')}`
      : escapeHtml(e.player_name || e.detail || '');
    return `
      <li class="event-item event-item--${e.side === 'away' ? 'away' : 'home'}">
        <span class="event-min">${escapeHtml(minute)}</span>
        <span class="event-icon" aria-hidden="true">${escapeHtml(eventIcon(e.type, e.detail))}</span>
        <span class="event-text">${who}<small>${escapeHtml(eventDetailLabel(e.type, e.detail))}</small></span>
      </li>`;
  }).join('')}</ol>`;
}

// "12-abr 2025": head-to-head spans several seasons, so the year is always shown.
function h2hDateLabel(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${dateLabel(value)} ${d.toLocaleDateString(UI_LOCALE, { year: 'numeric', timeZone: USER_TIMEZONE })}`;
}

function h2hHtml(rows, match) {
  if (!rows?.length) return emptyState('Sin enfrentamientos previos registrados.');
  return `<div class="h2h-list">${rows.map((h) => `
    <div class="h2h-row">
      <span class="h2h-date">${escapeHtml(h2hDateLabel(h.kickoff_at))}</span>
      <span class="h2h-teams">${escapeHtml(h.home_name || '')} <b>${num(h.home_score)}-${num(h.away_score)}</b> ${escapeHtml(h.away_name || '')}
        <small class="h2h-comp">${escapeHtml([h.competition_name, h.season_label].filter(Boolean).join(' · '))}</small></span>
      ${resultChip(h.result_for_home)}
    </div>`).join('')}</div>
    <p class="hint">Resultado desde el punto de vista de ${escapeHtml(match.home?.display_name || 'el local')}.</p>`;
}

function probabilityCompareHtml(detail) {
  const preds = (detail.predictions || []).filter((p) => String(p.market_code).toUpperCase() === '1X2');
  const noVig = detail.odds?.no_vig_1x2 || {};
  const best = detail.odds?.best_1x2 || {};
  if (!preds.length && !Object.keys(noVig).length) return emptyState('Sin predicción del modelo ni cuotas para este partido.');
  const bySel = Object.fromEntries(preds.map((p) => [String(p.selection_code).toUpperCase(), p]));
  const m = detail.match || {};
  const labels = { HOME: m.home?.display_name || 'Local', DRAW: 'Empate', AWAY: m.away?.display_name || 'Visita' };
  const SEL = ['HOME', 'DRAW', 'AWAY'];
  // Each source is one complete outcome set: normalised and rounded together so it always shows 100 %
  // (largest remainder), and the model never mixes calibrated and raw values across selections.
  const model = window.MA_PROB.modelOutcomeSet(bySel, SEL);
  const aiVals = Object.fromEntries(SEL.map((s) => [s, (bySel[s] || {}).ai_adjusted_probability]));
  const shown = {
    model: window.MA_PROB.outcomeSetPercents(model.values, SEL),
    ai: window.MA_PROB.outcomeSetPercents(aiVals, SEL),
    market: window.MA_PROB.outcomeSetPercents(noVig, SEL),
  };
  const bar = (label, pct, cls) => (pct == null ? '' : `
    <div class="prob-bar-row">
      <span class="prob-bar-label">${escapeHtml(label)}</span>
      <div class="prob-bar-track"><div class="prob-bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="prob-bar-value">${pct}%</span>
    </div>`);
  const blocks = SEL.map((sel) => `
      <div class="prob-block">
        <div class="prob-block-title"><strong>${escapeHtml(labels[sel])}</strong>${best[sel] ? `<span>Mejor cuota ${num(best[sel]).toFixed(2)}</span>` : ''}</div>
        <div class="prob-bars">
          ${bar('Modelo', shown.model[sel], 'prob-bar-fill--model')}
          ${bar('IA', shown.ai[sel], 'prob-bar-fill--ai')}
          ${bar('Mercado', shown.market[sel], 'prob-bar-fill--market')}
        </div>
      </div>`).join('');
  const ai = detail.ai_factors;
  const factors = ai ? [
    ...(ai.factors || []).map((f) => f.description).filter(Boolean),
    ...(!(ai.factors || []).length ? ai.key_factors || [] : []),
  ].slice(0, 6) : [];
  return `
    ${blocks}
    <p class="hint">Mercado = probabilidad sin margen (no-vig) a partir de la mejor cuota disponible.</p>
    ${factors.length ? `
      <div class="ai-factors-box">
        <h4>Factores de la IA${ai.confidence ? ` <small>confianza ${escapeHtml(({ low: 'baja', medium: 'media', high: 'alta' })[String(ai.confidence).toLowerCase()] || ai.confidence)}</small>` : ''}${ai.mode ? ` <small>${escapeHtml(String(ai.mode).toUpperCase() === 'SHADOW' ? 'modo sombra' : ai.mode)}</small>` : ''}</h4>
        <ul>${factors.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
      </div>` : ''}`;
}

function matchInfoHtml(detail) {
  const m = detail.match || {};
  const v = m.venue || {};
  const rows = [];
  if (v.display_name || v.city) rows.push(['Estadio', [v.display_name, v.city].filter(Boolean).join(', ')]);
  if (v.capacity) rows.push(['Capacidad', num(v.capacity).toLocaleString(UI_LOCALE)]);
  if (v.surface) rows.push(['Superficie', v.surface]);
  rows.push(['Inicio', userDateTimeLabel(m.kickoff_at)]);
  const local = localVenueTimeLabel(m);
  if (local) rows.push(['Hora local', local]);
  (detail.officials || []).forEach((o) => rows.push([OFFICIAL_ROLE_LABELS[String(o.role || '').toUpperCase()] || 'Árbitro', o.display_name || '-']));
  if (!(detail.officials || []).length) rows.push(['Árbitro', 'No informado']);
  return `
    <dl class="match-info">${rows.map(([k, val]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd></div>`).join('')}</dl>
    ${weatherHtml(m) || '<p class="hint">Clima no disponible para este partido.</p>'}`;
}

function matchDetailHtml(detail) {
  const m = detail.match || {};
  const home = m.home || { display_name: 'Por definir' };
  const away = m.away || { display_name: 'Por definir' };
  const meta = [matchStageLabel(m), matchGroupLabel(m)].filter(Boolean).join(' · ');
  const lineups = detail.lineups || {};
  const hasLineups = ['home', 'away'].some((s) => (lineups[s]?.starters || []).length);
  const tabs = [
    ['summary', 'Resumen', probabilityCompareHtml(detail) + `<h3 class="md-subtitle">Info</h3>` + matchInfoHtml(detail)],
    ['lineups', 'Alineaciones', hasLineups ? `<div class="lineups">${lineupPitchHtml(lineups.home, home)}${lineupPitchHtml(lineups.away, away)}</div>` : emptyState('Alineaciones aún no publicadas.')],
    ['events', 'Eventos', eventsTimelineHtml(detail.events)],
    ['stats', 'Stats', matchStatsCompareHtml(detail.team_stats)],
    ['h2h', 'Cara a cara', h2hHtml(detail.head_to_head, m)],
  ];
  return `
    <div class="modal-card match-detail" role="dialog" aria-modal="true" aria-labelledby="md-title">
      <button class="modal-close" data-close-modal aria-label="Cerrar">×</button>
      <header class="md-header">
        <span class="stage-chip">${escapeHtml(meta || 'Partido')}</span>
        <h2 id="md-title" class="sr-only">${escapeHtml(`${home.display_name} vs ${away.display_name}`)}</h2>
        <div class="teams-row">
          <div class="team-side"><div class="flag">${teamMark(home)}</div><div class="name">${escapeHtml(home.display_name)}</div></div>
          ${matchScore(m)}
          <div class="team-side"><div class="flag">${teamMark(away)}</div><div class="name">${escapeHtml(away.display_name)}</div></div>
        </div>
        <div class="md-status ${statusClass(m.status)}">${matchTimeHtml(m)}</div>
      </header>
      <div class="modal-tabs md-tabs" role="tablist" aria-label="Detalle del partido">
        ${tabs.map(([key, label], i) => `<button type="button" role="tab" id="md-tab-${key}" data-modal-tab="${key}" aria-controls="md-panel-${key}" aria-selected="${i === 0}" class="${i === 0 ? 'active' : ''}">${escapeHtml(label)}</button>`).join('')}
      </div>
      ${tabs.map(([key, , html], i) => `<section class="md-panel" id="md-panel-${key}" data-modal-panel="${key}" role="tabpanel" aria-labelledby="md-tab-${key}"${i === 0 ? '' : ' hidden'}>${html}</section>`).join('')}
    </div>`;
}

async function openMatchDetail(matchId) {
  if (!matchId || !/^[0-9a-f-]{36}$/i.test(matchId)) return;
  const overlay = createModalOverlay('Cargando partido');
  overlay.classList.add('modal-overlay--sheet');
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal(overlay); });
  try {
    const detail = await cached('web/match-detail', { match_id: matchId }, 60000);
    if (!document.contains(overlay)) return;
    overlay.innerHTML = matchDetailHtml(detail);
    overlay.querySelectorAll('[data-modal-tab]').forEach((button) => {
      button.addEventListener('click', () => setModalTab(overlay, button.dataset.modalTab));
    });
    overlay.querySelector('[data-close-modal]').addEventListener('click', () => closeModal(overlay));
    overlay.querySelector('[data-close-modal]').focus();
  } catch (error) {
    if (!document.contains(overlay)) return;
    overlay.innerHTML = `<div class="modal-card"><button class="modal-close" data-close-modal aria-label="Cerrar">×</button><div class="error">${escapeHtml(error.message || error)}</div></div>`;
    overlay.querySelector('[data-close-modal]').addEventListener('click', () => closeModal(overlay));
  }
}

// Escape closes the top-most layer (player card → modal).
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const playerLayer = document.querySelector('.player-card-layer');
  if (playerLayer) { playerLayer.remove(); return; }
  const overlays = document.querySelectorAll('.modal-overlay');
  if (overlays.length) { closeModal(overlays[overlays.length - 1]); return; }
  closeMoreSheet();
});

// ─── Bottom navigation "Más" sheet (F-A.5) ───────────────────────────────────

function closeMoreSheet() {
  const sheet = document.getElementById('more-sheet');
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  document.getElementById('more-backdrop').hidden = true;
  document.querySelector('.bottom-tab[data-more]')?.setAttribute('aria-expanded', 'false');
}

(function initMoreSheet() {
  const trigger = document.querySelector('.bottom-tab[data-more]');
  const sheet = document.getElementById('more-sheet');
  const backdrop = document.getElementById('more-backdrop');
  if (!trigger || !sheet || !backdrop) return;
  trigger.addEventListener('click', () => {
    const open = sheet.hidden;
    sheet.hidden = !open;
    backdrop.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) sheet.querySelector('.more-item:not([hidden])')?.focus();
  });
  backdrop.addEventListener('click', closeMoreSheet);
})();

// ─── Offline banner + service worker (F-A.6) ─────────────────────────────────

function setOfflineBanner(show) {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.hidden = !(show || navigator.onLine === false);
}

window.addEventListener('online', () => setOfflineBanner(false));
window.addEventListener('offline', () => setOfflineBanner(true));

(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !isLocal) return;
  // Relative URL + scope so it works under the GitHub Pages prefix (/match_alpha_web/).
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => null);
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'ma-offline-cache') setOfflineBanner(true);
  });
})();

// Admin views (identity queue, ops) live in js/admin.js, loaded only with ?admin=1 so the public bundle
// ships no admin code. admin.js registers window.MA_ADMIN = { isAdminView, render }.
function isAdminView(view) { return Boolean(window.MA_ADMIN && window.MA_ADMIN.isAdminView(view)); }

if (new URLSearchParams(location.search).get('admin') === '1') {
  const script = document.createElement('script');
  script.src = `js/admin.js?v=${encodeURIComponent((document.querySelector('script[src*="js/app.js"]')?.src.split('v=')[1]) || '')}`;
  script.onload = () => render();
  script.onerror = () => render();
  document.head.append(script);
} else {
  render();
}
