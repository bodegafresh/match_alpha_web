# Match Alpha — Web

SPA estática (HTML + JavaScript sin frameworks ni build) que consume la API de Match Alpha
(repo `match_alpha`). Es una PWA con service worker, se publica en GitHub Pages y se adapta a móvil y escritorio.

## Configuración (`js/config.js`)

```js
window.MATCH_ALPHA_CONFIG = {
  API_BASE_URL: 'https://match-alpha.onrender.com/api/v1',
  DEFAULT_SEASON: 'wc2026',      // competición inicial; el usuario la cambia desde el selector
  KEY_STORAGE: 'poolteam2026',   // nombre en localStorage de la clave de lectura
  AUTO_REFRESH_MS: 30000
};
```

La API se llama con `X-API-Key: <clave de lectura>`, guardada solo en `localStorage`. Aún no hay cuentas de usuario.

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html` | Shell, navegación (pestañas de escritorio, barra inferior y menú "Más" en móvil) |
| `js/app.js` | Router y vistas: Partidos, Tablas, Equipos, Torneo (llaves y clasificación), ELO, Noticias, Picks (EV+), Modelo, Stats |
| `js/picks.js` | Historial de picks con ROI/CLV y exportación CSV (`csv.js`) |
| `js/push.js` | Alertas web push y favoritos |
| `js/stats-insights.js` | Lógica pura de Stats: estados de muestra, universos de cada métrica |
| `js/probabilities.js` | Redondeo de probabilidades (cada conjunto 1X2 suma 100%) |
| `js/team-identity.js` | Escudos, banderas y nombres de equipos |
| `js/legal.js`, `legal/` | Aviso +18, términos y juego responsable |
| `sw.js` | Caché offline y stale-while-revalidate de la API |

La vista admin (identidad y operación) aparece solo con `?admin=1` y requiere la clave interna.

## Tests y publicación

```bash
for t in tests/*.test.js; do node "$t"; done
```

No hay build. Al cambiar JS o CSS, sube la versión `?v=` en `index.html` y `sw.js` para invalidar la caché.
Se publica directamente desde la rama `main` en GitHub Pages.
