/**
 * geolocation.js
 * Módulo de Geolocalización híbrido (Capacitor 8 @capacitor/geolocation + Web API fallback).
 * Gestiona permisos en tiempo de ejecución, obtención de coordenadas reales,
 * seguimiento continuo (watchPosition), cálculo geodésico (Haversine y rumbo)
 * y clasificación detallada de errores de GPS/permisos.
 */

export class GeolocationService {
  constructor() {
    this.currentPosition = null;
    this.permissionState = 'prompt'; // 'granted' | 'prompt' | 'denied' | 'denied_permanently' | 'unsupported'
    this.gpsStatus = 'idle'; // 'idle' | 'locating' | 'active' | 'watching' | 'error'
    this.watchId = null;
    this.lastError = null;
    this.denialCount = 0;
  }

  /**
   * Detecta si se ejecuta dentro del contenedor nativo de Capacitor con el plugin Geolocation disponible.
   */
  isNativePluginAvailable() {
    return Boolean(
      window.Capacitor &&
      window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform() &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.Geolocation
    );
  }

  /**
   * Consulta el estado actual del permiso de ubicación sin disparar el diálogo del sistema.
   */
  async checkPermissions() {
    try {
      if (this.isNativePluginAvailable()) {
        const status = await window.Capacitor.Plugins.Geolocation.checkPermissions();
        const locState = status.location || status.coarseLocation || 'prompt';
        // Android sigue reportando "denied" aunque el bloqueo sea permanente: no degradar ese estado.
        if (!(this.permissionState === 'denied_permanently' && locState === 'denied')) {
          this.permissionState = locState;
        }
        return {
          location: status.location || locState,
          coarseLocation: status.coarseLocation || locState,
          source: 'capacitor-native'
        };
      }

      // Fallback Web
      if (!('geolocation' in navigator)) {
        this.permissionState = 'unsupported';
        return { location: 'unsupported', coarseLocation: 'unsupported', source: 'web' };
      }

      if (navigator.permissions && navigator.permissions.query) {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        this.permissionState = result.state;
        result.onchange = () => {
          this.permissionState = result.state;
        };
        return { location: result.state, coarseLocation: result.state, source: 'web-permissions-api' };
      }

      return { location: this.permissionState, coarseLocation: this.permissionState, source: 'web-fallback' };
    } catch (err) {
      console.warn('[GeolocationService] Error al verificar permisos:', err);
      return { location: this.permissionState, coarseLocation: this.permissionState, source: 'error' };
    }
  }

  /**
   * Solicita explícitamente permisos de ubicación en tiempo de ejecución (Android / Web).
   * Detecta si el permiso fue denegado permanentemente en Android.
   */
  async requestPermissions() {
    try {
      const beforeCheck = await this.checkPermissions();

      if (beforeCheck.location === 'unsupported') {
        const classified = this.classifyError({ code: 'UNSUPPORTED', message: 'Geolocalización no soportada' });
        this.lastError = classified;
        return { granted: false, state: 'unsupported', error: classified };
      }

      if (this.isNativePluginAvailable()) {
        const startTime = Date.now();
        const result = await window.Capacitor.Plugins.Geolocation.requestPermissions({
          permissions: ['location', 'coarseLocation']
        });
        const elapsedMs = Date.now() - startTime;
        const finalState = result.location === 'granted' || result.coarseLocation === 'granted'
          ? 'granted'
          : (result.location || 'denied');

        if (finalState === 'granted') {
          this.permissionState = 'granted';
          this.denialCount = 0;
          this.lastError = null;
          return { granted: true, state: 'granted', precise: result.location === 'granted' };
        }

        // classifyError suma el rechazo actual; aquí solo se evalúan rechazos previos.
        // Si ya estaba en denied y la respuesta de Android fue inmediata (<250ms), el sistema bloqueó el diálogo ("No volver a preguntar")
        const isPermanent = (beforeCheck.location === 'denied' && elapsedMs < 250) || this.denialCount >= 1;
        this.permissionState = isPermanent ? 'denied_permanently' : 'denied';
        const classified = this.classifyError({
          code: isPermanent ? 'PERMISSION_DENIED_PERMANENTLY' : 1,
          message: isPermanent
            ? 'Permiso de ubicación bloqueado permanentemente en Android.'
            : 'Permiso de ubicación rechazado por el usuario.'
        });
        this.lastError = classified;
        return { granted: false, state: this.permissionState, error: classified };
      }

      // En navegador web el diálogo de permiso se dispara al invocar getCurrentPosition
      const pos = await this.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
      this.permissionState = 'granted';
      return { granted: true, state: 'granted', precise: true, position: pos };
    } catch (err) {
      const classified = err.errorType ? err : this.classifyError(err);
      this.lastError = classified;
      if (classified.errorType === 'PERMISSION_DENIED' || classified.errorType === 'PERMISSION_DENIED_PERMANENTLY') {
        this.permissionState = classified.errorType === 'PERMISSION_DENIED_PERMANENTLY' ? 'denied_permanently' : 'denied';
      }
      return { granted: false, state: this.permissionState, error: classified };
    }
  }

  /**
   * Obtiene la posición GPS actual del dispositivo.
   * Si falla por timeout en alta precisión y allowFallback=true, reintenta con precisión balanceada.
   */
  async getCurrentPosition(customOptions = {}) {
    this.gpsStatus = 'locating';
    this.lastError = null;

    const options = {
      enableHighAccuracy: customOptions.enableHighAccuracy ?? true,
      timeout: customOptions.timeout ?? 12000,
      maximumAge: customOptions.maximumAge ?? 0
    };

    try {
      // Verificar/solicitar permisos en nativo antes de leer coordenadas
      if (this.isNativePluginAvailable()) {
        const perm = await this.checkPermissions();
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
          const req = await this.requestPermissions();
          if (!req.granted) {
            this.gpsStatus = 'error';
            throw req.error;
          }
        }

        const rawPos = await window.Capacitor.Plugins.Geolocation.getCurrentPosition(options);
        const normalized = this.normalizePosition(rawPos, 'capacitor-gps');
        this.currentPosition = normalized;
        this.permissionState = 'granted';
        this.gpsStatus = this.watchId ? 'watching' : 'active';
        return normalized;
      }

      // Fallback Web
      if (!('geolocation' in navigator)) {
        throw { code: 'UNSUPPORTED', message: 'Este dispositivo o navegador no soporta geolocalización.' };
      }

      const rawPos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, options);
      });

      const normalized = this.normalizePosition(rawPos, 'web-gps');
      this.currentPosition = normalized;
      this.permissionState = 'granted';
      this.gpsStatus = this.watchId ? 'watching' : 'active';
      return normalized;
    } catch (err) {
      // Si fue un timeout con alta precisión y no se deshabilitó el fallback, probar lectura rápida por red/celda
      const isTimeout = err?.code === 3 || /timeout|timed out/i.test(err?.message || '');
      if (isTimeout && options.enableHighAccuracy && customOptions.allowBalancedFallback !== false) {
        try {
          return await this.getCurrentPosition({
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 15000,
            allowBalancedFallback: false
          });
        } catch (fallbackErr) {
          const classified = fallbackErr?.errorType ? fallbackErr : this.classifyError(fallbackErr);
          this.gpsStatus = 'error';
          this.lastError = classified;
          throw classified;
        }
      }

      const classified = err?.errorType ? err : this.classifyError(err);
      this.gpsStatus = 'error';
      this.lastError = classified;
      throw classified;
    }
  }

  /**
   * Inicia el monitoreo continuo de ubicación en tiempo real (watchPosition).
   */
  async startWatch(onPositionCallback, onErrorCallback) {
    await this.stopWatch();

    const options = {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 2000
    };

    try {
      if (this.isNativePluginAvailable()) {
        const perm = await this.checkPermissions();
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
          const req = await this.requestPermissions();
          if (!req.granted) {
            if (onErrorCallback) onErrorCallback(req.error);
            return null;
          }
        }

        this.gpsStatus = 'watching';
        this.watchId = await window.Capacitor.Plugins.Geolocation.watchPosition(options, (position, err) => {
          if (err) {
            const classified = this.classifyError(err);
            this.lastError = classified;
            if (onErrorCallback) onErrorCallback(classified);
            return;
          }
          if (position) {
            const normalized = this.normalizePosition(position, 'capacitor-watch');
            this.currentPosition = normalized;
            this.gpsStatus = 'watching';
            if (onPositionCallback) onPositionCallback(normalized);
          }
        });
        return this.watchId;
      }

      if (!('geolocation' in navigator)) {
        const classified = this.classifyError({ code: 'UNSUPPORTED' });
        if (onErrorCallback) onErrorCallback(classified);
        return null;
      }

      this.gpsStatus = 'watching';
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const normalized = this.normalizePosition(pos, 'web-watch');
          this.currentPosition = normalized;
          this.permissionState = 'granted';
          this.gpsStatus = 'watching';
          if (onPositionCallback) onPositionCallback(normalized);
        },
        (err) => {
          const classified = this.classifyError(err);
          this.lastError = classified;
          if (onErrorCallback) onErrorCallback(classified);
        },
        options
      );
      return this.watchId;
    } catch (err) {
      const classified = this.classifyError(err);
      this.gpsStatus = 'error';
      this.lastError = classified;
      if (onErrorCallback) onErrorCallback(classified);
      return null;
    }
  }

  /**
   * Detiene el monitoreo continuo si está activo.
   */
  async stopWatch() {
    if (this.watchId === null) return;
    try {
      if (this.isNativePluginAvailable()) {
        await window.Capacitor.Plugins.Geolocation.clearWatch({ id: this.watchId });
      } else if ('geolocation' in navigator) {
        navigator.geolocation.clearWatch(this.watchId);
      }
    } catch (err) {
      console.warn('[GeolocationService] Error al detener watchPosition:', err);
    } finally {
      this.watchId = null;
      this.gpsStatus = this.currentPosition ? 'active' : 'idle';
    }
  }

  /**
   * Normaliza el objeto de coordenadas y calcula la calidad de precisión.
   */
  normalizePosition(rawPos, source = 'gps') {
    const coords = rawPos.coords || rawPos;
    const accuracy = typeof coords.accuracy === 'number' ? Math.round(coords.accuracy * 10) / 10 : null;

    let qualityLevel = 'high';
    let qualityLabel = 'Señal GPS Excelente';
    if (accuracy === null) {
      qualityLevel = 'unknown';
      qualityLabel = 'Precisión desconocida';
    } else if (accuracy <= 15) {
      qualityLevel = 'excellent';
      qualityLabel = 'Alta Precisión (Satélite)';
    } else if (accuracy <= 50) {
      qualityLevel = 'good';
      qualityLabel = 'Precisión Buena';
    } else if (accuracy <= 150) {
      qualityLevel = 'moderate';
      qualityLabel = 'Precisión Media (Red/Wi-Fi)';
    } else {
      qualityLevel = 'low';
      qualityLabel = 'Precisión Baja (Acércate a cielo abierto)';
    }

    return {
      latitude: Number(coords.latitude),
      longitude: Number(coords.longitude),
      accuracy,
      altitude: typeof coords.altitude === 'number' ? Math.round(coords.altitude) : null,
      speed: typeof coords.speed === 'number' && coords.speed >= 0 ? Math.round(coords.speed * 3.6 * 10) / 10 : null, // km/h
      heading: typeof coords.heading === 'number' && !Number.isNaN(coords.heading) ? Math.round(coords.heading) : null,
      timestamp: rawPos.timestamp || Date.now(),
      qualityLevel,
      qualityLabel,
      source
    };
  }

  /**
   * Clasifica cualquier error de geolocalización (Capacitor o estándar W3C) en una estructura clara para el usuario.
   */
  classifyError(err) {
    const msg = String(err?.message || err || '');
    const code = err?.code;

    // 1. Falta de soporte
    if (code === 'UNSUPPORTED' || /not supported|no soportad/i.test(msg)) {
      return {
        errorType: 'UNSUPPORTED',
        title: 'Geolocalización no soportada',
        message: 'Este dispositivo o entorno no cuenta con soporte de ubicación GPS.',
        suggestion: 'Ejecuta la aplicación en un dispositivo Android físico o en un navegador con soporte GPS.',
        canRetry: false,
        needsSettings: false,
        rawMessage: msg
      };
    }

    // 2. Permiso denegado permanentemente
    if (
      code === 'PERMISSION_DENIED_PERMANENTLY' ||
      /permanently|bloqueado permanentemente|never ask again/i.test(msg)
    ) {
      this.permissionState = 'denied_permanently';
      return {
        errorType: 'PERMISSION_DENIED_PERMANENTLY',
        title: 'Permiso bloqueado permanentemente',
        message: 'El acceso a la ubicación fue denegado de forma permanente en el sistema.',
        suggestion: 'Abre los Ajustes de la aplicación en Android > Permisos > Ubicación y selecciona "Permitir mientras la app está en uso".',
        canRetry: true,
        needsSettings: true,
        rawMessage: msg
      };
    }

    // 3. GPS / Servicios de ubicación apagados en el sistema Android
    if (
      /location disabled|location services are not enabled|gps disabled|provider|servicios de ubicación/i.test(msg) ||
      code === 2
    ) {
      return {
        errorType: 'LOCATION_DISABLED',
        title: 'GPS o Servicios de Ubicación desactivados',
        message: 'El receptor GPS del dispositivo está apagado o sin cobertura de ubicación.',
        suggestion: 'Activa la "Ubicación / GPS" en la barra de ajustes rápidos de tu teléfono y vuelve a intentar.',
        canRetry: true,
        needsSettings: true,
        rawMessage: msg
      };
    }

    // 4. Permiso denegado normal
    if (code === 1 || /permission denied|user denied|denied|rechazado/i.test(msg)) {
      this.denialCount += 1;
      const isPermanent = this.denialCount >= 2 || this.permissionState === 'denied_permanently';
      this.permissionState = isPermanent ? 'denied_permanently' : 'denied';
      return {
        errorType: isPermanent ? 'PERMISSION_DENIED_PERMANENTLY' : 'PERMISSION_DENIED',
        title: isPermanent ? 'Permiso de ubicación bloqueado' : 'Permiso de ubicación denegado',
        message: isPermanent
          ? 'Has rechazado el permiso de ubicación varias veces. Android ya no mostrará la ventana emergente automáticamente.'
          : 'AlertaUrbana necesita tu ubicación para georreferenciar el reporte ciudadano y verificar si ya fue reportado cerca.',
        suggestion: isPermanent
          ? 'Pulsa en "Cómo habilitar en Ajustes" para otorgar el permiso manualmente desde la configuración de Android.'
          : 'Pulsa en "Solicitar permiso nuevamente" y elige "Mientras la app está en uso".',
        canRetry: true,
        needsSettings: isPermanent,
        rawMessage: msg
      };
    }

    // 5. Timeout al buscar satélites
    if (code === 3 || /timeout|timed out|tiempo de espera/i.test(msg)) {
      return {
        errorType: 'TIMEOUT',
        title: 'Tiempo de espera agotado al buscar señal GPS',
        message: 'El dispositivo tardó demasiado en fijar las coordenadas satelitales.',
        suggestion: 'Si estás bajo techo o dentro de un edificio, acércate a una ventana o al exterior y pulsa Reintentar.',
        canRetry: true,
        needsSettings: false,
        rawMessage: msg
      };
    }

    // 6. Cualquier otro error
    return {
      errorType: 'UNKNOWN',
      title: 'No se pudo obtener la ubicación',
      message: msg || 'Ocurrió un error al consultar el sensor GPS del dispositivo.',
      suggestion: 'Verifica que el GPS esté encendido y que la app tenga permisos de ubicación.',
      canRetry: true,
      needsSettings: true,
      rawMessage: msg
    };
  }

  /**
   * Calcula la distancia exacta en metros entre dos coordenadas usando la fórmula de Haversine.
   */
  static calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Radio medio de la Tierra en metros
    const toRad = (deg) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }

  /**
   * Calcula el rumbo inicial (0-360°) y punto cardinal desde el punto 1 hacia el punto 2.
   */
  static calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const toDeg = (rad) => (rad * 180) / Math.PI;

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    const degrees = (toDeg(Math.atan2(y, x)) + 360) % 360;
    const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const index = Math.round(degrees / 45) % 8;

    return {
      degrees: Math.round(degrees),
      cardinal: cardinals[index]
    };
  }

  /**
   * Formatea una distancia en metros para lectura humana ("24 m" o "1.35 km").
   */
  static formatDistance(meters) {
    if (meters === null || meters === undefined || Number.isNaN(meters)) return '—';
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(2)} km`;
  }

  /**
   * Genera enlace directo a Google Maps con marcador en las coordenadas.
   */
  static getMapsUrl(lat, lon) {
    return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  /**
   * Genera URL de mapa embebido de OpenStreetMap centrado en las coordenadas actuales.
   */
  static getOsmEmbedUrl(lat, lon, delta = 0.003) {
    const minLon = (lon - delta).toFixed(6);
    const minLat = (lat - delta).toFixed(6);
    const maxLon = (lon + delta).toFixed(6);
    const maxLat = (lat + delta).toFixed(6);
    return `https://www.openstreetmap.org/export/embed.html?bbox=${minLon}%2C${minLat}%2C${maxLon}%2C${maxLat}&layer=mapnik&marker=${lat.toFixed(6)}%2C${lon.toFixed(6)}`;
  }
}
