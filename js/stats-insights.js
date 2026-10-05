/* Stats screen interpretation layer (pure, no DOM): sample maturity, model-vs-market verdicts, AI impact,
 * pick status summary and the 30-day performance summary. Rendering lives in app.js; everything that
 * decides WHAT to say lives here so it can be unit-tested (`node tests/stats-insights.test.js`).
 *
 * Nothing here recomputes a statistic: values come from the API as-is. The only arithmetic is counting
 * (picks / AI cases) and the difference of two values the API already returns (Brier IA − Brier modelo).
 */
(function (root) {
  // Minimum settled results before a result is treated as more than preliminary. Same value as the
  // backend thresholds (app/learning/ai_policy.py MIN_SETTLED and the calibration minimum sample).
  const MIN_SAMPLE_SIZE = 30;
  // The backend's AI promotion test (app/learning/ai_policy.py MAX_P_VALUE): shown, never re-applied here.
  const AI_MAX_P_VALUE = 0.10;
  // Picks donut only when it says more than a list: at least this many distinct states.
  const DONUT_MIN_CATEGORIES = 3;

  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  /** Sample maturity for n results. level: none | insufficient | sufficient. */
  function sampleMaturity(n, min = MIN_SAMPLE_SIZE) {
    const value = Math.max(0, Math.trunc(num(n) || 0));
    const level = value === 0 ? 'none' : value < min ? 'insufficient' : 'sufficient';
    return {
      n: value,
      min,
      level,
      sufficient: level === 'sufficient',
      progress: Math.min(1, value / min),
      label: level === 'sufficient' ? 'Muestra suficiente' : level === 'none' ? 'Sin resultados aún' : 'Muestra insuficiente',
      countLabel: `${value} / ${min} resultados`,
    };
  }

  /** A chart is shown only with enough observations; otherwise an empty state with progress. */
  function chartReadiness(n, min = MIN_SAMPLE_SIZE) {
    const maturity = sampleMaturity(n, min);
    return { show: maturity.sufficient, maturity };
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
    const maturity = sampleMaturity(n);
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
    BETTABLE: 'Apostables', PAPER_ONLY: 'Solo papel', NO_EDGE: 'Sin ventaja', BLOCKED: 'Bloqueados',
  };
  const STATUS_ICONS = { BETTABLE: '✅', PAPER_ONLY: '📝', NO_EDGE: '➖', BLOCKED: '🚫' };

  /** Pick counts by decision status (real states only) + settlement, and whether a donut adds value. */
  function pickStatusSummary(decisions) {
    const list = Array.isArray(decisions) ? decisions : [];
    const byStatus = {};
    let settled = 0;
    let pending = 0;
    list.forEach((d) => {
      const s = String((d && d.decision_status) || 'UNKNOWN');
      byStatus[s] = (byStatus[s] || 0) + 1;
      if (d && d.settlement_status === 'SETTLED') settled += 1;
      else if (d && (d.settlement_status === 'PENDING' || !d.settlement_status)) pending += 1;
    });
    const rows = Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count, label: STATUS_LABELS[status] || status, icon: STATUS_ICONS[status] || '•' }));
    return { total: list.length, rows, settled, pending, useDonut: rows.length >= DONUT_MIN_CATEGORIES };
  }

  /**
   * Summary card. Every value is taken from the API: settled count from calibration / ROI buckets, ROI as the
   * settled-weighted average of bucket ROI (same formula the KPI bar already used), CLV from /stats/clv
   * (days window), Brier from the latest calibration run.
   */
  function performanceSummary({ calibration, buckets, clv }) {
    const latest = (Array.isArray(calibration) && calibration[0]) || {};
    const bs = Array.isArray(buckets) ? buckets : [];
    const settledFromBuckets = bs.reduce((s, b) => s + (num(b.settled_count) || 0), 0);
    const settled = num(latest.n_settled) ?? (settledFromBuckets || num(latest.sample_size) || 0);
    const roiWeight = bs.reduce((s, b) => s + (num(b.roi_pct) !== null ? num(b.settled_count) || 0 : 0), 0);
    const roi = roiWeight > 0 ? bs.reduce((s, b) => s + (num(b.roi_pct) || 0) * (num(b.roi_pct) !== null ? num(b.settled_count) || 0 : 0), 0) / roiWeight : null;
    const clvSummary = (clv && clv.summary) || {};
    const clvN = num(clvSummary.n) || 0;
    return {
      settled,
      roi,
      clv: clvN > 0 ? num(clvSummary.clv_avg) : null,
      clvN,
      clvDays: num(clv && clv.days),
      brier: num(latest.brier_score),
      brierN: num(latest.sample_size) || 0,
      maturity: sampleMaturity(settled),
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
    MIN_SAMPLE_SIZE, AI_MAX_P_VALUE, DONUT_MIN_CATEGORIES, STATS_TABS,
    sampleMaturity, chartReadiness, marketVerdict, stageBrier, aiCaseCounts, aiModeInfo, aiImpact,
    reasonLabel, pickStatusSummary, performanceSummary, leaguesBeatingMarket, normalizeStatsTab,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MA_STATS = api;
}(typeof window !== 'undefined' ? window : globalThis));
