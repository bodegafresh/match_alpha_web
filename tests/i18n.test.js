// Run: node tests/i18n.test.js  (no dependencies)
const assert = require('assert');
const I = require('../js/i18n.js');
global.window = {};
require('../js/i18n-dict.js');
const DICT = global.window.MA_I18N_DICT;

// language from time zone: Brazil → pt, Spanish-speaking → es, others → en
assert.strictEqual(I.langFromTimeZone('America/Sao_Paulo'), 'pt');
assert.strictEqual(I.langFromTimeZone('America/Manaus'), 'pt');
assert.strictEqual(I.langFromTimeZone('Europe/Lisbon'), 'pt');
for (const z of ['America/Santiago', 'America/Bogota', 'America/Argentina/Buenos_Aires', 'America/Mexico_City', 'Europe/Madrid', 'America/Lima']) {
  assert.strictEqual(I.langFromTimeZone(z), 'es', z);
}
for (const z of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney']) assert.strictEqual(I.langFromTimeZone(z), 'en', z);
assert.strictEqual(I.langFromTimeZone(''), 'es'); // unknown → Spanish default

// precedence: ?lang= > stored choice > time zone
assert.strictEqual(I.detectLang({ query: 'pt', stored: 'en', timeZone: 'America/Santiago' }), 'pt');
assert.strictEqual(I.detectLang({ query: 'xx', stored: 'en', timeZone: 'America/Santiago' }), 'en');
assert.strictEqual(I.detectLang({ timeZone: 'America/Sao_Paulo' }), 'pt');
assert.strictEqual(I.normalizeLang('pt-BR'), 'pt');

// exact and pattern translation, whitespace kept, unknown → null
const en = I.compile(DICT.en);
const pt = I.compile(DICT.pt);
assert.strictEqual(I.translateText('Partidos', en), 'Matches');
assert.strictEqual(I.translateText('  Partidos\n', pt), '  Jogos\n');
assert.strictEqual(I.translateText('Fecha 12', en), 'Matchday 12');
assert.strictEqual(I.translateText('647 decisiones con resultado', pt), '647 decisões com resultado');
assert.strictEqual(I.translateText('Página 2 de 9', en), 'Page 2 of 9');
assert.strictEqual(I.translateText('Universidad de Chile', en), null);
assert.strictEqual(I.translateText('Fase de grupos', en), 'Group stage');

// dictionaries: same keys in en and pt, placeholders preserved
assert.deepStrictEqual(Object.keys(DICT.en).sort(), Object.keys(DICT.pt).sort());
for (const [k, v] of Object.entries(DICT.en)) {
  const ph = (s) => (s.match(/\{\d\}/g) || []).sort().join();
  assert.strictEqual(ph(v), ph(k), `en placeholders: ${k}`);
  assert.strictEqual(ph(DICT.pt[k]), ph(k), `pt placeholders: ${k}`);
}

// generic separator pattern translates each side; untranslatable sides stay as they are
assert.strictEqual(I.translateText('Más/Menos · Más de 2.5', en), 'Over/Under · Over 2.5');
assert.strictEqual(I.translateText('Equipos · actualizado 09:52', pt), 'Times · atualizado 09:52');
assert.strictEqual(I.translateText('Más', en), 'More');
assert.strictEqual(I.isTranslated('Matches', en), true);
console.log('i18n.test.js OK');
