/* Team identity rendering (crest + country), shared by every view (match cards, standings, brackets, team
 * cards, modals). Pure functions, no DOM access, so they run under `node tests/team-identity.test.js`.
 *
 * Input: a team object from the API. The backend (app/teams/identity.py) attaches `identity`:
 *   { team_type, crest_url, country: {code, name, flag}, association: {code, name, flag}, flag, nation_name }
 * plus a flat `crest_url`. The competition scope comes from the layout (metadata.team_scope):
 *   DOMESTIC | INTERNATIONAL_CLUB | INTERNATIONAL_NATIONAL_TEAM | null. Nothing is inferred from names.
 *
 * Rules:
 *   national team  → flag (+ small crest when available)                    🇨🇱 [crest]
 *   club, domestic → crest only (the competition already says the country)    [crest]
 *   club, international club competition → crest + small flag badge, and `nation(...)` adds "🇦🇷 Argentina"
 *   no crest       → national: flag; club: initials badge. A crest that fails to load is swapped for the
 *                    initials by the error handler in app.js (data-initials).
 */
(function (root) {
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function deco(icon) {
    return `<span aria-hidden="true">${esc(icon)}</span>`;
  }

  // ISO alpha-2 → regional-indicator flag; anything else → ''.
  function flagFromCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '';
    return String.fromCodePoint(...[...c].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
  }

  // Only absolute https URLs (the backend already restricts crests to the providers' CDNs).
  function httpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function identityOf(team) {
    return (team && typeof team.identity === 'object' && team.identity) || {};
  }

  function isNational(team, scope) {
    const type = identityOf(team).team_type;
    if (type) return type === 'NATIONAL_TEAM';
    return scope === 'INTERNATIONAL_NATIONAL_TEAM';
  }

  function crestUrl(team) {
    return httpsUrl(team?.crest_url || identityOf(team).crest_url);
  }

  // "Colo Colo" → CC, "Universidad de Chile" → UC, "A. Italiano" → AI, "Lanús" → LA.
  const CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'and', 'of', 'the', 'da', 'do', 'dos']);
  function initials(team) {
    const name = String(team?.display_name || team?.team_name || '').trim();
    const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !CONNECTORS.has(w.toLowerCase()));
    const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]).join('') : (words[0] || '').slice(0, 2);
    return letters.toUpperCase() || '?';
  }

  function flag(team) {
    if (team?.flag_asset) {
      const src = httpsUrl(team.flag_asset) || (/^http:\/\//i.test(String(team.flag_asset)) ? String(team.flag_asset) : '');
      if (src) return `<img class="flag-img" src="${esc(src)}" alt="" loading="lazy">`;
    }
    const fromIdentity = identityOf(team).flag;
    if (fromIdentity) return deco(fromIdentity);
    if (team?.flag_emoji) return deco(team.flag_emoji);
    const fromCode = flagFromCode(team?.flag_code || team?.country_code);
    if (fromCode) return deco(fromCode);
    return team?.is_placeholder
      ? '<span class="placeholder-icon" aria-hidden="true">◇</span>'
      : '<span class="placeholder-icon flag-neutral" aria-hidden="true">⚽</span>';
  }

  function crestImg(team, extraClass) {
    const url = crestUrl(team);
    if (!url) return '';
    return `<img class="team-crest${extraClass ? ` ${extraClass}` : ''}" src="${esc(url)}" alt="" loading="lazy" decoding="async" data-initials="${esc(initials(team))}">`;
  }

  function mark(team, scope) {
    if (!team || team.is_placeholder || !(team.team_id || team.display_name || team.team_name)) return flag(team);
    if (isNational(team, scope)) {
      const crest = crestImg(team, 'team-crest--small');
      return crest ? `<span class="team-mark team-mark--national">${flag(team)}${crest}</span>` : flag(team);
    }
    const identity = identityOf(team);
    const img = crestImg(team) || `<span class="team-crest team-crest--fallback" aria-hidden="true">${esc(initials(team))}</span>`;
    const badge = scope === 'INTERNATIONAL_CLUB' && identity.flag
      ? `<span class="team-mark__flag" aria-hidden="true">${esc(identity.flag)}</span>` : '';
    const title = badge && identity.nation_name ? ` title="${esc(identity.nation_name)}"` : '';
    return `<span class="team-mark"${title}>${img}${badge}</span>`;
  }

  function nation(team, scope) {
    if (scope !== 'INTERNATIONAL_CLUB' || isNational(team, scope)) return '';
    const identity = identityOf(team);
    if (!identity.nation_name) return '';
    return `<small class="team-nation">${identity.flag ? `${deco(identity.flag)} ` : ''}${esc(identity.nation_name)}</small>`;
  }

  const api = { mark, nation, flag, crestUrl, initials, isNational, flagFromCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MA_TEAM = api;
}(typeof window !== 'undefined' ? window : globalThis));
