import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, MX_POS } from '../helpers/env.js';
import { SyncManager } from '../../www/js/sync-manager.js';

const payload = (extra = {}) => ({
  category: 'bache',
  title: '  Bache profundo ',
  description: ' Frente al paso peatonal ',
  latitude: MX_POS.latitude,
  longitude: MX_POS.longitude,
  accuracy: 8,
  media: { type: 'photo', dataUrl: 'data:image/jpeg;base64,AAAA' },
  ...extra
});

describe('SyncManager', () => {
  let env;
  let changes;
  let sm;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    env = setupDom();
    changes = [];
    sm = new SyncManager((s) => changes.push(s));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    env.teardown();
  });

  test('online: crea el reporte, lo sincroniza y deja la cola vacía', async () => {
    const r = await sm.createReport(payload());
    assert.equal(r.syncState, 'synced');
    assert.equal(r.title, 'Bache profundo');
    assert.equal(r.description, 'Frente al paso peatonal');
    assert.equal(sm.getSyncQueue().length, 0);
    assert.equal(sm.getReports().length, 1);
  });

  test('offline: el reporte queda pendiente y encolado', async () => {
    sm.setForceOfflineMode(true);
    const r = await sm.createReport(payload());
    assert.equal(r.syncState, 'pending');
    assert.equal(sm.getSyncQueue().length, 1);
    assert.equal(sm.getSyncQueue()[0].action, 'CREATE_REPORT');
    assert.equal(changes.at(-1).online, false);
    assert.equal(changes.at(-1).pendingCount, 1);
  });

  test('al volver la conexión la cola se sincroniza', async () => {
    sm.setForceOfflineMode(true);
    await sm.createReport(payload());
    sm.forceOfflineMode = false;
    const res = await sm.processSyncQueue();
    assert.equal(res.syncedCount, 1);
    assert.equal(sm.getSyncQueue().length, 0);
    assert.equal(sm.getReports()[0].syncState, 'synced');
  });

  test('processSyncQueue no hace nada estando offline', async () => {
    sm.setForceOfflineMode(true);
    await sm.createReport(payload());
    const res = await sm.processSyncQueue();
    assert.equal(res.syncedCount, 0);
    assert.equal(sm.getSyncQueue().length, 1);
  });

  test('con apiEndpoint, un error HTTP mantiene el item en la cola', async () => {
    sm.apiEndpoint = 'http://api.test/reportes';
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const r = await sm.createReport(payload());
    assert.equal(r.syncState, 'error');
    assert.equal(sm.getSyncQueue().length, 1);

    let body;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200 };
    };
    const res = await sm.processSyncQueue();
    assert.equal(res.syncedCount, 1);
    assert.equal(body.action, 'CREATE_REPORT');
    assert.equal(sm.getSyncQueue().length, 0);
  });

  test('confirmNearbyReport suma +1 y registra la distancia', async () => {
    const created = await sm.createReport(payload());
    const updated = await sm.confirmNearbyReport(created.id, MX_POS, 12);
    assert.equal(updated.confirmations, 2);
    assert.equal(updated.verifiedByUserAtMeters, 12);
    assert.equal(sm.confirmNearbyReport('NO-EXISTE', MX_POS, 1) instanceof Promise, true);
    assert.equal(await sm.confirmNearbyReport('NO-EXISTE', MX_POS, 1), null);
  });

  test('confirmar estando offline encola CONFIRM_REPORT', async () => {
    const created = await sm.createReport(payload());
    sm.setForceOfflineMode(true);
    await sm.confirmNearbyReport(created.id, MX_POS, 20);
    assert.equal(sm.getSyncQueue().at(-1).action, 'CONFIRM_REPORT');
  });

  test('deleteReport elimina el reporte y su cola', async () => {
    sm.setForceOfflineMode(true);
    const r = await sm.createReport(payload());
    sm.deleteReport(r.id);
    assert.equal(sm.getReports().length, 0);
    assert.equal(sm.getSyncQueue().length, 0);
  });

  test('seedReportsAroundUser no duplica semillas salvo que se pida reemplazar', () => {
    const seeds = [{ id: 'REP-VEC-1' }, { id: 'REP-VEC-2' }];
    sm.seedReportsAroundUser(seeds, false);
    sm.seedReportsAroundUser(seeds, false);
    assert.equal(sm.getReports().length, 2);
    sm.seedReportsAroundUser([{ id: 'REP-VEC-9' }], true);
    assert.deepEqual(sm.getReports().map((r) => r.id), ['REP-VEC-9']);
    assert.equal(sm.hasInitialSeeds(), true);
  });

  test('la configuración de modo offline persiste en localStorage', () => {
    sm.setForceOfflineMode(true);
    const again = new SyncManager();
    assert.equal(again.forceOfflineMode, true);
    assert.equal(again.isOnline(), false);
  });

  test('lectura de reportes corruptos devuelve lista vacía', () => {
    localStorage.setItem('alerta_urbana_reports_v1', '{no es json');
    assert.deepEqual(sm.getReports(), []);
  });
});
