// Run: node tests/team-identity.test.js  (no dependencies)
const assert = require('assert');
const T = require('../js/team-identity.js');

const CL = { code: 'CL', name: 'Chile', flag: '🇨🇱' };
const club = (over = {}) => ({
  team_id: 't1', display_name: 'Colo Colo', crest_url: 'https://media.api-sports.io/football/teams/2323.png',
  identity: { team_type: 'CLUB', crest_url: 'https://media.api-sports.io/football/teams/2323.png', country: CL,
              association: { code: 'CHI', name: 'Chile', flag: '🇨🇱' }, flag: '🇨🇱', nation_name: 'Chile' },
  ...over,
});
const national = {
  team_id: 'n1', display_name: 'Chile', flag_emoji: '🇨🇱',
  identity: { team_type: 'NATIONAL_TEAM', crest_url: 'https://media.api-sports.io/football/teams/2383.png',
              country: CL, flag: '🇨🇱', nation_name: 'Chile' },
};

// club with crest + country, domestic: crest only, no flag badge, no nation line
let html = T.mark(club(), 'DOMESTIC');
assert.ok(html.includes('class="team-crest"') && html.includes('teams/2323.png'), html);
assert.ok(!html.includes('team-mark__flag'), 'no flag badge in domestic competitions');
assert.strictEqual(T.nation(club(), 'DOMESTIC'), '');

// international club competition: crest + flag badge + "🇨🇱 Chile" line
html = T.mark(club(), 'INTERNATIONAL_CLUB');
assert.ok(html.includes('team-mark__flag') && html.includes('title="Chile"'), html);
assert.ok(T.nation(club(), 'INTERNATIONAL_CLUB').includes('Chile'));

// club without crest → initials fallback (never a broken <img>)
const noCrest = club({ crest_url: null, identity: { ...club().identity, crest_url: null } });
html = T.mark(noCrest, 'DOMESTIC');
assert.ok(html.includes('team-crest--fallback') && html.includes('>CC<'), html);
assert.ok(!html.includes('<img'), html);

// club without country → no nation line, no badge, still a crest
const noCountry = club({ identity: { team_type: 'CLUB', crest_url: club().crest_url, country: null, flag: null, nation_name: null } });
assert.strictEqual(T.nation(noCountry, 'INTERNATIONAL_CLUB'), '');
assert.ok(!T.mark(noCountry, 'INTERNATIONAL_CLUB').includes('team-mark__flag'));

// national team: flag first + small crest, no redundant nation line
html = T.mark(national, 'INTERNATIONAL_NATIONAL_TEAM');
assert.ok(html.indexOf('🇨🇱') < html.indexOf('<img'), html);
assert.ok(html.includes('team-crest--small'), html);
assert.strictEqual(T.nation(national, 'INTERNATIONAL_NATIONAL_TEAM'), '');
// national team without crest → just the flag
assert.ok(!T.mark({ ...national, identity: { ...national.identity, crest_url: null } }, null).includes('<img'));

// invalid / dangerous crest URLs are never rendered
for (const bad of ['javascript:alert(1)', 'http://media.api-sports.io/x.png', 'data:image/png;base64,AAA', '"><script>', '']) {
  const t = club({ crest_url: bad, identity: { ...club().identity, crest_url: bad } });
  assert.ok(!T.mark(t, 'DOMESTIC').includes('<img'), `rendered ${bad}`);
}
// names are escaped (initials + title)
html = T.mark(club({ display_name: '<b>x</b> "y"', crest_url: null, identity: { team_type: 'CLUB', nation_name: '<i>', flag: '🇨🇱' } }), 'INTERNATIONAL_CLUB');
assert.ok(!html.includes('<b>') && !html.includes('<i>'), html);

// backward compatibility: old payloads (no identity) keep the previous flag behaviour
assert.ok(T.flag({ flag_emoji: '🏴' }).includes('🏴'));
assert.ok(T.flag({ country_code: 'AR' }).includes('🇦🇷'));
assert.ok(T.flag({ is_placeholder: true }).includes('◇'));
assert.ok(T.mark({ display_name: 'Por definir', is_placeholder: true }, 'DOMESTIC').includes('◇'));
// team_type unknown → scope decides
assert.strictEqual(T.isNational({ display_name: 'Chile' }, 'INTERNATIONAL_NATIONAL_TEAM'), true);
assert.strictEqual(T.isNational({ display_name: 'Colo Colo' }, 'DOMESTIC'), false);
assert.strictEqual(T.initials({ display_name: 'Universidad de Chile' }), 'UC');
assert.strictEqual(T.initials({ display_name: 'A. Italiano' }), 'AI');
assert.strictEqual(T.initials({ display_name: '' }), '?');
assert.strictEqual(T.initials({ display_name: 'Lanús' }), 'LA');

console.log('team-identity.test.js OK');
