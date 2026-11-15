/**
 * sync-manager.js
 * Gestor de persistencia Offline/Online y cola de sincronización para AlertaUrbana.
 * Almacena reportes ciudadanos georreferenciados localmente, administra la cola de envío
 * cuando no hay red y sincroniza automáticamente al recuperar conectividad.
 */

const STORAGE_KEYS = {
  REPORTS: 'alerta_urbana_reports_v1',
  SYNC_QUEUE: 'alerta_urbana_sync_queue_v1',
  CONFIG: 'alerta_urbana_config_v1',
  SEEDED_FLAG: 'alerta_urbana_seeded_v1'
};

export class SyncManager {
  constructor(onStatusChange = null) {
    this.onStatusChange = onStatusChange;
    this.forceOfflineMode = false;
    this.isSyncing = false;
    this.apiEndpoint = ''; // Opcional: URL de API REST externa si se configura

    this.loadConfig();

    window.addEventListener('online', () => {
      this.notifyChange();
      if (this.isOnline()) {
        this.processSyncQueue();
      }
    });

    window.addEventListener('offline', () => {
      this.notifyChange();
    });
  }

  loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CONFIG);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.forceOfflineMode = Boolean(parsed.forceOfflineMode);
        this.apiEndpoint = parsed.apiEndpoint || '';
      }
    } catch (err) {
      console.warn('[SyncManager] Error al cargar configuración:', err);
    }
  }

  saveConfig() {
    try {
      localStorage.setItem(
        STORAGE_KEYS.CONFIG,
        JSON.stringify({
          forceOfflineMode: this.forceOfflineMode,
          apiEndpoint: this.apiEndpoint
        })
      );
    } catch (err) {
      console.warn('[SyncManager] Error al guardar configuración:', err);
    }
  }

  isOnline() {
    if (this.forceOfflineMode) return false;
    return navigator.onLine !== false;
  }

  setForceOfflineMode(enabled) {
    this.forceOfflineMode = Boolean(enabled);
    this.saveConfig();
    this.notifyChange();
    if (this.isOnline()) {
      this.processSyncQueue();
    }
  }

  getReports() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.REPORTS);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.warn('[SyncManager] Error al leer reportes locales:', err);
      return [];
    }
  }

  saveReportsList(reports) {
    try {
      localStorage.setItem(STORAGE_KEYS.REPORTS, JSON.stringify(reports));
    } catch (err) {
      console.error('[SyncManager] Error al guardar lista de reportes (posible cuota excedida):', err);
      // Si el almacenamiento local se llena por videos grandes, conservar metadatos multimedia ligeros
      const lightReports = reports.map((r, idx) => {
        if (idx > 6 && r.media && r.media.dataUrl && r.media.dataUrl.length > 200000) {
          return {
            ...r,
            media: {
              ...r.media,
              dataUrl: null,
              purgedForSpace: true
            }
          };
        }
        return r;
      });
      localStorage.setItem(STORAGE_KEYS.REPORTS, JSON.stringify(lightReports));
    }
  }

  getSyncQueue() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SYNC_QUEUE);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      return [];
    }
  }

  saveSyncQueue(queue) {
    try {
      localStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(queue));
    } catch (err) {
      console.warn('[SyncManager] Error al guardar cola de sincronización:', err);
    }
  }

  /**
   * Registra un nuevo reporte ciudadano georreferenciado.
   * Si hay red, lo sincroniza; si está offline, lo encola localmente.
   */
  async createReport(payload) {
    const nowIso = new Date().toISOString();
    const reportId = `AU-${Date.now().toString().slice(-6)}`;

    const newReport = {
      id: reportId,
      category: payload.category,
      title: payload.title.trim(),
      description: payload.description.trim(),
      reference: (payload.reference || '').trim(),
      latitude: Number(payload.latitude),
      longitude: Number(payload.longitude),
      accuracy: payload.accuracy ?? null,
      confirmations: 1,
      status: 'pendiente',
      syncState: 'pending', // 'pending' | 'synced' | 'error'
      createdAt: nowIso,
      author: 'Mi Dispositivo',
      isMine: true,
      duplicateOverride: Boolean(payload.duplicateOverride),
      media: payload.media || null
    };

    const reports = this.getReports();
    reports.unshift(newReport);
    this.saveReportsList(reports);

    // Encolar acción para sincronización
    const queue = this.getSyncQueue();
    queue.push({
      queueId: `Q-${Date.now()}`,
      action: 'CREATE_REPORT',
      reportId: newReport.id,
      queuedAt: nowIso
    });
    this.saveSyncQueue(queue);
    this.notifyChange();

    if (this.isOnline()) {
      await this.processSyncQueue();
    }

    return this.getReports().find((r) => r.id === reportId) || newReport;
  }

  /**
   * Permite al ciudadano sumarse (+1 confirmación) a un reporte cercano existente
   * en lugar de crear un reporte duplicado, adjuntando la distancia de verificación.
   */
  async confirmNearbyReport(reportId, userPos, distanceMeters) {
    const reports = this.getReports();
    const target = reports.find((r) => r.id === reportId);
    if (!target) return null;

    target.confirmations = (target.confirmations || 1) + 1;
    target.lastConfirmedAt = new Date().toISOString();
    target.verifiedByUserAtMeters = distanceMeters;
    target.syncState = this.isOnline() ? 'synced' : 'pending';

    this.saveReportsList(reports);

    if (!this.isOnline()) {
      const queue = this.getSyncQueue();
      queue.push({
        queueId: `Q-CONF-${Date.now()}`,
        action: 'CONFIRM_REPORT',
        reportId,
        verifiedAt: {
          latitude: userPos?.latitude,
          longitude: userPos?.longitude,
          distanceMeters
        },
        queuedAt: new Date().toISOString()
      });
      this.saveSyncQueue(queue);
    }

    this.notifyChange();
    return target;
  }

  /**
   * Procesa los elementos pendientes en la cola de sincronización cuando hay conexión.
   */
  async processSyncQueue() {
    if (this.isSyncing || !this.isOnline()) return { syncedCount: 0 };

    const queue = this.getSyncQueue();
    if (queue.length === 0) return { syncedCount: 0 };

    this.isSyncing = true;
    this.notifyChange();

    const reports = this.getReports();
    const remainingQueue = [];
    let syncedCount = 0;

    for (const item of queue) {
      try {
        const targetReport = reports.find((r) => r.id === item.reportId);

        if (this.apiEndpoint && this.apiEndpoint.startsWith('http')) {
          const response = await fetch(this.apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: item.action,
              report: targetReport,
              queuedAt: item.queuedAt
            })
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
        } else {
          // Simulación realista de latencia de red hacia el servidor municipal
          await new Promise((r) => setTimeout(r, 380));
        }

        if (targetReport) {
          targetReport.syncState = 'synced';
          targetReport.syncedAt = new Date().toISOString();
        }
        syncedCount += 1;
      } catch (err) {
        console.warn('[SyncManager] Falló sincronización de item:', item.reportId, err);
        const targetReport = reports.find((r) => r.id === item.reportId);
        if (targetReport) {
          targetReport.syncState = 'error';
        }
        remainingQueue.push(item);
      }
    }

    this.saveReportsList(reports);
    this.saveSyncQueue(remainingQueue);
    this.isSyncing = false;
    this.notifyChange();

    return { syncedCount, pendingCount: remainingQueue.length };
  }

  /**
   * Siembra incidencias cercanas alrededor de las coordenadas GPS reales del usuario
   * la primera vez que obtiene GPS o cuando solicita regenerar puntos cercanos de prueba.
   */
  seedReportsAroundUser(seedReportsArray, replaceExistingSeeds = false) {
    let reports = this.getReports();
    if (replaceExistingSeeds) {
      reports = reports.filter((r) => !String(r.id).startsWith('REP-VEC-'));
    }

    const hasSeeds = reports.some((r) => String(r.id).startsWith('REP-VEC-'));
    if (!hasSeeds || replaceExistingSeeds) {
      const merged = [...reports, ...seedReportsArray];
      this.saveReportsList(merged);
      localStorage.setItem(STORAGE_KEYS.SEEDED_FLAG, 'true');
      this.notifyChange();
      return merged;
    }

    return reports;
  }

  hasInitialSeeds() {
    return localStorage.getItem(STORAGE_KEYS.SEEDED_FLAG) === 'true' && this.getReports().length > 0;
  }

  deleteReport(reportId) {
    const filtered = this.getReports().filter((r) => r.id !== reportId);
    this.saveReportsList(filtered);
    const queue = this.getSyncQueue().filter((q) => q.reportId !== reportId);
    this.saveSyncQueue(queue);
    this.notifyChange();
  }

  notifyChange() {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange({
        online: this.isOnline(),
        forceOfflineMode: this.forceOfflineMode,
        isSyncing: this.isSyncing,
        pendingCount: this.getSyncQueue().length,
        totalReports: this.getReports().length
      });
    }
  }
}
