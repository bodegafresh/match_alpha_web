/* Match Alpha — favoritos y notificaciones push (Fase H).
 *
 * - Favorites (team / competition slugs) live only in localStorage (no PII, no account).
 * - Web Push opt-in: GET push/config (VAPID public key) → Notification permission → pushManager.subscribe →
 *   POST push/subscribe {subscription, favorites, min_ev, quiet hours}. The backend returns
 *   {subscription_id, manage_token}; both stay in localStorage and are needed to unsubscribe (DELETE).
 * - Unsupported browsers degrade gracefully; iOS needs the PWA installed on the home screen (iOS ≥ 16.4).
 * - Deep link ?match=<uuid> (used by notification clicks) opens the match detail.
 * View "alerts" registered in window.MA_VIEWS. No inline handlers (CSP-friendly).
 */
(function () {
  'use strict';

  const FAV_KEY = 'ma_favorites_v1';
  const PUSH_KEY = 'ma_push_v1';
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const EV_OPTIONS = [0.02, 0.03, 0.05, 0.08, 0.1];
  const MAX_TEAMS = 50;
  const MAX_COMPS = 30;

  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v && typeof v === 'object' ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function loadFavorites() {
    const raw = readJson(FAV_KEY, {});
    const clean = (list, max) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && SLUG_RE.test(s)).slice(0, max) : []);
    const ev = EV_OPTIONS.includes(Number(raw.min_ev)) ? Number(raw.min_ev) : 0.03;
    const hour = (h) => (Number.isInteger(h) && h >= 0 && h <= 23 ? h : null);
    return {
      teams: clean(raw.teams, MAX_TEAMS), competitions: clean(raw.competitions, MAX_COMPS), min_ev: ev,
      include_paper: raw.include_paper !== false, quiet_start: hour(raw.quiet_start), quiet_end: hour(raw.quiet_end),
    };
  }

  function saveFavorites(f) { localStorage.setItem(FAV_KEY, JSON.stringify(f)); }

  function pushState() {
    const s = readJson(PUSH_KEY, null);
    return s && UUID_RE.test(String(s.subscription_id || '')) && /^[A-Za-z0-9_-]{20,128}$/.test(String(s.manage_token || '')) ? s : null;
  }

  function support() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    return { supported, ios, standalone };
  }

  // Local hour → UTC hour (the backend evaluates quiet hours in UTC).
  function toUtcHour(localHour) {
    if (localHour === null) return null;
    const d = new Date();
    d.setHours(localHour, 0, 0, 0);
    return d.getUTCHours();
  }

  function b64urlToUint8(base64url) {
    const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function apiSend(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const key = savedKey();
    if (key) headers['X-API-Key'] = key;
    const response = await fetch(`${API_BASE_URL}/${path}`, { method, headers, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (response.status === 429) throw new Error('Demasiados intentos; espera un minuto.');
    if (!response.ok || json.ok === false) throw new Error(typeof json.detail === 'string' ? json.detail : `HTTP ${response.status}`);
    return json.data || {};
  }

  function subscribeBody(subscription, fav) {
    const json = subscription.toJSON();
    return {
      subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } },
      favorite_teams: fav.teams, favorite_competitions: fav.competitions, min_ev: fav.min_ev,
      include_paper: fav.include_paper, quiet_start_hour: toUtcHour(fav.quiet_start), quiet_end_hour: toUtcHour(fav.quiet_end),
    };
  }

  async function enablePush(fav) {
    const config = await apiGet('push/config');
    if (!config.enabled || !config.vapid_public_key) throw new Error('Las notificaciones aún no están habilitadas en el servidor.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado en el navegador.');
    const reg = await navigator.serviceWorker.ready;
    const subscription = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToUint8(String(config.vapid_public_key)) });
    const data = await apiSend('POST', 'push/subscribe', subscribeBody(subscription, fav));
    localStorage.setItem(PUSH_KEY, JSON.stringify({ subscription_id: data.subscription_id, manage_token: data.manage_token }));
  }

  async function syncPush(fav) {
    if (!pushState() || !support().supported) return;
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;
    const data = await apiSend('POST', 'push/subscribe', subscribeBody(subscription, fav));
    localStorage.setItem(PUSH_KEY, JSON.stringify({ subscription_id: data.subscription_id, manage_token: data.manage_token }));
  }

  async function disablePush() {
    const state = pushState();
    if (state) await apiSend('DELETE', 'push/subscribe', state).catch(() => null);
    localStorage.removeItem(PUSH_KEY);
    if (support().supported) {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
  }

  function supportNotice() {
    const s = support();
    if (s.ios && !s.standalone) {
      return `<p class="pa-note">En iPhone/iPad las notificaciones solo funcionan con la app instalada (iOS 16.4 o superior):
        toca <strong>Compartir → Agregar a pantalla de inicio</strong> y abre Match Alpha desde el ícono.</p>`;
    }
    if (!s.supported) return '<p class="pa-note">Este navegador no soporta notificaciones push. Tus favoritos igual se guardan en este dispositivo.</p>';
    if (Notification.permission === 'denied') return '<p class="pa-note">Bloqueaste las notificaciones para este sitio; habilítalas en la configuración del navegador.</p>';
    return '';
  }

  async function teamOptions(signal) {
    try {
      const data = await cached(`competitions/${SEASON}/teams`, { sort: 'name' }, 300000, { signal });
      return (data.teams || []).map((t) => [String(t.slug || t.team_slug || ''), String(t.display_name || t.name || t.team_name || '')])
        .filter(([slug]) => SLUG_RE.test(slug));
    } catch {
      return [];
    }
  }

  async function competitionChoices() {
    try {
      const { entries } = await loadCompetitionCatalog();
      const seen = new Map();
      entries.forEach((e) => {
        const slug = String(e.competition_slug || '');
        if (SLUG_RE.test(slug) && !seen.has(slug)) seen.set(slug, String(e.competition_name || e.display_name || slug));
      });
      return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
    } catch {
      return [];
    }
  }

  function checkList(name, items, selected) {
    if (!items.length) return '<p class="pa-note">Sin datos disponibles.</p>';
    return `<div class="pa-checks">${items.map(([slug, label]) => `
      <label class="pa-check"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(slug)}"${selected.includes(slug) ? ' checked' : ''}>
      <span>${escapeHtml(label || slug)}</span></label>`).join('')}</div>`;
  }

  function hourSelect(name, value) {
    const opts = ['<option value="">—</option>'];
    for (let h = 0; h < 24; h += 1) opts.push(`<option value="${h}"${value === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`);
    return `<select name="${escapeHtml(name)}">${opts.join('')}</select>`;
  }

  async function render(options = {}) {
    const el = document.getElementById('view-root');
    if (!options.silent) loading('Alertas');
    const fav = loadFavorites();
    const [teams, comps] = await Promise.all([teamOptions(options.signal), competitionChoices()]);
    const active = Boolean(pushState());
    setStatus('Alertas', active ? 'notificaciones activas' : 'notificaciones apagadas');
    el.innerHTML = `<form class="pa-view" id="pa-form">
      <section class="card pa-card">
        <h2>Notificaciones de selecciones</h2>
        <p>Recibe un aviso cuando el modelo publique una selección con valor estimado sobre tu umbral para tus equipos o competiciones favoritas
        (si no eliges ninguno, recibes todos). Son estimaciones estadísticas, no asesoría financiera. Solo mayores de 18 años.</p>
        ${supportNotice()}
        <div class="pa-row">
          <label>Valor estimado mínimo<select name="min_ev">${EV_OPTIONS.map((v) => `<option value="${v}"${v === fav.min_ev ? ' selected' : ''}>${Math.round(v * 100)}%</option>`).join('')}</select></label>
          <label class="pa-check"><input type="checkbox" name="include_paper"${fav.include_paper ? ' checked' : ''}><span>Incluir selecciones en observación</span></label>
        </div>
        <div class="pa-row">
          <label>Silencio desde${hourSelect('quiet_start', fav.quiet_start)}</label>
          <label>hasta${hourSelect('quiet_end', fav.quiet_end)}</label>
        </div>
        <div class="pa-actions">
          <button type="submit" class="ph-btn">Guardar favoritos</button>
          ${active
            ? '<button type="button" class="ph-btn ph-btn--ghost" id="pa-disable">Desactivar notificaciones</button>'
            : `<button type="button" class="ph-btn ph-btn--ghost" id="pa-enable"${support().supported ? '' : ' disabled'}>Activar notificaciones</button>`}
        </div>
        <p class="pa-msg" id="pa-msg" role="status" aria-live="polite"></p>
      </section>
      <section class="card pa-card">
        <h3>Competiciones favoritas</h3>
        ${checkList('competitions', comps, fav.competitions)}
      </section>
      <section class="card pa-card">
        <h3>Equipos favoritos <small>(${escapeHtml(SEASON)})</small></h3>
        <input type="search" class="pa-search" id="pa-team-search" placeholder="Buscar equipo" aria-label="Buscar equipo">
        ${checkList('teams', teams, fav.teams)}
      </section>
    </form>`;
    bind(el);
  }

  function readForm(form) {
    const data = new FormData(form);
    const pick = (name, max) => data.getAll(name).map(String).filter((s) => SLUG_RE.test(s)).slice(0, max);
    const hour = (name) => { const v = String(data.get(name) || ''); return v === '' ? null : Math.min(23, Math.max(0, parseInt(v, 10) || 0)); };
    const ev = Number(data.get('min_ev'));
    return {
      teams: pick('teams', MAX_TEAMS), competitions: pick('competitions', MAX_COMPS),
      min_ev: EV_OPTIONS.includes(ev) ? ev : 0.03, include_paper: data.get('include_paper') !== null,
      quiet_start: hour('quiet_start'), quiet_end: hour('quiet_end'),
    };
  }

  function bind(el) {
    const form = el.querySelector('#pa-form');
    const msg = el.querySelector('#pa-msg');
    const say = (text) => { if (msg) msg.textContent = text; };
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fav = readForm(form);
      saveFavorites(fav);
      try {
        await syncPush(fav);
        say('Favoritos guardados.');
      } catch (error) {
        say(`Favoritos guardados localmente; no se pudo actualizar el servidor (${error.message}).`);
      }
    });
    el.querySelector('#pa-enable')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      const fav = readForm(form);
      saveFavorites(fav);
      try {
        await enablePush(fav);
        say('Notificaciones activadas.');
        render({ silent: true });
      } catch (error) {
        say(error.message);
        event.currentTarget.disabled = false;
      }
    });
    el.querySelector('#pa-disable')?.addEventListener('click', async () => {
      await disablePush().catch(() => null);
      say('Notificaciones desactivadas.');
      render({ silent: true });
    });
    el.querySelector('#pa-team-search')?.addEventListener('input', (event) => {
      const q = String(event.target.value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      el.querySelectorAll('.pa-checks input[name="teams"]').forEach((input) => {
        const text = input.parentElement.textContent.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        input.parentElement.hidden = Boolean(q) && !text.includes(q);
      });
    });
  }

  // Deep link from a notification: ./?match=<uuid>
  function openDeepLink() {
    const params = new URLSearchParams(location.search);
    const id = params.get('match') || '';
    if (UUID_RE.test(id) && typeof openMatchDetail === 'function') openMatchDetail(id);
    // PWA shortcuts: ?view=picks-history | ?view=alerts
    const view = params.get('view') || '';
    if (Object.prototype.hasOwnProperty.call(window.MA_VIEWS, view)) {
      document.querySelector(`.more-item[data-view="${CSS.escape(view)}"]`)?.click();
    }
  }

  window.MA_VIEWS = window.MA_VIEWS || {};
  window.MA_VIEWS.alerts = render;
  window.MA_FAVORITES = { load: loadFavorites };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openDeepLink);
  else openDeepLink();
}());
