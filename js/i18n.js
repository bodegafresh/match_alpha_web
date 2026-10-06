/* Interface language: Spanish (source), English, Portuguese.
 *
 * Language: ?lang= → user's choice (localStorage) → time zone (Brazil → pt, Spanish-speaking zones → es,
 * other zones → en) → es. The UI is written in Spanish; after each render the visible text (text nodes plus
 * title / aria-label / placeholder / alt) is translated through the dictionaries in js/i18n-dict.js:
 *   * exact entries: 'Partidos' → 'Matches'
 *   * entries with {0}, {1}… placeholders become patterns: 'Fecha {0}' matches 'Fecha 12' → 'Matchday 12'
 * Texts arriving in Spanish from the API (stage names such as 'Fase de grupos') go through the same path.
 * Unknown texts stay in Spanish and are recorded in MA_I18N.missing (debug: ?i18n_debug=1 logs them).
 * Elements with data-no-i18n (team / player names) are never translated. Pure helpers are exported for tests.
 */
(function (root) {
  const LANGS = ['es', 'en', 'pt'];
  const LOCALES = { es: 'es-CL', en: 'en-US', pt: 'pt-BR' };
  const STORAGE = 'ma_lang';

  const BRAZIL_ZONES = /^America\/(Sao_Paulo|Rio_Branco|Manaus|Cuiaba|Campo_Grande|Belem|Fortaleza|Recife|Maceio|Bahia|Araguaina|Santarem|Porto_Velho|Boa_Vista|Noronha|Eirunepe)$/;
  const PORTUGUESE_ZONES = /^(Europe\/Lisbon|Atlantic\/(Madeira|Azores)|Africa\/(Luanda|Maputo))$/;
  const SPANISH_ZONES = /^(America\/(Santiago|Punta_Arenas|Argentina\/.+|Buenos_Aires|Montevideo|Asuncion|La_Paz|Lima|Bogota|Guayaquil|Caracas|Panama|Costa_Rica|Managua|Tegucigalpa|El_Salvador|Guatemala|Mexico_City|Monterrey|Merida|Cancun|Chihuahua|Ciudad_Juarez|Hermosillo|Mazatlan|Tijuana|Bahia_Banderas|Matamoros|Ojinaga|Santo_Domingo|Havana|Puerto_Rico)|Europe\/Madrid|Atlantic\/Canary|Africa\/(Ceuta|Malabo)|Pacific\/(Easter|Galapagos))$/;

  /** Language for a time zone: Brazil / Portugal → pt, Spanish-speaking → es, any other known zone → en. */
  function langFromTimeZone(zone) {
    const z = String(zone || '');
    if (!z) return 'es';
    if (BRAZIL_ZONES.test(z) || PORTUGUESE_ZONES.test(z)) return 'pt';
    if (SPANISH_ZONES.test(z)) return 'es';
    return 'en';
  }

  function normalizeLang(value) {
    const base = String(value || '').toLowerCase().split(/[-_]/)[0];
    return LANGS.includes(base) ? base : null;
  }

  function detectLang({ query, stored, timeZone } = {}) {
    return normalizeLang(query) || normalizeLang(stored) || langFromTimeZone(timeZone);
  }

  // ── dictionary compilation ────────────────────────────────────────────────
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** {es: translation} → {exact: Map, patterns: [{re, out}]} ('{0}' placeholders become capture groups). */
  const squash = (v) => String(v).replace(/\s+/g, ' ').trim();

  function compile(dict) {
    const exact = new Map();
    const patterns = [];
    const outputs = new Set();
    Object.entries(dict || {}).forEach(([rawKey, out]) => {
      const key = squash(rawKey);
      outputs.add(squash(out));
      if (!/\{\d\}/.test(key)) { exact.set(key, out); return; }
      const order = [];
      const re = new RegExp(`^${escapeRe(key).replace(/\\\{(\d)\\\}/g, (_, d) => { order.push(Number(d)); return '(.+?)'; })}$`);
      patterns.push({ re, order, out });
    });
    return { exact, patterns, outputs };
  }

  /** Translate one string (trimmed match, original surrounding whitespace kept); null when unknown. */
  function translateText(text, compiled, depth = 0) {
    const raw = String(text);
    const trimmed = raw.trim();
    if (!trimmed || !compiled) return null;
    const lead = raw.slice(0, raw.indexOf(trimmed));
    const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length);
    const core = squash(trimmed); // HTML templates break long texts over several indented lines
    if (compiled.exact.has(core)) return lead + compiled.exact.get(core) + tail;
    for (const p of compiled.patterns) {
      const m = core.match(p.re);
      if (!m) continue;
      const values = {};
      // variable parts may be translatable themselves ('Equipos · actualizado 09:52' → 'Teams · updated 09:52')
      p.order.forEach((idx, i) => { values[idx] = depth < 1 ? (translateText(m[i + 1], compiled, depth + 1) ?? m[i + 1]) : m[i + 1]; });
      return lead + p.out.replace(/\{(\d)\}/g, (_, d) => (values[d] !== undefined ? values[d] : '')) + tail;
    }
    return null;
  }

  /** True when the text is already in the target language (one of the dictionary outputs). */
  function isTranslated(text, compiled) {
    return Boolean(compiled && compiled.outputs.has(squash(text)));
  }

  // Worth translating: has letters and is not a number / score / code / team-style proper noun only.
  const LOOKS_TEXT = /[a-záéíóúñ]{2,}/i;

  const api = { LANGS, LOCALES, langFromTimeZone, normalizeLang, detectLang, compile, translateText, isTranslated };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ── browser runtime ───────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  let stored = null;
  try { stored = localStorage.getItem(STORAGE); } catch { /* private mode */ }
  const zone = params.get('tz') || (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  const lang = detectLang({ query: params.get('lang'), stored, timeZone: zone });
  if (params.get('lang') && normalizeLang(params.get('lang'))) {
    try { localStorage.setItem(STORAGE, normalizeLang(params.get('lang'))); } catch { /* ignore */ }
  }
  const compiled = lang === 'es' ? null : compile((root.MA_I18N_DICT || {})[lang]);
  const missing = new Set();
  const debug = params.get('i18n_debug') === '1';
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

  function t(text) {
    if (!compiled) return text;
    return translateText(text, compiled) ?? text;
  }

  function skip(el) {
    return !el || el.closest?.('[data-no-i18n], script, style, code, pre, textarea');
  }

  function translateNode(node) {
    if (!compiled) return;
    if (node.nodeType === 3) {
      if (skip(node.parentElement) || !LOOKS_TEXT.test(node.nodeValue)) return;
      const out = translateText(node.nodeValue, compiled);
      if (out === null) { if (!isTranslated(node.nodeValue, compiled)) missing.add(node.nodeValue.trim()); }
      else if (out !== node.nodeValue) node.nodeValue = out;
      return;
    }
    if (node.nodeType !== 1 || skip(node)) return;
    ATTRS.forEach((a) => {
      const v = node.getAttribute(a);
      if (v && LOOKS_TEXT.test(v)) {
        const out = translateText(v, compiled);
        if (out !== null && out !== v) node.setAttribute(a, out);
      }
    });
    node.childNodes.forEach(translateNode);
  }

  function setLang(next) {
    const l = normalizeLang(next);
    if (!l) return;
    try { localStorage.setItem(STORAGE, l); } catch { /* ignore */ }
    const url = new URL(location.href);
    url.searchParams.delete('lang');
    location.replace(url.toString());
  }

  document.documentElement.lang = lang;
  if (compiled) {
    const start = () => {
      translateNode(document.body);
      new MutationObserver((records) => {
        records.forEach((r) => {
          if (r.type === 'characterData') translateNode(r.target);
          else if (r.type === 'attributes') translateNode(r.target);
          else r.addedNodes.forEach(translateNode);
        });
      }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
      if (debug) root.setInterval(() => console.info('[i18n missing]', [...missing]), 5000);
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }

  root.MA_I18N = { ...api, lang, locale: LOCALES[lang], t, setLang, missing };
}(typeof window !== 'undefined' ? window : globalThis));
