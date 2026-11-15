/**
 * app.js
 * Controlador principal de AlertaUrbana (Capacitor 8).
 * Orquesta los módulos de Geolocalización, Captura Multimedia (Foto/Video),
 * Motor de Proximidad/Antiduplicados y Sincronización Offline/Online.
 */

import { GeolocationService } from './geolocation.js';
import { MediaCaptureService } from './media-capture.js';
import { ProximityEngine, INCIDENT_CATEGORIES } from './proximity-engine.js';
import { SyncManager } from './sync-manager.js';

export class AlertaUrbanaApp {
  constructor() {
    this.geoService = new GeolocationService();
    this.mediaService = new MediaCaptureService();
    this.proximityEngine = new ProximityEngine(35);
    this.syncManager = new SyncManager((syncStatus) => this.renderSyncStatus(syncStatus));

    this.selectedCategory = 'bache';
    this.isMapOpen = false;
    this.activeTab = 'reportar';
  }

  async init() {
    this.detectPlatformBadge();
    this.renderCategorySelector();
    this.bindEvents();

    // Estado inicial de red y reportes almacenados
    this.syncManager.notifyChange();
    this.switchTab('reportar');
    document.querySelectorAll('.radius-btn').forEach((b) => {
      b.classList.toggle('is-active', Number(b.getAttribute('data-radius')) === this.proximityEngine.duplicateRadiusMeters);
    });
    this.refreshProximityAndLists();

    // Consultar estado inicial de permisos sin bloquear la carga
    await this.refreshPermissionBadges();

    // Intentar lectura inicial de ubicación GPS
    await this.handleObtainLocation({ silentIfPrompt: false });
  }

  detectPlatformBadge() {
    const badge = document.getElementById('platform-badge');
    if (!badge) return;
    const isNative = Boolean(
      window.Capacitor &&
      window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform()
    );
    const platformName = window.Capacitor?.getPlatform ? window.Capacitor.getPlatform() : 'web';
    badge.textContent = isNative ? 'Android' : platformName;
  }

  renderCategorySelector() {
    const grid = document.getElementById('category-grid');
    if (!grid) return;

    grid.innerHTML = Object.values(INCIDENT_CATEGORIES)
      .map((cat) => `
        <button type="button" data-category="${cat.id}"
          class="cat-btn ${cat.id === this.selectedCategory ? 'is-active' : ''}">
          <span class="block text-sm font-medium">${cat.shortLabel}</span>
          <span class="block text-[10px] opacity-70">Prioridad ${cat.priority}</span>
        </button>
      `)
      .join('');

    grid.querySelectorAll('.cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedCategory = btn.getAttribute('data-category');
        this.renderCategorySelector();
        this.refreshProximityAndLists();
      });
    });
  }

  bindEvents() {
    // Botones de Geolocalización
    document.getElementById('btn-get-location')?.addEventListener('click', () => {
      this.handleObtainLocation();
    });

    document.getElementById('btn-toggle-watch')?.addEventListener('click', () => {
      this.handleToggleWatch();
    });

    document.getElementById('btn-toggle-map')?.addEventListener('click', () => {
      this.toggleMapPreview();
    });

    document.getElementById('btn-close-map')?.addEventListener('click', () => {
      this.toggleMapPreview(false);
    });

    document.getElementById('btn-copy-coords')?.addEventListener('click', () => {
      this.copyCoordinatesToClipboard();
    });

    // Botones del Panel de Errores
    document.getElementById('btn-dismiss-error')?.addEventListener('click', () => {
      this.hideErrorBanner();
    });

    document.getElementById('btn-error-retry')?.addEventListener('click', () => {
      this.hideErrorBanner();
      this.handleObtainLocation();
    });

    document.getElementById('btn-error-settings')?.addEventListener('click', () => {
      document.getElementById('modal-settings-help')?.classList.remove('hidden');
    });

    document.getElementById('btn-close-settings-modal')?.addEventListener('click', () => {
      document.getElementById('modal-settings-help')?.classList.add('hidden');
    });

    document.getElementById('btn-recheck-after-settings')?.addEventListener('click', async () => {
      document.getElementById('modal-settings-help')?.classList.add('hidden');
      this.geoService.denialCount = 0;
      await this.refreshPermissionBadges();
      await this.handleObtainLocation();
    });

    // Botones de Captura Multimedia (Foto / Video / Galería)
    document.getElementById('btn-capture-photo')?.addEventListener('click', () => {
      this.handleCapturePhoto('CAMERA');
    });

    document.getElementById('btn-pick-gallery')?.addEventListener('click', () => {
      this.handleCapturePhoto('PHOTOS');
    });

    document.getElementById('btn-capture-video')?.addEventListener('click', () => {
      this.handleCaptureVideo();
    });

    document.getElementById('btn-remove-media')?.addEventListener('click', () => {
      this.mediaService.clearMedia();
      this.renderMediaPreview();
    });

    // Formulario de Nuevo Reporte
    document.getElementById('form-new-report')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmitReport();
    });

    // Pestaña Radar Cercanos: Sembrar reportes de prueba en mi cuadra y cambiar radio
    document.getElementById('btn-seed-around-me')?.addEventListener('click', () => {
      this.handleSeedAroundCurrentGps(true);
    });

    document.querySelectorAll('.radius-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const radius = Number(btn.getAttribute('data-radius'));
        this.proximityEngine.setDuplicateRadius(radius);
        document.getElementById('lbl-active-radius').textContent = `${radius} m`;
        document.getElementById('lbl-override-radius').textContent = `${radius}`;

        document.querySelectorAll('.radius-btn').forEach((b) => {
          b.classList.toggle('is-active', Number(b.getAttribute('data-radius')) === radius);
        });

        this.refreshProximityAndLists();
        this.showToast(`Radio antiduplicados actualizado a ${radius} metros`, 'info');
      });
    });

    // Pestaña Sistema / Permisos / Simulación de Errores / Sync
    document.getElementById('btn-req-loc-perm')?.addEventListener('click', async () => {
      const res = await this.geoService.requestPermissions();
      await this.refreshPermissionBadges();
      if (res.granted) {
        this.showToast('Permiso de Ubicación concedido', 'success');
        await this.handleObtainLocation();
      } else if (res.error) {
        this.showErrorBanner(res.error);
      }
    });

    document.getElementById('btn-req-cam-perm')?.addEventListener('click', async () => {
      const res = await this.mediaService.requestPermissions();
      await this.refreshPermissionBadges();
      if (res.granted) {
        this.showToast('Permiso de Cámara concedido y listo', 'success');
      } else if (res.error) {
        this.showErrorBanner(res.error);
      }
    });

    document.querySelectorAll('.sim-error-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-sim-error');
        this.triggerSimulatedError(type);
      });
    });

    // Botones de Red / Cola Offline
    document.getElementById('btn-toggle-offline')?.addEventListener('click', () => {
      this.toggleOfflineSimulation();
    });

    document.getElementById('btn-toggle-offline-sys')?.addEventListener('click', () => {
      this.toggleOfflineSimulation();
    });

    document.getElementById('btn-sync-now')?.addEventListener('click', async () => {
      if (!this.syncManager.isOnline()) {
        this.showToast('Desactiva el Modo Offline o conéctate a internet para sincronizar', 'warning');
        return;
      }
      const res = await this.syncManager.processSyncQueue();
      this.refreshProximityAndLists();
      this.showToast(
        res.syncedCount > 0
          ? `Se sincronizaron ${res.syncedCount} reporte(s) con éxito`
          : 'La cola de sincronización ya está al día',
        'success'
      );
    });

    // Navegación entre pestañas inferiores
    document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        this.switchTab(targetTab);
      });
    });
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    ['reportar', 'cercanos', 'sistema'].forEach((t) => {
      document.getElementById(`tab-${t}`)?.classList.toggle('hidden', t !== tabName);
    });

    document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-tab') === tabName);
    });

    this.refreshProximityAndLists();
  }

  /**
   * Actualiza los indicadores visuales del estado de permisos de Ubicación y Cámara.
   */
  async refreshPermissionBadges() {
    const locPerm = await this.geoService.checkPermissions();
    const camPerm = await this.mediaService.checkPermissions();

    const locState = this.geoService.permissionState || locPerm.location || 'prompt';
    const camState = camPerm.camera || 'prompt';

    const format = (state, label) => {
      if (state === 'granted') return { text: `${label}: concedido`, cls: 'text-[10px] text-green-400' };
      if (state === 'denied') return { text: `${label}: denegado`, cls: 'text-[10px] text-red-400' };
      if (state === 'denied_permanently') return { text: `${label}: bloqueado`, cls: 'text-[10px] text-red-400' };
      return { text: `${label}: pendiente`, cls: 'text-[10px] text-amber-400' };
    };

    const locPill = document.getElementById('perm-loc-pill');
    if (locPill) {
      const f = format(locState, 'GPS');
      locPill.textContent = f.text;
      locPill.className = f.cls;
    }

    const camPill = document.getElementById('perm-cam-pill');
    if (camPill) {
      const f = format(camState, 'Cámara');
      camPill.textContent = f.text;
      camPill.className = f.cls;
    }

    const sysLocBadge = document.getElementById('sys-loc-perm-badge');
    if (sysLocBadge) sysLocBadge.textContent = locState;

    const sysCamBadge = document.getElementById('sys-cam-perm-badge');
    if (sysCamBadge) sysCamBadge.textContent = camState;
  }

  /**
   * Obtiene las coordenadas reales del dispositivo y actualiza toda la UI y el motor de proximidad.
   */
  async handleObtainLocation() {
    this.setGpsUiState('locating', 'Buscando satélites GPS...');
    this.hideErrorBanner();

    try {
      const position = await this.geoService.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0
      });

      this.onPositionUpdated(position);

      // Si es la primera vez que se obtiene GPS y no hay reportes cercanos sembrados, generar 3 puntos contextuales alrededor del usuario
      if (!this.syncManager.hasInitialSeeds()) {
        this.handleSeedAroundCurrentGps(false);
      }
    } catch (classifiedError) {
      this.setGpsUiState('error', classifiedError.title || 'Error de GPS');
      this.showErrorBanner(classifiedError);
    } finally {
      await this.refreshPermissionBadges();
    }
  }

  /**
   * Activa o desactiva el seguimiento continuo en tiempo real (watchPosition).
   */
  async handleToggleWatch() {
    const watchBtn = document.getElementById('btn-toggle-watch');
    const watchLabel = document.getElementById('watch-label');

    if (this.geoService.watchId !== null) {
      await this.geoService.stopWatch();
      watchBtn?.classList.replace('text-white', 'text-zinc-300');
      if (watchLabel) watchLabel.textContent = 'Radar continuo';
      this.setGpsUiState(this.geoService.currentPosition ? 'active' : 'idle', 'GPS fijado');
      this.showToast('Seguimiento continuo pausado', 'info');
      return;
    }

    this.hideErrorBanner();
    this.setGpsUiState('locating', 'Iniciando radar continuo...');

    const id = await this.geoService.startWatch(
      (pos) => this.onPositionUpdated(pos),
      (err) => {
        this.setGpsUiState('error', err.title || 'Error en seguimiento GPS');
        this.showErrorBanner(err);
      }
    );

    if (id !== null) {
      watchBtn?.classList.replace('text-zinc-300', 'text-white');
      if (watchLabel) watchLabel.textContent = 'Detener radar';
      this.showToast('Radar GPS continuo activado', 'success');
    }
  }

  /**
   * Callback cada vez que entra una lectura GPS válida.
   */
  onPositionUpdated(pos) {
    const isWatching = this.geoService.watchId !== null;
    this.setGpsUiState(
      isWatching ? 'watching' : 'active',
      isWatching ? 'Monitoreo GPS continuo' : 'GPS fijado'
    );

    document.getElementById('coord-lat').textContent = pos.latitude.toFixed(6);
    document.getElementById('coord-lng').textContent = pos.longitude.toFixed(6);
    document.getElementById('coord-acc').textContent = pos.accuracy !== null ? `±${pos.accuracy} m` : '-';

    const timeStr = new Date(pos.timestamp).toLocaleTimeString('es-MX');
    const qualityBadge = document.getElementById('gps-quality-badge');
    if (qualityBadge) {
      qualityBadge.textContent = `${pos.qualityLabel} · ${timeStr}`;
      qualityBadge.className =
        pos.qualityLevel === 'excellent' || pos.qualityLevel === 'good'
          ? 'text-[11px] text-green-400 mt-2'
          : 'text-[11px] text-amber-400 mt-2';
    }

    document.getElementById('btn-copy-coords')?.classList.remove('hidden');

    const mapLink = document.getElementById('link-external-map');
    if (mapLink) {
      mapLink.href = GeolocationService.getMapsUrl(pos.latitude, pos.longitude);
      mapLink.classList.remove('hidden');
    }

    if (this.isMapOpen) {
      this.updateOsmIframe(pos.latitude, pos.longitude);
    }

    this.refreshProximityAndLists();
  }

  setGpsUiState(state, text) {
    const dot = document.getElementById('gps-status-dot');
    const label = document.getElementById('gps-status-text');
    if (label) label.textContent = text;
    if (!dot) return;

    const colors = {
      locating: 'bg-amber-400 animate-pulse',
      active: 'bg-green-400',
      watching: 'bg-green-400 animate-pulse',
      error: 'bg-red-500'
    };
    dot.className = `w-1.5 h-1.5 rounded-full ${colors[state] || 'bg-zinc-500'}`;
  }

  toggleMapPreview(forceState = null) {
    const pos = this.geoService.currentPosition;
    if (!pos && forceState !== false) {
      this.showToast('Primero obtén tus coordenadas GPS para centrar el mapa', 'warning');
      this.handleObtainLocation();
      return;
    }

    const container = document.getElementById('map-preview-container');
    if (!container) return;

    this.isMapOpen = forceState !== null ? forceState : !this.isMapOpen;
    container.classList.toggle('hidden', !this.isMapOpen);

    if (this.isMapOpen && pos) {
      this.updateOsmIframe(pos.latitude, pos.longitude);
    }
  }

  updateOsmIframe(lat, lon) {
    const iframe = document.getElementById('osm-iframe');
    if (iframe) {
      iframe.src = GeolocationService.getOsmEmbedUrl(lat, lon);
    }
  }

  async copyCoordinatesToClipboard() {
    const pos = this.geoService.currentPosition;
    if (!pos) return;
    const text = `${pos.latitude.toFixed(6)}, ${pos.longitude.toFixed(6)} (±${pos.accuracy ?? '?'}m)`;
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(`Coordenadas copiadas: ${text}`, 'success');
    } catch (_) {
      this.showToast(text, 'info');
    }
  }

  /**
   * Evalúa la proximidad de todos los reportes contra el GPS actual, actualiza el detector antiduplicados
   * en el formulario y renderiza la lista de reportes cercanos.
   */
  refreshProximityAndLists() {
    const allReports = this.syncManager.getReports();
    const userPos = this.geoService.currentPosition;

    const evaluated = this.proximityEngine.evaluateReportsProximity(allReports, userPos);
    const dupCheck = this.proximityEngine.checkPotentialDuplicates(allReports, userPos, this.selectedCategory);

    this.renderDuplicateDetector(dupCheck);
    this.renderNearbyReportsList(evaluated);

    const navCount = document.getElementById('nav-nearby-count');
    if (navCount) {
      navCount.textContent = String(evaluated.length);
    }
  }

  /**
   * Renderiza el cuadro central de validación geográfica antiduplicados en el Paso 1.
   */
  renderDuplicateDetector(dupCheck) {
    const box = document.getElementById('duplicate-detector-box');
    const title = document.getElementById('dup-title');
    const desc = document.getElementById('dup-desc');
    const listEl = document.getElementById('dup-matches-list');
    const overrideWrapper = document.getElementById('dup-override-wrapper');

    if (!box || !title || !desc || !listEl) return;

    const setBox = (borderCls, bgCls, titleCls) => {
      box.className = `mt-3 rounded p-3 border-l-2 ${borderCls} ${bgCls}`;
      title.className = `text-xs font-semibold ${titleCls}`;
    };

    if (!dupCheck.hasGps) {
      setBox('border-zinc-300', 'bg-zinc-50', 'text-zinc-800');
      title.textContent = 'Validación geográfica pendiente';
      desc.textContent = `Activa el GPS para verificar reportes en un radio de ${this.proximityEngine.duplicateRadiusMeters} m.`;
      listEl.classList.add('hidden');
      overrideWrapper?.classList.add('hidden');
      return;
    }

    const catInfo = INCIDENT_CATEGORIES[this.selectedCategory];

    if (dupCheck.nearbyInRadius.length > 0) {
      const exactCount = dupCheck.exactCategoryMatches.length;
      setBox('border-blue-600', 'bg-blue-50', 'text-blue-900');
      title.textContent =
        exactCount > 0
          ? `Duplicado probable a menos de ${dupCheck.radiusMeters} m`
          : `Reporte registrado a menos de ${dupCheck.radiusMeters} m`;

      desc.textContent =
        exactCount > 0
          ? `Ya existe ${exactCount} reporte(s) de "${catInfo.shortLabel}" en tu radio inmediato. Puedes confirmarlo o marcar que es un punto distinto.`
          : `Se detectó ${dupCheck.nearbyInRadius.length} reporte(s) en tu radio inmediato:`;

      listEl.classList.remove('hidden');
      listEl.innerHTML = dupCheck.nearbyInRadius
        .map((r) => `
          <div class="flex items-center justify-between gap-2 py-1.5 border-t border-blue-100">
            <div class="min-w-0">
              <p class="text-xs font-medium text-zinc-900 truncate">${this.escapeHtml(r.title)}</p>
              <p class="text-[11px] text-zinc-500 mono">${r.distanceFormatted} ${r.bearing?.cardinal || ''} · ${r.confirmations || 1} confirmaciones</p>
            </div>
            <button type="button" data-confirm-id="${r.id}" data-confirm-dist="${r.distanceMeters}"
              class="btn-quick-confirm shrink-0 text-xs font-semibold text-blue-700">Confirmar</button>
          </div>
        `)
        .join('');

      listEl.querySelectorAll('.btn-quick-confirm').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.handleConfirmExistingReport(
            btn.getAttribute('data-confirm-id'),
            Number(btn.getAttribute('data-confirm-dist'))
          );
        });
      });

      overrideWrapper?.classList.remove('hidden');
      return;
    }

    setBox('border-green-600', 'bg-green-50', 'text-green-900');
    title.textContent = `Sin duplicados en ${dupCheck.radiusMeters} m`;
    const closestTxt = dupCheck.closestReport
      ? `El más cercano está a ${dupCheck.closestReport.distanceFormatted} (${dupCheck.closestReport.bearing?.cardinal || ''}).`
      : 'No hay otros reportes cerca de tu posición.';
    desc.textContent = closestTxt;
    listEl.classList.add('hidden');
    overrideWrapper?.classList.add('hidden');
  }

  /**
   * Renderiza la lista completa de reportes ordenados por distancia real en la pestaña Radar Cercanos.
   */
  renderNearbyReportsList(evaluatedReports) {
    const container = document.getElementById('nearby-reports-list');
    if (!container) return;

    if (evaluatedReports.length === 0) {
      container.innerHTML = `
        <div class="p-6 text-center">
          <p class="text-sm font-medium text-zinc-700">Aún no hay reportes</p>
          <p class="text-[11px] text-zinc-500 mt-1">Levanta uno nuevo o genera reportes de prueba cerca de ti.</p>
        </div>`;
      return;
    }

    container.innerHTML = evaluatedReports
      .map((r) => {
        const cat = INCIDENT_CATEGORIES[r.category] || INCIDENT_CATEGORIES.bache;
        const synced = r.syncState === 'synced';
        const syncText = synced
          ? '<span class="text-green-700">Sincronizado</span>'
          : '<span class="text-amber-600">En cola</span>';
        const distCls = r.isWithinDuplicateRadius ? 'text-blue-700 font-semibold' : 'text-zinc-700';

        const mediaHtml = r.media?.dataUrl
          ? r.media.type === 'video'
            ? `<video src="${r.media.dataUrl}" controls playsinline class="mt-2 w-full max-h-44 rounded bg-black"></video>`
            : `<img src="${r.media.dataUrl}" alt="Evidencia" class="mt-2 w-full max-h-44 object-cover rounded" loading="lazy" />`
          : '';

        const mapsUrl = GeolocationService.getMapsUrl(Number(r.latitude), Number(r.longitude));
        const createdTime = new Date(r.createdAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

        return `
          <article class="p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[10px] uppercase tracking-wider text-zinc-500">${cat.shortLabel}</p>
                <h3 class="text-sm font-medium text-zinc-900">${this.escapeHtml(r.title)}</h3>
              </div>
              <div class="text-right shrink-0 mono text-xs ${distCls}">
                ${r.distanceFormatted}${r.bearing ? ` ${r.bearing.cardinal}` : ''}
              </div>
            </div>
            <p class="text-xs text-zinc-600 mt-1.5 leading-relaxed">${this.escapeHtml(r.description)}</p>
            ${r.reference ? `<p class="text-[11px] text-zinc-500 mt-1">Ref: ${this.escapeHtml(r.reference)}</p>` : ''}
            ${mediaHtml}
            <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
              <span class="mono">${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)} · ${createdTime}</span>
              <span class="flex items-center gap-3">
                ${syncText}
                <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-700 font-medium">Mapa</a>
                <button type="button" data-confirm-id="${r.id}" data-confirm-dist="${r.distanceMeters ?? 0}"
                  class="btn-card-confirm text-blue-700 font-semibold">Confirmar (${r.confirmations || 1})</button>
              </span>
            </div>
          </article>`;
      })
      .join('');

    container.querySelectorAll('.btn-card-confirm').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.handleConfirmExistingReport(
          btn.getAttribute('data-confirm-id'),
          Number(btn.getAttribute('data-confirm-dist'))
        );
      });
    });
  }

  /**
   * Captura de Foto integrada con @capacitor/camera y sello de coordenadas GPS.
   */
  async handleCapturePhoto(sourceMode = 'CAMERA') {
    try {
      const result = await this.mediaService.capturePhoto(sourceMode, this.geoService.currentPosition);
      await this.refreshPermissionBadges();
      if (result && !result.cancelled) {
        this.renderMediaPreview();
        this.showToast('Fotografía capturada con sello GPS', 'success');
      }
    } catch (err) {
      await this.refreshPermissionBadges();
      this.showErrorBanner(err);
    }
  }

  /**
   * Captura de Video desde el dispositivo vinculada a las coordenadas actuales.
   */
  async handleCaptureVideo() {
    try {
      const result = await this.mediaService.captureVideo(this.geoService.currentPosition);
      await this.refreshPermissionBadges();
      if (result && !result.cancelled) {
        this.renderMediaPreview();
        this.showToast('Video de evidencia adjuntado al reporte', 'success');
      }
    } catch (err) {
      this.showErrorBanner(err);
    }
  }

  renderMediaPreview() {
    const box = document.getElementById('media-preview-box');
    const imgEl = document.getElementById('photo-preview-el');
    const vidEl = document.getElementById('video-preview-el');
    const badge = document.getElementById('media-meta-badge');
    const stamp = document.getElementById('media-gps-stamp');

    const media = this.mediaService.currentMedia;
    if (!media) {
      box?.classList.add('hidden');
      if (imgEl) {
        imgEl.src = '';
        imgEl.classList.add('hidden');
      }
      if (vidEl) {
        vidEl.src = '';
        vidEl.classList.add('hidden');
      }
      return;
    }

    box?.classList.remove('hidden');
    badge.textContent = `${media.type === 'photo' ? 'Fotografía' : 'Video'} (${media.sizeKb} KB)`;

    if (media.type === 'photo') {
      imgEl.src = media.dataUrl;
      imgEl.classList.remove('hidden');
      vidEl.classList.add('hidden');
    } else {
      vidEl.src = media.dataUrl;
      vidEl.classList.remove('hidden');
      imgEl.classList.add('hidden');
    }

    const gps = media.gpsSnapshot || this.geoService.currentPosition;
    stamp.textContent = gps
      ? `Sello GPS de captura: ${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)} (±${gps.accuracy ?? '?'} m)`
      : 'Capturado sin lectura GPS previa (se asociará al enviar)';
  }

  /**
   * Valida y guarda un nuevo reporte ciudadano georreferenciado.
   */
  async handleSubmitReport() {
    // 1. Verificar que existan coordenadas GPS reales
    if (!this.geoService.currentPosition) {
      this.showToast('Obteniendo ubicación GPS antes de registrar el reporte...', 'warning');
      await this.handleObtainLocation();
      if (!this.geoService.currentPosition) {
        return;
      }
    }

    const pos = this.geoService.currentPosition;
    const titleInput = document.getElementById('input-title');
    const descInput = document.getElementById('input-description');
    const refInput = document.getElementById('input-reference');
    const overrideChk = document.getElementById('chk-duplicate-override');

    const title = titleInput?.value?.trim() || '';
    const description = descInput?.value?.trim() || '';
    const reference = refInput?.value?.trim() || '';

    if (!title || !description) {
      this.showToast('Completa el título y la descripción de la incidencia', 'warning');
      return;
    }

    // 2. Validar geocerca antiduplicados
    const dupCheck = this.proximityEngine.checkPotentialDuplicates(
      this.syncManager.getReports(),
      pos,
      this.selectedCategory
    );

    if (dupCheck.nearbyInRadius.length > 0 && !overrideChk?.checked) {
      this.showToast(
        `Hay un reporte a menos de ${dupCheck.radiusMeters} m. Confírmalo con "+1" o marca la casilla de confirmación.`,
        'warning'
      );
      document.getElementById('dup-override-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // 3. Validar que cuente con foto o video de evidencia
    if (!this.mediaService.currentMedia) {
      this.showToast('Captura una foto o video de evidencia (Paso 2) para respaldar el reporte', 'warning');
      document.getElementById('btn-capture-photo')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const saved = await this.syncManager.createReport({
      category: this.selectedCategory,
      title,
      description,
      reference,
      latitude: pos.latitude,
      longitude: pos.longitude,
      accuracy: pos.accuracy,
      duplicateOverride: Boolean(overrideChk?.checked),
      media: this.mediaService.currentMedia
    });

    // Limpiar formulario y evidencia
    if (titleInput) titleInput.value = '';
    if (descInput) descInput.value = '';
    if (refInput) refInput.value = '';
    if (overrideChk) overrideChk.checked = false;
    this.mediaService.clearMedia();
    this.renderMediaPreview();

    this.refreshProximityAndLists();

    const syncMsg =
      saved.syncState === 'synced'
        ? `Reporte ${saved.id} georreferenciado y sincronizado`
        : `Reporte ${saved.id} guardado en cola Offline (se enviará al reconectar)`;

    this.showToast(syncMsg, 'success');
    this.switchTab('cercanos');
  }

  /**
   * Suma +1 confirmación ciudadana a un reporte cercano existente.
   */
  async handleConfirmExistingReport(reportId, distanceMeters) {
    const updated = await this.syncManager.confirmNearbyReport(
      reportId,
      this.geoService.currentPosition,
      distanceMeters
    );
    if (updated) {
      this.refreshProximityAndLists();
      this.showToast(
        `¡Gracias! Confirmaste el reporte ${updated.id} a ${distanceMeters} m (${updated.confirmations} apoyos)`,
        'success'
      );
    }
  }

  /**
   * Genera 3 reportes de prueba alrededor de las coordenadas reales actuales del usuario.
   */
  async handleSeedAroundCurrentGps(notifyUser = true) {
    if (!this.geoService.currentPosition) {
      await this.handleObtainLocation();
    }
    const pos = this.geoService.currentPosition;
    if (!pos) {
      this.showToast('Activa primero el GPS para generar incidencias alrededor de tus coordenadas reales', 'warning');
      return;
    }

    const seeds = ProximityEngine.createContextualSeedReports(pos.latitude, pos.longitude);
    this.syncManager.seedReportsAroundUser(seeds, true);
    this.refreshProximityAndLists();

    if (notifyUser) {
      this.showToast('Se generaron 3 incidencias a 18 m, 62 m y 195 m de tu GPS actual', 'success');
    }
  }

  /**
   * Muestra el banner detallado de errores y permisos rechazados.
   */
  showErrorBanner(errorObj) {
    const panel = document.getElementById('error-alert-panel');
    const titleEl = document.getElementById('error-title');
    const msgEl = document.getElementById('error-message');
    const sugEl = document.getElementById('error-suggestion');
    const retryBtn = document.getElementById('btn-error-retry');
    const settingsBtn = document.getElementById('btn-error-settings');

    if (!panel) return;

    titleEl.textContent = errorObj.title || 'Problema con Ubicación o Permisos';
    msgEl.textContent = errorObj.message || 'No fue posible completar la operación.';
    sugEl.textContent = `Qué hacer: ${errorObj.suggestion || 'Verifica los permisos de la aplicación en Android.'}`;

    if (retryBtn) {
      retryBtn.classList.toggle('hidden', errorObj.canRetry === false);
    }
    if (settingsBtn) {
      settingsBtn.classList.toggle('hidden', errorObj.needsSettings === false);
    }

    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  hideErrorBanner() {
    document.getElementById('error-alert-panel')?.classList.add('hidden');
  }

  /**
   * Permite simular cualquiera de los estados de error obligatorios desde la pestaña Permisos & Sync.
   */
  triggerSimulatedError(errorType) {
    const map = {
      PERMISSION_DENIED: { code: 1, message: 'User denied Geolocation' },
      PERMISSION_DENIED_PERMANENTLY: {
        code: 'PERMISSION_DENIED_PERMANENTLY',
        message: 'Location permission permanently denied by system'
      },
      LOCATION_DISABLED: { code: 2, message: 'Location services are not enabled on device' },
      TIMEOUT: { code: 3, message: 'Position acquisition timed out' }
    };

    const classified = this.geoService.classifyError(map[errorType] || { message: errorType });
    this.setGpsUiState('error', classified.title);
    this.showErrorBanner(classified);
    this.refreshPermissionBadges();
  }

  toggleOfflineSimulation() {
    const nextState = !this.syncManager.forceOfflineMode;
    this.syncManager.setForceOfflineMode(nextState);
    this.showToast(
      nextState
        ? 'Modo Offline activado: los reportes se guardarán en la cola local'
        : 'Modo Online restaurado: sincronizando reportes pendientes...',
      nextState ? 'warning' : 'success'
    );
    this.refreshProximityAndLists();
  }

  renderSyncStatus(status) {
    const dot = document.getElementById('net-dot');
    const label = document.getElementById('net-label');
    const badge = document.getElementById('sync-queue-badge');
    const sysPending = document.getElementById('sys-pending-count');

    if (sysPending) sysPending.textContent = `${status.pendingCount} pendiente(s)`;

    if (badge) {
      badge.textContent = String(status.pendingCount);
      badge.classList.toggle('hidden', status.pendingCount === 0);
    }

    if (!dot || !label) return;

    if (status.isSyncing) {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse';
      label.textContent = 'Sincronizando';
    } else if (status.online) {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-green-400';
      label.textContent = 'En línea';
    } else {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400';
      label.textContent = status.forceOfflineMode ? 'Offline (prueba)' : 'Sin red';
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const colors = {
      success: 'bg-zinc-900 text-white',
      warning: 'bg-amber-100 text-amber-900',
      error: 'bg-red-100 text-red-900',
      info: 'bg-zinc-900 text-white'
    };

    const toast = document.createElement('div');
    toast.className = `px-3.5 py-2.5 rounded text-xs font-medium shadow-lg transition-opacity duration-200 ${colors[type] || colors.info}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

if (!globalThis.__ALERTA_NO_AUTOSTART__) document.addEventListener('DOMContentLoaded', () => {
  const app = new AlertaUrbanaApp();
  app.init();
});
