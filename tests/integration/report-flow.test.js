import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, loadIndexHtml, makeNativeCapacitor, MX_POS } from '../helpers/env.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('Integración: flujo completo de reporte ciudadano (UI + módulos + Capacitor mock)', () => {
  let env;
  let native;
  let app;
  let $;

  async function boot(nativeOpts = {}) {
    native = makeNativeCapacitor(nativeOpts);
    env = setupDom({ html: loadIndexHtml(), capacitor: native.capacitor });
    $ = (id) => document.getElementById(id);
    const { AlertaUrbanaApp } = await import('../../www/js/app.js');
    app = new AlertaUrbanaApp();
    // jsdom no implementa canvas: se aísla el estampado de la foto.
    app.mediaService.compressAndStampPhoto = async (d) => d;
    await app.init();
  }

  const visible = (id) => !$(id).classList.contains('hidden');
  const toasts = () => $('toast-container').textContent;
  const attachPhoto = () => {
    app.mediaService.currentMedia = app.mediaService.buildMediaRecord(
      'photo', 'data:image/jpeg;base64,AAAA', 'image/jpeg', app.geoService.currentPosition
    );
    app.renderMediaPreview();
  };
  const fillForm = () => {
    $('input-title').value = 'Bache frente a la escuela';
    $('input-description').value = 'Hundimiento de 50 cm en el carril derecho';
  };

  afterEach(() => env?.teardown());

  describe('permiso concedido', () => {
    beforeEach(() => boot());

    test('al iniciar solicita permiso, lee el GPS y muestra latitud, longitud y precisión', () => {
      assert.equal(native.state.calls.requestGeo, 1);
      assert.equal($('coord-lat').textContent, MX_POS.latitude.toFixed(6));
      assert.equal($('coord-lng').textContent, MX_POS.longitude.toFixed(6));
      assert.equal($('coord-acc').textContent, '±8 m');
      assert.equal($('gps-status-text').textContent, 'GPS fijado');
      assert.equal($('perm-loc-pill').textContent, 'GPS: concedido');
      assert.ok($('link-external-map').href.includes('19.432608,-99.133209'));
      assert.equal(visible('error-alert-panel'), false);
    });

    test('genera 3 reportes cercanos y muestra el detector de duplicados (≤35 m)', () => {
      assert.equal(app.syncManager.getReports().length, 3);
      assert.equal($('nav-nearby-count').textContent, '3');
      assert.match($('dup-title').textContent, /Duplicado probable/);
      assert.equal(visible('dup-override-wrapper'), true);
      assert.equal(document.querySelectorAll('.btn-quick-confirm').length, 1);
    });

    test('la lista Cercanos se ordena por distancia', () => {
      app.switchTab('cercanos');
      const dists = [...document.querySelectorAll('#nearby-reports-list article .mono.text-xs')]
        .map((el) => el.textContent.trim());
      assert.equal(dists.length, 3);
      assert.match(dists[0], /^1\d m/);
      assert.match(dists[2], /^1\d\d m/);
    });

    test('cambiar de categoría y de radio actualiza la validación geográfica', async () => {
      document.querySelector('[data-category="luminaria"]').click();
      assert.equal(app.selectedCategory, 'luminaria');
      document.querySelector('[data-radius="100"]').click();
      assert.equal($('lbl-active-radius').textContent, '100 m');
      assert.match($('dup-title').textContent, /100 m/);
      assert.equal(document.querySelectorAll('.btn-quick-confirm').length, 2);
    });

    test('confirmar un duplicado cercano suma +1', async () => {
      const before = app.syncManager.getReports().find((r) => r.id.endsWith('A')).confirmations;
      document.querySelector('.btn-quick-confirm').click();
      await tick();
      const after = app.syncManager.getReports().find((r) => r.id.endsWith('A')).confirmations;
      assert.equal(after, before + 1);
      assert.match(toasts(), /Confirmaste/);
    });

    test('no se registra un reporte con duplicado cercano sin confirmación explícita', async () => {
      fillForm();
      attachPhoto();
      await app.handleSubmitReport();
      assert.equal(app.syncManager.getReports().length, 3);
      assert.match(toasts(), /menos de 35 m/);
    });

    test('no se registra un reporte sin foto o video de evidencia', async () => {
      fillForm();
      $('chk-duplicate-override').checked = true;
      await app.handleSubmitReport();
      assert.equal(app.syncManager.getReports().length, 3);
      assert.match(toasts(), /foto o video/);
    });

    test('flujo feliz: confirma punto distinto, adjunta evidencia y registra el reporte georreferenciado', async () => {
      fillForm();
      $('input-reference').value = 'Frente al poste 42';
      $('chk-duplicate-override').checked = true;
      attachPhoto();
      await app.handleSubmitReport();

      const reports = app.syncManager.getReports();
      assert.equal(reports.length, 4);
      const mine = reports[0];
      assert.equal(mine.title, 'Bache frente a la escuela');
      assert.equal(mine.latitude, MX_POS.latitude);
      assert.equal(mine.longitude, MX_POS.longitude);
      assert.equal(mine.duplicateOverride, true);
      assert.equal(mine.media.type, 'photo');
      assert.equal(mine.syncState, 'synced');
      assert.equal(visible('tab-cercanos'), true);
      assert.equal(visible('tab-reportar'), false);
      assert.match($('nearby-reports-list').textContent, /Bache frente a la escuela/);
      assert.equal($('input-title').value, '');
      assert.equal(app.mediaService.currentMedia, null);
    });

    test('sin conexión el reporte queda en cola y se sincroniza al reconectar', async () => {
      app.toggleOfflineSimulation();
      assert.equal($('net-label').textContent, 'Offline (prueba)');

      fillForm();
      $('chk-duplicate-override').checked = true;
      attachPhoto();
      await app.handleSubmitReport();

      assert.equal(app.syncManager.getReports()[0].syncState, 'pending');
      assert.equal($('sync-queue-badge').textContent, '1');
      assert.equal(visible('sync-queue-badge'), true);
      assert.match(toasts(), /cola Offline/);

      app.syncManager.forceOfflineMode = false;
      await app.syncManager.processSyncQueue();
      assert.equal(app.syncManager.getReports()[0].syncState, 'synced');
      assert.equal(app.syncManager.getSyncQueue().length, 0);
      assert.equal(visible('sync-queue-badge'), false);
    });

    test('foto: el botón solicita permiso de cámara, captura y muestra la vista previa', async () => {
      $('btn-capture-photo').click();
      await tick();
      assert.equal(native.state.calls.requestCam, 1);
      assert.equal(native.state.calls.getPhoto, 1);
      assert.equal(visible('media-preview-box'), true);
      assert.equal(visible('photo-preview-el'), true);
      assert.match($('media-gps-stamp').textContent, /19\.432608, -99\.133209/);

      $('btn-remove-media').click();
      assert.equal(visible('media-preview-box'), false);
    });

    test('radar continuo: activa y desactiva el seguimiento', async () => {
      $('btn-toggle-watch').click();
      await tick();
      assert.equal($('watch-label').textContent, 'Detener radar');
      assert.notEqual(app.geoService.watchId, null);
      $('btn-toggle-watch').click();
      await tick();
      assert.equal($('watch-label').textContent, 'Radar continuo');
      assert.equal(app.geoService.watchId, null);
    });

    test('la navegación inferior cambia de pestaña', () => {
      document.querySelector('[data-tab="sistema"]').click();
      assert.equal(visible('tab-sistema'), true);
      assert.equal(visible('tab-reportar'), false);
      assert.ok(document.querySelector('[data-tab="sistema"]').classList.contains('is-active'));
    });

    test('los escenarios de error simulados muestran su mensaje y acciones', () => {
      document.querySelector('[data-sim-error="TIMEOUT"]').click();
      assert.match($('error-title').textContent, /Tiempo de espera/);
      assert.equal(visible('error-alert-panel'), true);
      assert.equal(visible('btn-error-retry'), true);
      assert.equal(visible('btn-error-settings'), false);

      document.querySelector('[data-sim-error="LOCATION_DISABLED"]').click();
      assert.match($('error-title').textContent, /desactivados/);
      assert.equal(visible('btn-error-settings'), true);

      $('btn-error-settings').click();
      assert.equal(visible('modal-settings-help'), true);
      $('btn-close-settings-modal').click();
      assert.equal(visible('modal-settings-help'), false);

      $('btn-dismiss-error').click();
      assert.equal(visible('error-alert-panel'), false);
    });
  });

  describe('permiso de ubicación rechazado', () => {
    beforeEach(() => boot({ geoAfterRequest: 'denied' }));

    test('muestra el error, no inventa coordenadas y permite reintentar tras conceder', async () => {
      assert.equal(visible('error-alert-panel'), true);
      assert.match($('error-title').textContent, /Permiso de ubicación denegado/);
      assert.equal($('perm-loc-pill').textContent, 'GPS: denegado');
      assert.equal($('coord-lat').textContent, '-');
      assert.equal(app.syncManager.getReports().length, 0);

      native.state.geoAfterRequest = 'granted';
      $('btn-error-retry').click();
      await tick();
      assert.equal(visible('error-alert-panel'), false);
      assert.equal($('coord-lat').textContent, MX_POS.latitude.toFixed(6));
    });

    test('un segundo rechazo se trata como permanente y ofrece abrir Ajustes', async () => {
      $('btn-error-retry').click();
      await tick();
      assert.match($('error-title').textContent, /bloqueado/i);
      assert.equal(visible('btn-error-settings'), true);
      assert.equal($('perm-loc-pill').textContent, 'GPS: bloqueado');
    });

    test('registrar un reporte sin ubicación no crea nada', async () => {
      fillForm();
      attachPhoto();
      await app.handleSubmitReport();
      assert.equal(app.syncManager.getReports().length, 0);
    });
  });

  describe('GPS desactivado y timeout', () => {
    test('GPS apagado: error con opción de ajustes', async () => {
      await boot({ geoPermission: 'granted', positionError: { message: 'Location services are not enabled' } });
      assert.match($('error-title').textContent, /desactivados/);
      assert.equal(visible('btn-error-settings'), true);
      assert.equal($('gps-status-text').textContent.length > 0, true);
    });

    test('timeout: error con reintento y sin ajustes', async () => {
      await boot({ geoPermission: 'granted', positionError: { code: 3, message: 'timeout' } });
      assert.match($('error-title').textContent, /Tiempo de espera/);
      assert.equal(visible('btn-error-retry'), true);
      assert.equal(visible('btn-error-settings'), false);
    });
  });

  describe('cámara rechazada', () => {
    beforeEach(() => boot({ camAfterRequest: 'denied' }));

    test('muestra el error de cámara y no adjunta evidencia', async () => {
      $('btn-capture-photo').click();
      await tick();
      assert.match($('error-title').textContent, /cámara denegado/i);
      assert.equal(native.state.calls.getPhoto, 0);
      assert.equal(visible('media-preview-box'), false);
      assert.equal($('perm-cam-pill').textContent, 'Cámara: denegado');
    });
  });
});
