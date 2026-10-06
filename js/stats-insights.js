/* Stats screen interpretation layer (pure, no DOM): sample maturity, model-vs-market verdicts, AI impact,
 * pick status summary and the 30-day performance summary. Rendering lives in app.js; everything that
 * decides WHAT to say lives here so it can be unit-tested (`node tests/stats-insights.test.js`).
 *
 * Nothing here recomputes a statistic: values come from the API as-is. The only arithmetic is counting
 * (picks / AI cases) and the difference of two values the API already returns (Brier IA − Brier modelo).
 */
(function (root) {
  // Sample minimums. They are separate domain rules that happen to share the value 30 today:
  //  * MIN_SAMPLE_SIZE: UI rule — settled results before a result (summary, model vs market, ROI by EV) is
  //    treated as more than preliminary.
  //  * MIN_AI_ACTIVATION_SAMPLE: backend app/learning/ai_policy.py MIN_SETTLED (one of three AI promotion
  //    conditions, with the p-value test and a lower error — never re-applied here).
  //  * MIN_CALIBRATION_SAMPLE: backend app/calibration/evaluator.py MIN_SAMPLES (settled predictions per
  //    selection needed to fit a calibration map).
  const MIN_SAMPLE_SIZE = 30;
  const MIN_AI_ACTIVATION_SAMPLE = 30;
  const MIN_CALIBRATION_SAMPLE = 30;
  // The backend's AI promotion test (app/learning/ai_policy.py MAX_P_VALUE): shown, never re-applied here.
  const AI_MAX_P_VALUE = 0.10;
  // Picks donut only when it says more than a list: at least this many distinct states.
  const DONUT_MIN_CATEGORIES = 3;

  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  const SAMPLE_LABELS = { NO_DATA: 'Sin resultados aún', INSUFFICIENT: 'Muestra insuficiente', READY: 'Muestra suficiente' };

  /**
   * The one place that decides the sample state of a metric / chart:
   *   NO_DATA (0 observations) · INSUFFICIENT (1 … minimum−1) · READY (≥ minimum).
   * `unit` names what is counted (resultados, predicciones…) so the label never implies another universe.
   */
  function getSampleStatus(n, minimum = MIN_SAMPLE_SIZE, unit = 'resultados') {
    const current = Math.max(0, Math.trunc(num(n) || 0));
    const status = current === 0 ? 'NO_DATA' : current < minimum ? 'INSUFFICIENT' : 'READY';
    return {
      status,
      current,
      minimum,
      label: SAMPLE_LABELS[status],
      countLabel: `${current} / ${minimum} ${unit}`,
      progress: Math.min(1, current / minimum),
    };
  }

  /** getSampleStatus in the shape the cards use (n / min / level / sufficient). */
  function sampleMaturity(n, min = MIN_SAMPLE_SIZE, unit = 'resultados') {
    const st = getSampleStatus(n, min, unit);
    const level = { NO_DATA: 'none', INSUFFICIENT: 'insufficient', READY: 'sufficient' }[st.status];
    return { ...st, n: st.current, min, level, sufficient: st.status === 'READY' };
  }

  /** A chart is shown only with enough observations; otherwise an empty state with progress. */
  function chartReadiness(n, min = MIN_SAMPLE_SIZE, unit) {
    const maturity = sampleMaturity(n, min, unit);
    return { show: maturity.sufficient, maturity };
  }

  /**
   * ROI by EV range. ROI = profit / stake over SETTLED decisions WITH a stake, so its N is
   * `staked_settled_count` (older backends: settled_count of buckets that do have a ROI). Buckets without a
   * ROI are not plotted (a 0 bar would read as a real break-even result).
   */
  function roiByEvReadiness(buckets) {
    const bs = Array.isArray(buckets) ? buckets : [];
    const points = bs.filter((b) => num(b && b.roi_pct) !== null);
    const hasStaked = bs.some((b) => b && b.staked_settled_count !== undefined);
    const n = hasStaked
      ? bs.reduce((s, b) => s + (num(b.staked_settled_count) || 0), 0)
      : points.reduce((s, b) => s + (num(b.settled_count) || 0), 0);
    const maturity = sampleMaturity(n, MIN_SAMPLE_SIZE, 'selecciones simuladas con resultado');
    return { show: maturity.sufficient && points.length > 0, maturity, points };
  }

  const HISTORY_KEYS = ['brier_score', 'log_loss', 'ece', 'clv_avg', 'paper_roi'];

  /**
   * Daily history: a time series is useful from its first real value, so there is no 30-result minimum —
   * only "no point has any metric" (dates without values) is an empty state.
   */
  function historyReadiness(series) {
    const list = Array.isArray(series) ? series : [];
    const points = list.filter((p) => p && HISTORY_KEYS.some((k) => num(p[k]) !== null && typeof p[k] !== 'boolean'));
    return { show: points.length > 0, points: points.length, days: list.length };
  }

  /**
   * Model vs market card verdict. `vs_market_ll_diff` = model log-loss − market log-loss (negative = the
   * model's probabilities beat the market's). With n < MIN the result is labelled preliminary.
   */
  function marketVerdict(card) {
    const diff = num(card && card.vs_market_ll_diff);
    const maturity = sampleMaturity(card && card.n);
    if (diff === null) {
      return { tone: 'neutral', title: 'Sin comparación con el mercado', diff: null, improvement: null, maturity, preliminary: false };
    }
    const better = diff < 0;
    const equal = diff === 0;
    let title;
    let tone;
    if (!maturity.sufficient) {
      title = equal ? 'Resultado preliminar: igual al mercado'
        : better ? 'Resultado preliminar favorable' : 'Resultado preliminar desfavorable';
      tone = 'pending';
    } else {
      title = equal ? 'Igual al mercado' : better ? 'Match Alpha supera al mercado' : 'El mercado supera a Match Alpha';
      tone = equal ? 'neutral' : better ? 'good' : 'bad';
    }
    return { tone, title, diff, improvement: better ? Math.abs(diff) : null, maturity, preliminary: !maturity.sufficient };
  }

  /** Brier of one AI policy stage (90-day window first, 30-day fallback), as stored by ai_policy_update. */
  function stageBrier(policy, stage) {
    const sm = (policy && policy.stage_metrics) || {};
    const m = sm[`${stage}_90d`] || sm[`${stage}_30d`];
    return m && m.brier_score != null ? num(m.brier_score) : null;
  }

  /** Helped / worsened / neutral counts from per-match Brier deltas (negative delta = AI helped). */
  function aiCaseCounts(items) {
    const counts = { helped: 0, worsened: 0, neutral: 0, total: 0 };
    (Array.isArray(items) ? items : []).forEach((it) => {
      const d = num(it && it.brier_delta);
      if (d === null) return;
      counts.total += 1;
      if (d < 0) counts.helped += 1;
      else if (d > 0) counts.worsened += 1;
      else counts.neutral += 1;
    });
    return counts;
  }

  /** What the mode / alpha mean for the final prediction (app/learning/ai_policy.py semantics). */
  function aiModeInfo(policy) {
    const mode = String((policy && policy.mode) || 'SHADOW').toUpperCase();
    const alpha = num(policy && policy.alpha) || 0;
    if (mode === 'OFF') return { mode, alpha, label: 'APAGADA', applied: false, text: 'La IA no se ejecuta en esta liga.' };
    if (mode === 'ACTIVE' && alpha > 0) {
      return { mode, alpha, label: 'ACTIVA', applied: true,
        text: `La IA ajusta la predicción final con peso ${alpha.toFixed(2)} (0 = solo modelo, 1 = solo IA).` };
    }
    return { mode, alpha, label: 'MODO SOMBRA', applied: false,
      text: 'La IA se calcula y se evalúa, pero no modifica la predicción final (peso 0).' };
  }

  /**
   * AI impact for one league: counts, Brier per stage and a DESCRIPTIVE comparison (no significance claim:
   * the only significance test is the backend's promotion rule, reflected by mode ACTIVE).
   */
  function aiImpact(policy, track) {
    const items = (track && Array.isArray(track.items) && track.items.length ? track.items : (track && track.largest_recent)) || [];
    const counts = aiCaseCounts(items);
    const n = num(track && track.n) ?? num(policy && policy.n_settled) ?? 0;
    const maturity = sampleMaturity(n, MIN_AI_ACTIVATION_SAMPLE);
    const brierModel = stageBrier(policy, 'raw');
    const brierAi = stageBrier(policy, 'ai');
    const brierCalibrated = stageBrier(policy, 'calibrated');
    const diff = brierModel !== null && brierAi !== null ? brierAi - brierModel : null;
    let verdict;
    if (diff === null || n === 0) verdict = { tone: 'neutral', title: 'Sin resultados de IA aún' };
    else if (diff < 0) verdict = { tone: maturity.sufficient ? 'good' : 'pending', title: 'IA con menor error que el modelo' };
    else if (diff > 0) verdict = { tone: maturity.sufficient ? 'bad' : 'pending', title: 'IA con mayor error que el modelo' };
    else verdict = { tone: 'neutral', title: 'IA igual al modelo' };
    if (n > 0 && !maturity.sufficient && diff !== null) verdict.title = `Preliminar: ${verdict.title}`;
    const mode = aiModeInfo(policy);
    return {
      counts, n, maturity, brierModel, brierAi, brierCalibrated, diff, verdict, mode,
      validated: mode.applied && num(policy && policy.p_value) !== null && num(policy.p_value) <= AI_MAX_P_VALUE,
      casesShown: counts.total, casesPartial: counts.total < n,
    };
  }

  /** Raw backend reason → user-facing Spanish text (the raw value stays available in the details). */
  function reasonLabel(reason) {
    const r = String(reason || '');
    if (!r) return '';
    const m = r.match(/^insufficient_samples\(<(\d+)\)$/);
    if (m) return `Muestra insuficiente (mínimo ${m[1]})`;
    return {
      ai_beats_raw: 'La IA mejora al modelo (validado)',
      ai_not_better: 'La IA no mejora al modelo',
      not_significant_or_alpha_zero: 'Diferencia no significativa',
      manual_override: 'Modo fijado manualmente',
    }[r] || r;
  }

  const STATUS_LABELS = {
    BETTABLE: 'Valor alto', PAPER_ONLY: 'En observación', NO_EDGE: 'Sin ventaja', BLOCKED: 'Bloqueadas',
  };
  const STATUS_ICONS = { BETTABLE: '✅', PAPER_ONLY: '📝', NO_EDGE: '➖', BLOCKED: '🚫' };

  /**
   * Betting decisions on two INDEPENDENT dimensions (a decision is e.g. BLOCKED and also PENDING), so they
   * are never listed as one set of categories:
   *   decision   — decision_status (BETTABLE / PAPER_ONLY / NO_EDGE / BLOCKED): sums to total
   *   resolution — settlement_status (pending / settled / other): also sums to total
   * `totals` (API /stats/bankroll → totals, every decision) is preferred; without it the counts cover only
   * the `decisions` list, which is the API's most recent `limit` rows (source = 'recent').
   */
  function pickStatusSummary(decisions, totals, limit) {
    const rows = [];
    if (Array.isArray(totals) && totals.length) {
      totals.forEach((t) => rows.push({ decision: t.decision_status, settlement: t.settlement_status, n: num(t.n) || 0 }));
    } else {
      (Array.isArray(decisions) ? decisions : []).forEach((d) => rows.push({
        decision: d && d.decision_status, settlement: d && d.settlement_status, n: 1,
      }));
    }
    const byStatus = {};
    const resolution = { pending: 0, settled: 0, other: 0 };
    let total = 0;
    rows.forEach((r) => {
      const s = String(r.decision || 'UNKNOWN');
      byStatus[s] = (byStatus[s] || 0) + r.n;
      total += r.n;
      const st = String(r.settlement || 'PENDING').toUpperCase();
      if (st === 'SETTLED') resolution.settled += r.n;
      else if (st === 'PENDING') resolution.pending += r.n;
      else resolution.other += r.n; // VOID / CANCELLED…: neither pending nor settled
    });
    const decisionRows = Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count, label: STATUS_LABELS[status] || status, icon: STATUS_ICONS[status] || '•' }));
    const source = Array.isArray(totals) && totals.length ? 'all' : 'recent';
    return {
      total, source, recentLimit: source === 'recent' ? num(limit) : null,
      rows: decisionRows, decisionRows, resolution,
      settled: resolution.settled, pending: resolution.pending,
      useDonut: decisionRows.length >= DONUT_MIN_CATEGORIES,
    };
  }

  /**
   * Summary card. Every value comes from the API and keeps its OWN universe and N:
   *   settled  — settled betting decisions (all of them via `totals`; fallback: settled with EV ≥ 0 from the
   *              ROI buckets). This is the header count and the sample badge.
   *   roi/roiN — profit / stake of settled decisions with a stake (settled-weighted bucket ROI, same formula
   *              as before); roiN = staked_settled_count (null when the backend does not send it).
   *   clv/clvN — /stats/clv summary (settled decisions with a closing line, `days` window).
   *   brier/brierN — latest calibration run: n settled predictions × selection of ONE competition/market.
   */
  function performanceSummary({ calibration, buckets, clv, totals }) {
    const latest = (Array.isArray(calibration) && calibration[0]) || {};
    const bs = Array.isArray(buckets) ? buckets : [];
    const settledFromBuckets = bs.reduce((s, b) => s + (num(b.settled_count) || 0), 0);
    const settledAll = Array.isArray(totals) && totals.length
      ? totals.reduce((s, t) => s + (String(t.settlement_status).toUpperCase() === 'SETTLED' ? num(t.n) || 0 : 0), 0)
      : null;
    // calibration/summary fallback row carries n_settled = settled betting decisions (same universe)
    const settled = settledAll ?? num(latest.n_settled) ?? (settledFromBuckets || 0);
    const roiWeight = bs.reduce((s, b) => s + (num(b.roi_pct) !== null ? num(b.settled_count) || 0 : 0), 0);
    const roi = roiWeight > 0 ? bs.reduce((s, b) => s + (num(b.roi_pct) || 0) * (num(b.roi_pct) !== null ? num(b.settled_count) || 0 : 0), 0) / roiWeight : null;
    const hasStaked = bs.some((b) => b && b.staked_settled_count !== undefined);
    const roiN = hasStaked ? bs.reduce((s, b) => s + (num(b.staked_settled_count) || 0), 0) : null;
    const clvSummary = (clv && clv.summary) || {};
    const clvN = num(clvSummary.n) || 0;
    const brier = num(latest.brier_score);
    return {
      settled,
      settledSource: settledAll !== null || num(latest.n_settled) !== null ? 'all' : 'ev_buckets',
      roi,
      roiN,
      clv: clvN > 0 ? num(clvSummary.clv_avg) : null,
      clvN,
      clvDays: num(clv && clv.days),
      brier,
      brierN: brier !== null ? num(latest.sample_size) || 0 : 0,
      brierScope: [latest.market_code, latest.competition_name || latest.season || null].filter(Boolean).join(' · ') || null,
      maturity: sampleMaturity(settled, MIN_SAMPLE_SIZE, 'decisiones con resultado'),
    };
  }

  /** Leagues whose card beats the market with a sufficient sample (future "supera al mercado" list). */
  function leaguesBeatingMarket(cards) {
    return (Array.isArray(cards) ? cards : [])
      .map((c) => ({ card: c, verdict: marketVerdict(c) }))
      .filter((x) => x.verdict.tone === 'good');
  }

  const STATS_TABS = ['performance', 'model', 'ai'];
  function normalizeStatsTab(tab) {
    return STATS_TABS.includes(tab) ? tab : 'performance';
  }

  const api = {
    MIN_SAMPLE_SIZE, MIN_AI_ACTIVATION_SAMPLE, MIN_CALIBRATION_SAMPLE, AI_MAX_P_VALUE, DONUT_MIN_CATEGORIES, STATS_TABS,
    getSampleStatus, sampleMaturity, chartReadiness, roiByEvReadiness, historyReadiness, marketVerdict, stageBrier, aiCaseCounts, aiModeInfo, aiImpact,
    reasonLabel, pickStatusSummary, performanceSummary, leaguesBeatingMarket, normalizeStatsTab,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MA_STATS = api;
}(typeof window !== 'undefined' ? window : globalThis));
