/**
 * media-capture.js
 * Módulo de captura de evidencia multimedia (Foto y Video) para Reportes Ciudadanos.
 * Integra @capacitor/camera en Android nativo y captura de video/foto en Web/Android,
 * incluyendo gestión de permisos en tiempo de ejecución, compresión de imagen y estampado GPS.
 */

export class MediaCaptureService {
  constructor() {
    this.cameraPermission = 'prompt'; // 'granted' | 'prompt' | 'denied'
    this.currentMedia = null; // { type: 'photo'|'video', dataUrl, mimeType, sizeKb, capturedAt, gpsSnapshot }
    this.lastError = null;
  }

  /**
   * Verifica si el plugin nativo @capacitor/camera está disponible.
   */
  isNativeCameraAvailable() {
    return Boolean(
      window.Capacitor &&
      window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform() &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.Camera
    );
  }

  /**
   * Consulta el estado actual de los permisos de cámara y galería.
   */
  async checkPermissions() {
    try {
      if (this.isNativeCameraAvailable()) {
        const res = await window.Capacitor.Plugins.Camera.checkPermissions();
        this.cameraPermission = res.camera || 'prompt';
        return {
          camera: res.camera || 'prompt',
          photos: res.photos || 'prompt',
          source: 'capacitor-native'
        };
      }

      if (navigator.permissions && navigator.permissions.query) {
        try {
          const camPerm = await navigator.permissions.query({ name: 'camera' });
          this.cameraPermission = camPerm.state;
          return { camera: camPerm.state, photos: 'granted', source: 'web-permissions-api' };
        } catch (_) {
          // Algunos navegadores no exponen 'camera' en permissions.query
        }
      }

      return { camera: this.cameraPermission, photos: 'granted', source: 'web-fallback' };
    } catch (err) {
      console.warn('[MediaCaptureService] Error al verificar permisos de cámara:', err);
      return { camera: this.cameraPermission, photos: 'prompt', source: 'error' };
    }
  }

  /**
   * Solicita explícitamente permisos de cámara y galería en Android / Web.
   */
  async requestPermissions() {
    try {
      if (this.isNativeCameraAvailable()) {
        const res = await window.Capacitor.Plugins.Camera.requestPermissions({
          permissions: ['camera', 'photos']
        });
        this.cameraPermission = res.camera || 'denied';
        const granted = res.camera === 'granted' || res.photos === 'granted';
        return {
          granted,
          camera: res.camera,
          photos: res.photos
        };
      }

      // En Web probamos acceso breve a mediaDevices si existe
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((track) => track.stop());
        this.cameraPermission = 'granted';
        return { granted: true, camera: 'granted', photos: 'granted' };
      }

      return { granted: true, camera: 'prompt', photos: 'granted' };
    } catch (err) {
      this.cameraPermission = 'denied';
      this.lastError = {
        title: 'Permiso de cámara denegado',
        message: 'No se otorgó acceso a la cámara para capturar la evidencia de la incidencia.',
        suggestion: 'Habilita el permiso de Cámara en los Ajustes de la aplicación o selecciona un archivo desde tu dispositivo.'
      };
      return { granted: false, camera: 'denied', error: this.lastError };
    }
  }

  /**
   * Captura una fotografía usando @capacitor/camera (cámara nativa de Android o galería)
   * y comprime/adjunta el sello de coordenadas GPS actuales.
   * @param {'CAMERA'|'PHOTOS'} sourceMode
   * @param {Object|null} currentGpsPosition
   */
  async capturePhoto(sourceMode = 'CAMERA', currentGpsPosition = null) {
    this.lastError = null;

    try {
      if (this.isNativeCameraAvailable()) {
        const perms = await this.checkPermissions();
        const neededPerm = sourceMode === 'CAMERA' ? perms.camera : perms.photos;
        if (neededPerm !== 'granted') {
          const req = await this.requestPermissions();
          if (!req.granted && sourceMode === 'CAMERA' && req.camera === 'denied') {
            throw new Error('PERMISSION_DENIED: Permiso de cámara rechazado en Android.');
          }
        }

        const photo = await window.Capacitor.Plugins.Camera.getPhoto({
          quality: 80,
          allowEditing: false,
          resultType: 'dataUrl',
          source: sourceMode, // 'CAMERA' | 'PHOTOS'
          width: 1280,
          correctOrientation: true,
          saveToGallery: false
        });

        this.cameraPermission = 'granted';
        const compressedDataUrl = await this.compressAndStampPhoto(photo.dataUrl, currentGpsPosition);
        const mediaRecord = this.buildMediaRecord('photo', compressedDataUrl, 'image/jpeg', currentGpsPosition);
        this.currentMedia = mediaRecord;
        return mediaRecord;
      }

      // Fallback Web: dispara selector de archivo / cámara nativa del sistema
      return await this.captureFromFileInput('image/*', sourceMode === 'CAMERA' ? 'environment' : null, 'photo', currentGpsPosition);
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (/cancelled|canceled|user cancelled|canceló/i.test(msg)) {
        return { cancelled: true };
      }

      const isPermDenied = /permission|denied|rechazado|not allowed/i.test(msg);
      if (isPermDenied) {
        this.cameraPermission = 'denied';
      }

      this.lastError = {
        errorType: isPermDenied ? 'CAMERA_PERMISSION_DENIED' : 'CAPTURE_ERROR',
        title: isPermDenied ? 'Permiso de cámara denegado' : 'No se pudo capturar la fotografía',
        message: isPermDenied
          ? 'La aplicación necesita permiso de Cámara para fotografiar la incidencia en vía pública.'
          : (msg || 'Ocurrió un error al abrir la cámara del dispositivo.'),
        suggestion: isPermDenied
          ? 'Otorga el permiso de Cámara en Android o usa la opción de Galería.'
          : 'Intenta nuevamente o selecciona una imagen de tu galería.'
      };
      throw this.lastError;
    }
  }

  /**
   * Captura un video corto desde la cámara del dispositivo (Android WebView / navegador móvil).
   */
  async captureVideo(currentGpsPosition = null) {
    this.lastError = null;
    try {
      return await this.captureFromFileInput('video/*', 'environment', 'video', currentGpsPosition);
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (/cancelled|canceled/i.test(msg)) {
        return { cancelled: true };
      }
      this.lastError = {
        errorType: 'VIDEO_CAPTURE_ERROR',
        title: 'No se pudo capturar el video',
        message: msg || 'Error al procesar el archivo de video capturado.',
        suggestion: 'Intenta grabar un clip corto (5 a 15 segundos) para adjuntarlo al reporte.'
      };
      throw this.lastError;
    }
  }

  /**
   * Procesa un archivo seleccionado o capturado mediante un input HTML5 (<input type="file">).
   */
  captureFromFileInput(acceptType, captureAttr, mediaType, currentGpsPosition) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = acceptType;
      if (captureAttr) {
        input.setAttribute('capture', captureAttr);
      }

      let settled = false;

      input.onchange = async (event) => {
        settled = true;
        const file = event.target.files && event.target.files[0];
        if (!file) {
          resolve({ cancelled: true });
          return;
        }

        // Límite razonable para video en almacenamiento local (15 MB)
        if (mediaType === 'video' && file.size > 15 * 1024 * 1024) {
          reject(new Error('El video supera los 15 MB. Graba un clip más breve (5–15 seg) para poder sincronizarlo.'));
          return;
        }

        try {
          const rawDataUrl = await this.readFileAsDataUrl(file);
          let finalDataUrl = rawDataUrl;
          let mimeType = file.type || (mediaType === 'photo' ? 'image/jpeg' : 'video/mp4');

          if (mediaType === 'photo') {
            finalDataUrl = await this.compressAndStampPhoto(rawDataUrl, currentGpsPosition);
            mimeType = 'image/jpeg';
          }

          const record = this.buildMediaRecord(mediaType, finalDataUrl, mimeType, currentGpsPosition, file.name);
          this.currentMedia = record;
          this.cameraPermission = 'granted';
          resolve(record);
        } catch (readErr) {
          reject(readErr);
        }
      };

      // Detectar cancelación cuando la ventana recupera el foco sin archivo
      window.addEventListener(
        'focus',
        () => {
          setTimeout(() => {
            if (!settled && (!input.files || input.files.length === 0)) {
              resolve({ cancelled: true });
            }
          }, 600);
        },
        { once: true }
      );

      input.click();
    });
  }

  /**
   * Comprime una imagen en un Canvas y estampa una cinta inferior con las coordenadas GPS y fecha/hora reales.
   */
  compressAndStampPhoto(dataUrl, gpsPos = null) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1100;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Estampado visual de coordenadas GPS reales en la esquina inferior de la evidencia
        const barHeight = Math.max(46, Math.round(height * 0.085));
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillRect(0, height - barHeight, width, barHeight);

        const fontSize = Math.max(12, Math.round(barHeight * 0.34));
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.fillStyle = '#34d399';

        const nowStr = new Date().toLocaleString('es-MX', {
          dateStyle: 'short',
          timeStyle: 'medium'
        });

        const gpsLine = gpsPos
          ? `GPS: ${gpsPos.latitude.toFixed(6)}, ${gpsPos.longitude.toFixed(6)} (±${gpsPos.accuracy ?? '?'}m)`
          : 'GPS: Pendiente de fijar coordenadas';

        ctx.fillText(`ALERTA URBANA • ${gpsLine}`, 12, height - barHeight + fontSize + 6);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = `${Math.max(11, fontSize - 2)}px sans-serif`;
        ctx.fillText(`Capturado: ${nowStr}`, 12, height - 8);

        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /**
   * Construye el objeto estandarizado de evidencia multimedia con huella GPS.
   */
  buildMediaRecord(type, dataUrl, mimeType, gpsPos, fileName = null) {
    const base64Length = dataUrl.split(',')[1]?.length || 0;
    const sizeKb = Math.max(1, Math.round((base64Length * 3) / 4 / 1024));

    return {
      type, // 'photo' | 'video'
      dataUrl,
      mimeType,
      fileName: fileName || `${type}_${Date.now()}.${type === 'photo' ? 'jpg' : 'mp4'}`,
      sizeKb,
      capturedAt: new Date().toISOString(),
      gpsSnapshot: gpsPos
        ? {
            latitude: gpsPos.latitude,
            longitude: gpsPos.longitude,
            accuracy: gpsPos.accuracy
          }
        : null
    };
  }

  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer el archivo multimedia.'));
      reader.readAsDataURL(file);
    });
  }

  clearMedia() {
    this.currentMedia = null;
  }
}
