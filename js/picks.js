/* Match Alpha — Historial público de picks con CLV (Fase H).
 *
 * View "picks-history" registered in window.MA_VIEWS (app.js dispatches to it). Uses the shared
 * helpers from app.js (apiGet, escapeHtml, num, setStatus, loading, errorState, loadCompetitionCatalog).
 * Every API string goes through escapeHtml; numbers through num(). No inline handlers (CSP-friendly).
 */
(function () {
  'use strict';

  const PAGE_SIZE = 50;
  const MAX_EXPORT_PAGES = 20; // ≤ 1000 rows per CSV
  const MARKETS = [['', 'Todos'], ['1X2', '1X2'], ['OVER_UNDER', 'Más/Menos'], ['BTTS', 'Ambos marcan']];
  const RESULT_LABEL = { WIN: 'Ganado', LOSS: 'Perdido', HALF_WIN: '½ ganado', HALF_LOSS: '½ perdido', PUSH: 'Push', VOID: 'Nulo' };
  const filters = { competition: '', market: '', from: '', to: '', page: 1 };
  let lastData = null;

  const viewRoot = () => document.getElementById('view-root');
  const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${(num(v) * 100).toFixed(d)}%`);
  const fixed = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : num(v).toFixed(d));
  const signed = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${num(v) > 0 ? '+' : ''}${num(v).toFixed(d)}`);
  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  const slugOk = (v) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(v || '');

  function fmtKickoff(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function pickLabel(p) {
    const line = p.line === null || p.line === undefined ? '' : ` ${num(p.line)}`;
    return `${p.market || ''} · ${p.selection || ''}${line}`;
  }

  function queryParams(page) {
    return {
      competition: slugOk(filters.competition) ? filters.competition : undefined,
      market: filters.market || undefined,
      from: isoDate(filters.from) || undefined,
      to: isoDate(filters.to) || undefined,
      page,
    };
  }

  async function competitionOptions() {
    try {
      const { entries } = await loadCompetitionCatalog();
      const seen = new Map();
      entries.forEach((e) => {
        const slug = String(e.competition_slug || '');
        if (slugOk(slug) && !seen.has(slug)) seen.set(slug, String(e.competition_name || e.display_name || slug));
      });
      return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
    } catch {
      return [];
    }
  }

  function summaryCards(s) {
    const ci = s.roi_ci_low !== null && s.roi_ci_low !== undefined ? `IC 90%: ${pct(s.roi_ci_low)} a ${pct(s.roi_ci_high)}` : 'sin muestra';
    const cards = [
      ['Picks', String(num(s.n)), `${num(s.n_graded)} resueltos`],
      ['Acierto', pct(s.hit_rate), 'ganados / resueltos'],
      ['ROI (1u fija)', pct(s.roi), ci],
      ['Unidades', signed(s.profit_units), 'stake plano 1u'],
      ['CLV medio', s.clv_avg === null || s.clv_avg === undefined ? '—' : `${signed(num(s.clv_avg) * 100, 1)}%`, `${pct(s.clv_positive_rate, 0)} con CLV > 0`],
    ];
    return `<div class="ph-summary">${cards.map(([t, v, sub]) => `
      <div class="ph-stat"><span class="ph-stat-label">${escapeHtml(t)}</span>
        <strong class="ph-stat-value">${escapeHtml(v)}</strong>
        <span class="ph-stat-sub">${escapeHtml(sub)}</span></div>`).join('')}</div>`;
  }

  function resultChip(result) {
    const r = String(result || '');
    const cls = r.includes('WIN') ? 'ph-chip--win' : r.includes('LOSS') ? 'ph-chip--loss' : 'ph-chip--void';
    return `<span class="ph-chip ${cls}">${escapeHtml(RESULT_LABEL[r] || r || '—')}</span>`;
  }

  function stageChip(p) {
    const status = p.decision_status === 'BETTABLE' ? 'Apostable' : 'Paper';
    return `<span class="ph-chip ph-chip--muted">${escapeHtml(status)}</span>${p.ai_active ? '<span class="ph-chip ph-chip--ai">IA</span>' : ''}`;
  }

  function matchTitle(p) {
    return `${p.home_team || 'Local'} vs ${p.away_team || 'Visita'}`;
  }

  function score(p) {
    return p.home_score === null || p.home_score === undefined ? '' : `${num(p.home_score)}-${num(p.away_score)}`;
  }

  function rowsTable(picks) {
    return `<div class="ph-table-wrap"><table class="ph-table">
      <thead><tr><th>Fecha</th><th>Partido</th><th>Pick</th><th>Cuota</th><th>Cierre</th><th>CLV</th><th>EV</th><th>Resultado</th><th>U</th></tr></thead>
      <tbody>${picks.map((p) => `<tr>
        <td>${escapeHtml(fmtKickoff(p.kickoff_at))}</td>
        <td><button type="button" class="ph-link" data-ph-match="${escapeHtml(p.match_id)}">${escapeHtml(matchTitle(p))}</button>
          <small>${escapeHtml(p.competition_name || '')} ${escapeHtml(score(p))}</small></td>
        <td>${escapeHtml(pickLabel(p))} ${stageChip(p)}</td>
        <td>${escapeHtml(fixed(p.odds_taken))}</td>
        <td>${escapeHtml(fixed(p.closing_odds))}</td>
        <td class="${num(p.clv) > 0 ? 'ph-pos' : num(p.clv) < 0 ? 'ph-neg' : ''}">${escapeHtml(p.clv === null ? '—' : `${signed(num(p.clv) * 100, 1)}%`)}</td>
        <td>${escapeHtml(pct(p.ev))}</td>
        <td>${resultChip(p.result)}</td>
        <td class="${num(p.profit_units) > 0 ? 'ph-pos' : num(p.profit_units) < 0 ? 'ph-neg' : ''}">${escapeHtml(signed(p.profit_units))}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function rowsCards(picks) {
    return `<div class="ph-cards">${picks.map((p) => `
      <article class="ph-card">
        <header><button type="button" class="ph-link" data-ph-match="${escapeHtml(p.match_id)}">${escapeHtml(matchTitle(p))}</button>${resultChip(p.result)}</header>
        <div class="ph-card-meta">${escapeHtml(fmtKickoff(p.kickoff_at))} · ${escapeHtml(p.competition_name || '')} ${escapeHtml(score(p))}</div>
        <div class="ph-card-pick">${escapeHtml(pickLabel(p))} ${stageChip(p)}</div>
        <dl class="ph-card-grid">
          <div><dt>Cuota</dt><dd>${escapeHtml(fixed(p.odds_taken))}</dd></div>
          <div><dt>Cierre</dt><dd>${escapeHtml(fixed(p.closing_odds))}</dd></div>
          <div><dt>CLV</dt><dd>${escapeHtml(p.clv === null ? '—' : `${signed(num(p.clv) * 100, 1)}%`)}</dd></div>
          <div><dt>Unid.</dt><dd>${escapeHtml(signed(p.profit_units))}</dd></div>
        </dl>
      </article>`).join('')}</div>`;
  }

  function filterBar(options) {
    const opt = (value, label, current) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    return `<form class="ph-filters" id="ph-filters">
      <label>Competición<select name="competition">${opt('', 'Todas', filters.competition)}${options.map(([s, n]) => opt(s, n, filters.competition)).join('')}</select></label>
      <label>Mercado<select name="market">${MARKETS.map(([v, l]) => opt(v, l, filters.market)).join('')}</select></label>
      <label>Desde<input type="date" name="from" value="${escapeHtml(isoDate(filters.from))}"></label>
      <label>Hasta<input type="date" name="to" value="${escapeHtml(isoDate(filters.to))}"></label>
      <div class="ph-filter-actions">
        <button type="submit" class="ph-btn">Filtrar</button>
        <button type="button" class="ph-btn ph-btn--ghost" id="ph-export">Exportar CSV</button>
      </div>
    </form>`;
  }

  function pager(data) {
    const pages = Math.max(1, Math.ceil(num(data.total) / PAGE_SIZE));
    if (pages <= 1) return '';
    return `<nav class="ph-pager" aria-label="Páginas">
      <button type="button" class="ph-btn ph-btn--ghost" data-ph-page="${num(data.page) - 1}"${num(data.page) <= 1 ? ' disabled' : ''}>‹ Anterior</button>
      <span>Página ${num(data.page)} de ${pages}</span>
      <button type="button" class="ph-btn ph-btn--ghost" data-ph-page="${num(data.page) + 1}"${num(data.page) >= pages ? ' disabled' : ''}>Siguiente ›</button>
    </nav>`;
  }

  async function render(options = {}) {
    const el = viewRoot();
    if (!options.silent) loading('Historial');
    const [data, comps] = await Promise.all([
      apiGet('public/picks', queryParams(filters.page), { signal: options.signal }),
      competitionOptions(),
    ]);
    lastData = data;
    const picks = Array.isArray(data.picks) ? data.picks : [];
    const s = data.summary || {};
    setStatus('Historial', `${num(data.total)} picks`);
    el.innerHTML = `<div class="ph-view">
      <div class="ph-intro card">
        <h2>Historial de picks</h2>
        <p>Picks del modelo (apostables y <em>paper</em>) ya resueltos, publicados <strong>antes del inicio</strong> de cada partido.
        CLV = ln(cuota tomada / cuota de cierre sin margen, consenso). ROI con stake plano de 1 unidad. Son estimaciones estadísticas,
        no asesoría financiera; rendimientos pasados no garantizan resultados futuros. Solo mayores de 18 años.</p>
      </div>
      ${filterBar(comps)}
      ${summaryCards(s)}
      ${picks.length ? `${rowsTable(picks)}${rowsCards(picks)}${pager(data)}` : emptyState('No hay picks resueltos con estos filtros.')}
    </div>`;
    bind(el);
  }

  function bind(el) {
    el.querySelector('#ph-filters')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      filters.competition = slugOk(String(form.get('competition') || '')) ? String(form.get('competition')) : '';
      filters.market = MARKETS.some(([v]) => v === form.get('market')) ? String(form.get('market')) : '';
      filters.from = isoDate(String(form.get('from') || ''));
      filters.to = isoDate(String(form.get('to') || ''));
      filters.page = 1;
      render().catch(errorState);
    });
    el.querySelector('#ph-export')?.addEventListener('click', (event) => exportCsv(event.currentTarget));
    el.querySelectorAll('[data-ph-page]').forEach((b) => b.addEventListener('click', () => {
      const page = Math.max(1, Math.floor(num(b.dataset.phPage, 1)));
      filters.page = page;
      render().then(() => window.scrollTo({ top: 0 })).catch(errorState);
    }));
    el.querySelectorAll('[data-ph-match]').forEach((b) => b.addEventListener('click', () => {
      const id = String(b.dataset.phMatch || '');
      if (/^[0-9a-f-]{36}$/.test(id) && typeof openMatchDetail === 'function') openMatchDetail(id);
    }));
  }

  async function exportCsv(button) {
    if (!lastData) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Exportando…';
    try {
      const rows = [];
      const pages = Math.min(MAX_EXPORT_PAGES, Math.max(1, Math.ceil(num(lastData.total) / PAGE_SIZE)));
      for (let page = 1; page <= pages; page += 1) {
        const data = page === num(lastData.page) ? lastData : await apiGet('public/picks', queryParams(page));
        rows.push(...(Array.isArray(data.picks) ? data.picks : []));
      }
      const columns = [
        { key: 'kickoff_at', label: 'kickoff_utc' }, { key: 'decided_at', label: 'decided_at_utc' },
        { key: 'competition_name', label: 'competicion' }, { key: 'home_team', label: 'local' }, { key: 'away_team', label: 'visita' },
        { key: 'market', label: 'mercado' }, { key: 'selection', label: 'seleccion' }, { key: 'line', label: 'linea' },
        { key: 'decision_status', label: 'estado' }, { key: 'model_stage', label: 'etapa_modelo' },
        { key: 'odds_taken', label: 'cuota_tomada' }, { key: 'closing_odds', label: 'cuota_cierre_consenso' },
        { key: 'clv', label: 'clv_log' }, { key: 'ev', label: 'ev' }, { key: 'probability', label: 'probabilidad' },
        { key: 'result', label: 'resultado' }, { key: 'profit_units', label: 'unidades_1u' },
        { label: 'marcador', value: (r) => (r.home_score === null || r.home_score === undefined ? '' : `${num(r.home_score)}-${num(r.away_score)}`) },
      ];
      const blob = new Blob([window.MA_CSV.toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `match-alpha-picks-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      errorState(error);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  window.MA_VIEWS = window.MA_VIEWS || {};
  window.MA_VIEWS['picks-history'] = render;
}());
