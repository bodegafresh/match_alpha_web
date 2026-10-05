// Run: node tests/stats-insights.test.js  (no dependencies)
const assert = require('assert');
const S = require('../js/stats-insights.js');

const MIN = S.MIN_SAMPLE_SIZE;
assert.strictEqual(MIN, 30);

// ── sample maturity: n = 0, 1, 3, 29, 30, > 30, null ──────────────────────────
let m = S.sampleMaturity(0);
assert.strictEqual(m.level, 'none'); assert.strictEqual(m.sufficient, false); assert.strictEqual(m.countLabel, '0 / 30 resultados');
for (const n of [1, 3, 29]) {
  m = S.sampleMaturity(n);
  assert.strictEqual(m.level, 'insufficient', `n=${n}`);
  assert.strictEqual(m.label, 'Muestra insuficiente');
  assert.strictEqual(m.countLabel, `${n} / 30 resultados`);
  assert.ok(m.progress > 0 && m.progress < 1);
}
m = S.sampleMaturity(30);
assert.strictEqual(m.level, 'sufficient'); assert.strictEqual(m.progress, 1);
m = S.sampleMaturity(250);
assert.strictEqual(m.sufficient, true); assert.strictEqual(m.progress, 1); assert.strictEqual(m.countLabel, '250 / 30 resultados');
assert.strictEqual(S.sampleMaturity(null).level, 'none');
assert.strictEqual(S.sampleMaturity(undefined).n, 0);

// ── charts: hidden below the minimum, shown from it ───────────────────────────
assert.strictEqual(S.chartReadiness(0).show, false);
assert.strictEqual(S.chartReadiness(3).show, false);
assert.strictEqual(S.chartReadiness(29).show, false);
assert.strictEqual(S.chartReadiness(30).show, true);

// ── model vs market verdicts ──────────────────────────────────────────────────
let v = S.marketVerdict({ vs_market_ll_diff: -0.5716, n: 3 });
assert.strictEqual(v.title, 'Resultado preliminar favorable');
assert.strictEqual(v.tone, 'pending'); // never "good" (green) with a small sample
assert.strictEqual(v.preliminary, true); assert.strictEqual(v.improvement, 0.5716);
v = S.marketVerdict({ vs_market_ll_diff: -0.01, n: 1 });
assert.strictEqual(v.tone, 'pending');
v = S.marketVerdict({ vs_market_ll_diff: 0.02, n: 29 });
assert.strictEqual(v.title, 'Resultado preliminar desfavorable'); assert.strictEqual(v.improvement, null);
v = S.marketVerdict({ vs_market_ll_diff: -0.01, n: 30 });
assert.strictEqual(v.tone, 'good'); assert.strictEqual(v.title, 'Match Alpha supera al mercado');
v = S.marketVerdict({ vs_market_ll_diff: 0.03, n: 120 });
assert.strictEqual(v.tone, 'bad'); assert.strictEqual(v.title, 'El mercado supera a Match Alpha');
v = S.marketVerdict({ vs_market_ll_diff: null, n: 50 });
assert.strictEqual(v.title, 'Sin comparación con el mercado'); assert.strictEqual(v.diff, null);
v = S.marketVerdict({}); // league without data
assert.strictEqual(v.maturity.level, 'none');
assert.strictEqual(S.leaguesBeatingMarket([{ vs_market_ll_diff: -0.1, n: 40 }, { vs_market_ll_diff: -0.1, n: 3 }]).length, 1);

// ── AI impact ─────────────────────────────────────────────────────────────────
const policy = (over = {}) => ({
  competition: 'arg', mode: 'SHADOW', alpha: 0, n_settled: 8, reason: 'insufficient_samples(<30)',
  stage_metrics: { raw_90d: { brier_score: 0.2264 }, ai_90d: { brier_score: 0.2257 }, calibrated_90d: { brier_score: 0.2138 } },
  ...over,
});
const items = [-0.01, -0.02, 0.01, 0.03, 0.005, 0, 0, 0].map((d) => ({ brier_delta: d }));
let imp = S.aiImpact(policy(), { n: 8, items });
assert.deepStrictEqual(imp.counts, { helped: 2, worsened: 3, neutral: 3, total: 8 });
assert.strictEqual(imp.maturity.level, 'insufficient');
assert.ok(Math.abs(imp.diff - (0.2257 - 0.2264)) < 1e-12);
assert.strictEqual(imp.verdict.title, 'Preliminar: IA con menor error que el modelo');
assert.strictEqual(imp.verdict.tone, 'pending');
assert.strictEqual(imp.mode.label, 'MODO SOMBRA'); assert.strictEqual(imp.mode.applied, false);
assert.strictEqual(imp.validated, false);
// only "helped"
imp = S.aiImpact(policy(), { n: 2, items: [{ brier_delta: -0.1 }, { brier_delta: -0.2 }] });
assert.deepStrictEqual(imp.counts, { helped: 2, worsened: 0, neutral: 0, total: 2 });
// only "worsened", enough sample, AI worse
imp = S.aiImpact(policy({ n_settled: 40, stage_metrics: { raw_90d: { brier_score: 0.2 }, ai_90d: { brier_score: 0.21 } } }),
  { n: 40, items: [{ brier_delta: 0.05 }] });
assert.strictEqual(imp.counts.worsened, 1); assert.strictEqual(imp.verdict.title, 'IA con mayor error que el modelo');
assert.strictEqual(imp.verdict.tone, 'bad'); assert.strictEqual(imp.casesPartial, true);
// AI without results
imp = S.aiImpact(policy({ n_settled: 0, stage_metrics: null }), {});
assert.strictEqual(imp.verdict.title, 'Sin resultados de IA aún'); assert.strictEqual(imp.counts.total, 0);
assert.strictEqual(imp.brierModel, null);
// ACTIVE with alpha > 0 → applied; validated only when p ≤ 0.10
imp = S.aiImpact(policy({ mode: 'ACTIVE', alpha: 0.4, p_value: 0.05, n_settled: 45 }), { n: 45, items: [] });
assert.strictEqual(imp.mode.applied, true); assert.strictEqual(imp.validated, true);
assert.ok(imp.mode.text.includes('0.40'));
// ACTIVE but alpha 0 → treated as not modifying the final prediction
assert.strictEqual(S.aiModeInfo({ mode: 'ACTIVE', alpha: 0 }).applied, false);
assert.strictEqual(S.aiModeInfo({ mode: 'OFF' }).label, 'APAGADA');
// falls back to largest_recent when items are absent (older backend)
assert.strictEqual(S.aiImpact(policy(), { n: 1, largest_recent: [{ brier_delta: -0.1 }] }).counts.helped, 1);

// ── terminology ───────────────────────────────────────────────────────────────
assert.strictEqual(S.reasonLabel('insufficient_samples(<30)'), 'Muestra insuficiente (mínimo 30)');
assert.strictEqual(S.reasonLabel('ai_not_better'), 'La IA no mejora al modelo');
assert.strictEqual(S.reasonLabel(''), '');
assert.strictEqual(S.reasonLabel('something_new'), 'something_new');

// ── picks by status (real states only) ────────────────────────────────────────
let ps = S.pickStatusSummary([]);
assert.strictEqual(ps.total, 0); assert.strictEqual(ps.useDonut, false);
ps = S.pickStatusSummary([
  { decision_status: 'BLOCKED', settlement_status: 'PENDING' }, { decision_status: 'BLOCKED', settlement_status: 'SETTLED' },
  { decision_status: 'PAPER_ONLY', settlement_status: 'SETTLED' },
]);
assert.strictEqual(ps.rows[0].status, 'BLOCKED'); assert.strictEqual(ps.rows[0].label, 'Bloqueados');
assert.strictEqual(ps.settled, 2); assert.strictEqual(ps.pending, 1); assert.strictEqual(ps.useDonut, false);
ps = S.pickStatusSummary(['BLOCKED', 'PAPER_ONLY', 'NO_EDGE', 'BETTABLE'].map((s) => ({ decision_status: s })));
assert.strictEqual(ps.useDonut, true);

// ── performance summary: values from the API, null-safe ───────────────────────
let p = S.performanceSummary({ calibration: [], buckets: [], clv: null });
assert.strictEqual(p.settled, 0); assert.strictEqual(p.roi, null); assert.strictEqual(p.clv, null); assert.strictEqual(p.brier, null);
p = S.performanceSummary({
  calibration: [{ brier_score: 0.1811, sample_size: 36 }],
  buckets: [{ settled_count: 10, roi_pct: 5 }, { settled_count: 30, roi_pct: -5 }, { settled_count: 4, roi_pct: null }],
  clv: { days: 30, summary: { n: 0, clv_avg: null } },
});
assert.strictEqual(p.settled, 44); // settled from buckets
assert.strictEqual(p.roi, (10 * 5 + 30 * -5) / 40); // ROI weighted only by buckets that have an ROI
assert.strictEqual(p.clv, null); // CLV absent (n = 0) → null, never 0
assert.strictEqual(p.brier, 0.1811); assert.strictEqual(p.maturity.sufficient, true);
p = S.performanceSummary({ calibration: [{ n_settled: 3 }], buckets: [], clv: { days: 30, summary: { n: 5, clv_avg: 0.012 } } });
assert.strictEqual(p.settled, 3); assert.strictEqual(p.clv, 0.012); assert.strictEqual(p.clvDays, 30);
assert.strictEqual(p.maturity.countLabel, '3 / 30 resultados');

// ── tab navigation ────────────────────────────────────────────────────────────
assert.deepStrictEqual(S.STATS_TABS, ['performance', 'model', 'ai']);
assert.strictEqual(S.normalizeStatsTab(undefined), 'performance'); // default tab
assert.strictEqual(S.normalizeStatsTab('ai'), 'ai');
assert.strictEqual(S.normalizeStatsTab('<script>'), 'performance');

console.log('stats-insights.test.js OK');
