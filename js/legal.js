/* Match Alpha — aviso 18+ / descargo en la primera visita + pie con enlaces legales (Fase H).
 * Acceptance is stored in localStorage (no PII). No inline handlers (CSP-friendly).
 */
(function () {
  'use strict';

  const ACK_KEY = 'ma_legal_ack_v1';

  function footer() {
    if (document.querySelector('.legal-footer')) return;
    const el = document.createElement('footer');
    el.className = 'legal-footer';
    el.innerHTML = `
      <p>Match Alpha publica estimaciones estadísticas. <strong>No es asesoría financiera</strong> ni invita a apostar. Solo +18.</p>
      <nav aria-label="Legal">
        <a href="legal/terms.html">Términos</a>
        <a href="legal/responsible.html">Juego responsable</a>
        <button type="button" class="legal-footer-link" data-view-link="picks-history">Historial</button>
        <button type="button" class="legal-footer-link" data-view-link="alerts">Alertas</button>
      </nav>`;
    (document.querySelector('main.shell') || document.body).appendChild(el);
    el.querySelectorAll('[data-view-link]').forEach((b) => b.addEventListener('click', () => {
      const target = document.querySelector(`.more-item[data-view="${CSS.escape(b.dataset.viewLink)}"]`);
      if (target) target.click();
    }));
  }

  function modal() {
    if (localStorage.getItem(ACK_KEY)) return;
    const wrap = document.createElement('div');
    wrap.className = 'legal-modal-backdrop';
    wrap.innerHTML = `
      <div class="legal-modal" role="dialog" aria-modal="true" aria-labelledby="legal-modal-title">
        <h2 id="legal-modal-title">Antes de continuar</h2>
        <ul>
          <li>Este sitio es <strong>solo para mayores de 18 años</strong> (o la edad legal de tu país).</li>
          <li>Los picks y probabilidades son <strong>estimaciones estadísticas</strong> y pueden fallar. <strong>No es asesoría financiera</strong>.</li>
          <li>Si apuestas, hazlo con responsabilidad y solo en operadores autorizados en tu país.</li>
        </ul>
        <p><a href="legal/terms.html">Términos</a> · <a href="legal/responsible.html">Juego responsable y ayuda</a></p>
        <div class="legal-modal-actions">
          <button type="button" class="ph-btn" id="legal-accept">Tengo 18+ y acepto</button>
          <a class="ph-btn ph-btn--ghost" href="legal/responsible.html">Salir</a>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const accept = wrap.querySelector('#legal-accept');
    accept.addEventListener('click', () => {
      localStorage.setItem(ACK_KEY, new Date().toISOString().slice(0, 10));
      wrap.remove();
    });
    accept.focus();
  }

  function init() { footer(); modal(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
