// Run: node tests/csv.test.js  (no dependencies)
const assert = require('assert');
const { csvCell, toCsv } = require('../js/csv.js');

assert.strictEqual(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
assert.strictEqual(csvCell('+cmd'), "'+cmd");
assert.strictEqual(csvCell('-2+3'), "'-2+3");
assert.strictEqual(csvCell('@SUM(A1)'), "'@SUM(A1)");
assert.strictEqual(csvCell('\t=1'), "'\t=1");
assert.strictEqual(csvCell('Colo-Colo'), 'Colo-Colo');          // dash not at start → untouched
assert.strictEqual(csvCell('a,b'), '"a,b"');
assert.strictEqual(csvCell('line\nbreak'), '"line\nbreak"');
assert.strictEqual(csvCell(-1), '-1');                           // numbers stay numeric
assert.strictEqual(csvCell(0.0512), '0.0512');
assert.strictEqual(csvCell(NaN), '');
assert.strictEqual(csvCell(null), '');
assert.strictEqual(csvCell(undefined), '');
const csv = toCsv([{ key: 'a', label: 'A' }, { label: 'B', value: (r) => r.b * 2 }], [{ a: '=1', b: 2 }]);
assert.strictEqual(csv, "﻿A,B\r\n'=1,4\r\n");
console.log('csv.test.js OK');
