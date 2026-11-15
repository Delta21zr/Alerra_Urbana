# AlertaUrbana

App móvil híbrida (Capacitor 8 + HTML/Tailwind/JS modular) de reporte ciudadano georreferenciado: GPS real, detección de duplicados por proximidad, captura de foto/video y cola de sincronización offline.

## Desarrollo

```bash
npm install
npm run serve          # web en http://localhost:3000
npm run sync           # copia www/ a Android
npm run open:android   # abre Android Studio
```

## Estructura

- `www/js/geolocation.js`: permisos, GPS, errores y cálculo geodésico
- `www/js/proximity-engine.js`: distancia, rumbo y antiduplicados
- `www/js/media-capture.js`: foto y video con sello GPS
- `www/js/sync-manager.js`: persistencia local y cola offline/online
- `www/js/app.js`: controlador de la interfaz
