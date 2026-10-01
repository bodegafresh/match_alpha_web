# Auditoría mobile — Fase A (2026-10-01)

Viewports: 375×812 (iPhone SE/mini) y 414×896 (iPhone Plus/Max). Datos: API local (`uvicorn :8765`) contra la base de producción, solo lectura.
Temporadas: `premier-league-2026-2027`, `ucl-2026-2027` (fase liga y llaves de ida y vuelta), `wc2026` (grupos y llaves), `libertadores-2026`, `sudamericana-2026`, `chile-primera-2026`.

Método: script en el navegador que, por vista, mide:

- **Header**: el primer contenido de `#view-root` no queda bajo `.topbar` (`--topbar-h`).
- **H-scroll**: `document.documentElement.scrollWidth == innerWidth`.
- **Touch**: elementos interactivos visibles (`button`, `a`, `[role=tab]`, `select`, `input`, `[tabindex=0]`, `summary`) de al menos 44×44 px.
- **Texto**: nodos de texto visibles de al menos 12 px.
- **Estados**: carga, vacío y error.

Antes = build `20261001c` (commit 2bb1b06). Después = build `20261001h`.

| Vista | Chequeo | Antes | Después |
|---|---|---|---|
| Global (header) | Header | OK | OK (el contenido usa `--topbar-h`; banner offline sticky bajo el header) |
| Global (header) | Touch | ✗ 9 tabs de 32 px, selector de liga de 15 px, refresco de 32 px | ✓ los tabs superiores se ocultan en ≤680 px y se reemplazan por una barra inferior de 52 px; selector de liga de 44 px; refresco de 44×44 |
| Global (header) | Texto | ✗ brand-mark 11.5, liga 10.6, chevron 8.8, tabs 11.8, status 11.2 | ✓ todo ≥ 12 px |
| Partidos | H-scroll | OK | OK |
| Partidos | Touch | ✗ chips de fecha (Ayer/Hoy/…) | ✓ 44 px |
| Partidos | Texto | ✗ match-meta 9.6, venue 10.2, weather 9.9, kickoff-meta 11.5, nombres 11.5 | ✓ |
| Partidos | Estados | carga (skeleton), vacío y error OK | Igual. El error de red se muestra como "Sin conexión con el servidor…". Botón Reintentar de 44 px |
| Partidos | Nuevo | — | Tocar una tarjeta abre el detalle del partido |
| Posiciones | H-scroll | OK; la tabla scrolleaba dentro de la tarjeta (min-width 640 px) | ✓ sin scroll interno: columnas #, Equipo, PJ, DG, PTS |
| Posiciones | Touch | — (las filas no eran interactivas) | ✓ filas expandibles de 46 px (teclado: Enter/Espacio, `aria-expanded`) |
| Posiciones | Texto | ✗ th 10.9, leyenda 11.5 | ✓ |
| Posiciones | Zonas | barra lateral + leyenda | Se mantienen la barra lateral y la leyenda |
| Equipos | Touch | ✗ input y 5 selects de filtros < 44 px | ✓ 44 px |
| Equipos | Texto | ✗ points-pill, team-rating, stat 10.6–11.5, chip 10.9 | ✓ |
| Ficha de equipo | Pestañas | ✗ sin `aria-selected`; el estado activo apenas se distinguía | ✓ `role=tab` + `aria-selected` + estilo activo (borde, color y subrayado) |
| Ficha de equipo | Resultados | ✗ G/E/P mostraba "-" | ✓ se calcula desde el marcador y el lado del equipo (también define por penales con `winner_team_id`) |
| Ficha de equipo | Stats | ✗ no se podía ordenar; th 10.9 | ✓ encabezados ordenables (`aria-sort`, 44×44); filas de 44 px |
| Ficha de equipo | Jugador | — | ✓ tarjeta de jugador con foto (`safeUrl`, lazy), posición, edad, partidos, minutos, goles, asistencias, rating y tarjetas |
| Ficha de equipo | Layout | modal centrado | hoja inferior de 92vh con safe-area; Escape cierra; el foco vuelve al origen |
| Torneo: grupos | Todos | ✗ th 10.9, leyenda 11.5, subtabs 11.5 | ✓ |
| Torneo: fase liga (UCL) | Todos | ✗ igual que Posiciones | ✓ |
| Torneo: llaves / ida y vuelta | Touch | ✗ flechas de navegación de 38 px | ✓ 44×44; las tarjetas y las filas de ida/vuelta abren el detalle (44 px) |
| Torneo: llaves / ida y vuelta | Texto | ✗ stage-count 11.2, "N llaves" 11.2, venue 11.8, tie-leg-label 10.6 | ✓ |
| Noticias | Todos | ✓ (salvo el header global) | ✓ |
| EV+ | Texto | ✗ metric-card label 9.6, section title 11.2, empty text 11.8 | ✓ |
| Modelo | Texto | ✗ chip 9.9, tl-label 9.6, cal-progress-note 10.9, feature-health-sub 10.6, p inline 11.5 | ✓ |
| Stats | Texto | ✗ metric label 9.6, chip 10.9, inline 11.2–11.8 | ✓ |
| Stats | Perf | Chart.js (~200 KB) se cargaba en todas las vistas | ✓ carga diferida al abrir Stats (`loadChartJs`) |
| ELO | Todos | ✓ (salvo el header global) | ✓ |
| Detalle de partido (nuevo) | Todos (5 pestañas) | — | ✓ sin scroll horizontal, touch ≥ 44 y texto ≥ 12 px (corregido: nombres de equipo en 11.5) |
| Hoja "Más" / selector de liga | Touch | ✗ ítems de 36 px; dropdown anclado | ✓ hojas inferiores con ítems de 52 px, búsqueda y favoritos (botón de 44 px) |

Resultado final a 375 y 414 px: en todas las vistas, `scrollWidth == innerWidth`, nada queda bajo el header, 0 objetivos táctiles bajo 44 px y 0 textos bajo 12 px.

## Pendiente / fuera de alcance

- Lighthouse mobile ≥ 90 no se midió en CI (no hay pipeline). Queda como tarea de Fase A.8.
- Los emoji de banderas de subdivisión (🏴 ENG/SCO/WAL) se ven partidos en Chromium sin soporte de esas secuencias. Pasa desde antes: el backend debería enviar `flag_asset` para esas asociaciones.
- Las estadísticas de jugadores salen en 0 en Premier y Sudamericana porque `player_match_stats` está vacío para esas temporadas (problema de datos; en WC2026 sí hay).
- Paginación de payloads (A.7) y versión automática de assets desde `git rev-parse`: diferidos. El `?v=` se sigue subiendo a mano.
