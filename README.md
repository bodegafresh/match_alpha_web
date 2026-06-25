# Match Alpha Web

Frontend estatico para GitHub Pages que consume la API estable del proyecto Pool Team 2026.

## Configuracion

Editar `js/config.js`:

```js
window.MATCH_ALPHA_CONFIG = {
  API_BASE_URL: 'https://matchalpha.bodegafresh.workers.dev/api/v1',
  DEFAULT_SEASON: 'wc2026',
  KEY_STORAGE: 'match_alpha_web_key'
};
```

El frontend usa `Authorization: Bearer <WEB_KEY>` contra el Worker. La clave se guarda solo en `localStorage` del navegador.

## Endpoints usados

- `GET /api/v1/web/matches`
- `GET /api/v1/web/standings`
- `GET /api/v1/web/teams`
- `GET /api/v1/web/knockout`

## Publicacion

Este proyecto no requiere build. Se puede publicar directo con GitHub Pages desde la rama configurada.
