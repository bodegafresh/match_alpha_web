/* Display of mutually exclusive outcome probabilities (1X2: home / draw / away). Pure, no DOM; tested by
 * `node tests/probabilities.test.js`.
 *
 * Rounding each value on its own can show 33 % + 33 % + 33 % = 99 %. Here a complete set is normalised to sum
 * 1 and rounded with the largest-remainder method, so the shown integers always add up to exactly 100 and
 * each one differs from its exact value by less than 1 point. The stage is never mixed: calibrated values are
 * used only when every selection has one, otherwise all raw values.
 */
(function (root) {
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  /** Integer percentages (largest remainder) of `values` (fractions); null entries stay null. */
  function roundedPercents(values, total = 100) {
    const xs = (Array.isArray(values) ? values : []).map(num);
    const present = xs.map((v, i) => [v, i]).filter(([v]) => v !== null && v >= 0);
    const sum = present.reduce((s, [v]) => s + v, 0);
    const out = xs.map(() => null);
    if (!present.length || sum <= 0) return out;
    const exact = present.map(([v, i]) => ({ i, x: (v / sum) * total }));
    exact.forEach((e) => { out[e.i] = Math.floor(e.x); });
    let left = total - exact.reduce((s, e) => s + out[e.i], 0);
    exact
      .slice()
      .sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || a.i - b.i)
      .forEach((e) => { if (left > 0) { out[e.i] += 1; left -= 1; } });
    return out;
  }

  /**
   * Percentages to show for one complete outcome set {SEL: fraction}. Incomplete sets (a missing selection)
   * are not normalised — they are shown rounded individually, since their sum is not meant to be 100.
   */
  function outcomeSetPercents(bySelection, selections) {
    const vals = selections.map((s) => num(bySelection && bySelection[s]));
    if (vals.some((v) => v === null)) {
      return Object.fromEntries(selections.map((s, i) => [s, vals[i] === null ? null : Math.round(vals[i] * 100)]));
    }
    const pcts = roundedPercents(vals);
    return Object.fromEntries(selections.map((s, i) => [s, pcts[i]]));
  }

  /** Model probability per selection from 1X2 prediction rows, one stage for the whole set. */
  function modelOutcomeSet(predsBySelection, selections) {
    const rows = selections.map((s) => (predsBySelection && predsBySelection[s]) || {});
    const allCalibrated = rows.every((p) => num(p.calibrated_probability) !== null);
    const key = allCalibrated ? 'calibrated_probability' : 'raw_probability';
    return { stage: allCalibrated ? 'calibrated' : 'raw', values: Object.fromEntries(selections.map((s, i) => [s, num(rows[i][key])])) };
  }

  const api = { roundedPercents, outcomeSetPercents, modelOutcomeSet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MA_PROB = api;
}(typeof window !== 'undefined' ? window : globalThis));
