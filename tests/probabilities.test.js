// Run: node tests/probabilities.test.js  (no dependencies)
const assert = require('assert');
const P = require('../js/probabilities.js');

const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);

// naive rounding gives 99 / 101; largest remainder always 100
assert.deepStrictEqual(P.roundedPercents([1 / 3, 1 / 3, 1 / 3]), [34, 33, 33]);
assert.strictEqual(sum(P.roundedPercents([0.335, 0.335, 0.33])), 100);
assert.strictEqual(sum(P.roundedPercents([0.245, 0.285, 0.47])), 100); // naive: 25 + 29 + 47 = 101
assert.deepStrictEqual(P.roundedPercents([0.2481, 0.2892, 0.4627]), [25, 29, 46]);
// un-normalised input (e.g. old rows summing 118 %) is normalised first
assert.strictEqual(sum(P.roundedPercents([0.1818, 0.1987, 0.8])), 100);
// randomized invariant: always 100 and each within 1 point of its exact share
for (let k = 0; k < 2000; k += 1) {
  const a = Math.random(); const b = Math.random() * (1 - a); const v = [a, b, 1 - a - b];
  const r = P.roundedPercents(v);
  assert.strictEqual(sum(r), 100);
  r.forEach((x, i) => assert.ok(Math.abs(x - v[i] * 100) < 1, `${v} → ${r}`));
}
// edge cases
assert.deepStrictEqual(P.roundedPercents([]), []);
assert.deepStrictEqual(P.roundedPercents([null, null]), [null, null]);
assert.deepStrictEqual(P.roundedPercents([0, 0, 0]), [null, null, null]);
assert.deepStrictEqual(P.roundedPercents([1, 0, 0]), [100, 0, 0]);

const SEL = ['HOME', 'DRAW', 'AWAY'];
let o = P.outcomeSetPercents({ HOME: 0.333, DRAW: 0.333, AWAY: 0.334 }, SEL);
assert.strictEqual(o.HOME + o.DRAW + o.AWAY, 100);
o = P.outcomeSetPercents({ HOME: 0.5, DRAW: null, AWAY: 0.3 }, SEL); // incomplete: no forced 100
assert.deepStrictEqual(o, { HOME: 50, DRAW: null, AWAY: 30 });

// model stage never mixed
let m = P.modelOutcomeSet({
  HOME: { calibrated_probability: 0.5, raw_probability: 0.4 }, DRAW: { raw_probability: 0.3 }, AWAY: { calibrated_probability: 0.3, raw_probability: 0.3 },
}, SEL);
assert.strictEqual(m.stage, 'raw'); assert.deepStrictEqual(m.values, { HOME: 0.4, DRAW: 0.3, AWAY: 0.3 });
m = P.modelOutcomeSet({ HOME: { calibrated_probability: 0.5 }, DRAW: { calibrated_probability: 0.2 }, AWAY: { calibrated_probability: 0.3 } }, SEL);
assert.strictEqual(m.stage, 'calibrated');

console.log('probabilities.test.js OK');
