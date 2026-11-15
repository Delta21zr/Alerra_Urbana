import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, makeNativeCapacitor, gpsReading, MX_POS } from '../helpers/env.js';
import { GeolocationService } from '../../www/js/geolocation.js';

describe('GeolocationService - cálculos geodésicos', () => {
  test('distancia entre el mismo punto es 0', () => {
    assert.equal(GeolocationService.calculateDistanceMeters(19.4, -99.1, 19.4, -99.1), 0);
  });

  test('1 grado de latitud equivale a ~111.2 km', () => {
    const d = GeolocationService.calculateDistanceMeters(0, 0, 1, 0);
    assert.ok(Math.abs(d - 111195) < 300, `distancia inesperada: ${d}`);
  });

  test('distancia es simétrica', () => {
    const a = GeolocationService.calculateDistanceMeters(19.43, -99.13, 19.44, -99.14);
    const b = GeolocationService.calculateDistanceMeters(19.44, -99.14, 19.43, -99.13);
    assert.equal(a, b);
  });

  test('rumbo hacia el norte, este, sur y oeste', () => {
    assert.equal(GeolocationService.calculateBearing(0, 0, 1, 0).cardinal, 'N');
    assert.equal(GeolocationService.calculateBearing(0, 0, 0, 1).cardinal, 'E');
    assert.equal(GeolocationService.calculateBearing(0, 0, -1, 0).cardinal, 'S');
    assert.equal(GeolocationService.calculateBearing(0, 0, 0, -1).cardinal, 'O');
  });

  test('formatDistance usa metros y kilómetros', () => {
    assert.equal(GeolocationService.formatDistance(24), '24 m');
    assert.equal(GeolocationService.formatDistance(1350), '1.35 km');
    assert.equal(GeolocationService.formatDistance(null), '—');
  });

  test('getMapsUrl incluye coordenadas con 6 decimales', () => {
    const url = GeolocationService.getMapsUrl(19.4326081, -99.1332091);
    assert.match(url, /query=19\.432608,-99\.133209$/);
  });
});

describe('GeolocationService - normalizePosition', () => {
  const svc = new GeolocationService();
  const make = (accuracy) => svc.normalizePosition({ timestamp: 1, coords: { ...MX_POS, accuracy } });

  test('clasifica la calidad por precisión', () => {
    assert.equal(make(10).qualityLevel, 'excellent');
    assert.equal(make(30).qualityLevel, 'good');
    assert.equal(make(100).qualityLevel, 'moderate');
    assert.equal(make(300).qualityLevel, 'low');
    assert.equal(make(undefined).qualityLevel, 'unknown');
  });

  test('convierte velocidad de m/s a km/h y descarta valores inválidos', () => {
    const p = svc.normalizePosition({ coords: { ...MX_POS, accuracy: 5, speed: 10, heading: NaN } });
    assert.equal(p.speed, 36);
    assert.equal(p.heading, null);
  });

  test('acepta coordenadas planas sin objeto coords', () => {
    const p = svc.normalizePosition({ latitude: 1, longitude: 2, accuracy: 4 });
    assert.equal(p.latitude, 1);
    assert.equal(p.longitude, 2);
  });
});

describe('GeolocationService - classifyError', () => {
  const cases = [
    [{ code: 'UNSUPPORTED' }, 'UNSUPPORTED', { canRetry: false, needsSettings: false }],
    [{ code: 1, message: 'User denied Geolocation' }, 'PERMISSION_DENIED', { canRetry: true, needsSettings: false }],
    [{ code: 'PERMISSION_DENIED_PERMANENTLY', message: 'x' }, 'PERMISSION_DENIED_PERMANENTLY', { canRetry: true, needsSettings: true }],
    [{ message: 'Location services are not enabled' }, 'LOCATION_DISABLED', { canRetry: true, needsSettings: true }],
    [{ code: 2, message: 'POSITION_UNAVAILABLE' }, 'LOCATION_DISABLED', { canRetry: true, needsSettings: true }],
    [{ code: 3, message: 'Timeout expired' }, 'TIMEOUT', { canRetry: true, needsSettings: false }],
    [{ message: 'algo raro' }, 'UNKNOWN', { canRetry: true, needsSettings: true }]
  ];

  for (const [input, type, flags] of cases) {
    test(`${JSON.stringify(input)} -> ${type}`, () => {
      const c = new GeolocationService().classifyError(input);
      assert.equal(c.errorType, type);
      assert.equal(c.canRetry, flags.canRetry);
      assert.equal(c.needsSettings, flags.needsSettings);
      assert.ok(c.title && c.message && c.suggestion, 'debe incluir título, mensaje y sugerencia');
    });
  }

  test('segundo rechazo en la misma sesión se vuelve permanente', () => {
    const svc = new GeolocationService();
    assert.equal(svc.classifyError({ code: 1 }).errorType, 'PERMISSION_DENIED');
    assert.equal(svc.classifyError({ code: 1 }).errorType, 'PERMISSION_DENIED_PERMANENTLY');
    assert.equal(svc.permissionState, 'denied_permanently');
  });
});

describe('GeolocationService - flujos con plugin nativo (mock)', () => {
  let env;
  let native;
  beforeEach(() => {
    native = makeNativeCapacitor();
    env = setupDom({ capacitor: native.capacitor });
  });
  afterEach(() => env.teardown());

  test('requestPermissions concede y actualiza el estado', async () => {
    const svc = new GeolocationService();
    const res = await svc.requestPermissions();
    assert.equal(res.granted, true);
    assert.equal(svc.permissionState, 'granted');
  });

  test('requestPermissions denegado una vez -> denied; segunda vez -> denied_permanently', async () => {
    native.state.geoAfterRequest = 'denied';
    const svc = new GeolocationService();
    const first = await svc.requestPermissions();
    assert.equal(first.granted, false);
    assert.equal(first.state, 'denied');
    const second = await svc.requestPermissions();
    assert.equal(second.state, 'denied_permanently');
    assert.equal(second.error.needsSettings, true);
  });

  test('getCurrentPosition pide permiso si hace falta y devuelve coordenadas reales', async () => {
    const svc = new GeolocationService();
    const pos = await svc.getCurrentPosition();
    assert.equal(native.state.calls.requestGeo, 1);
    assert.equal(pos.latitude, MX_POS.latitude);
    assert.equal(pos.longitude, MX_POS.longitude);
    assert.equal(svc.gpsStatus, 'active');
  });

  test('getCurrentPosition lanza error clasificado si el permiso es rechazado', async () => {
    native.state.geoAfterRequest = 'denied';
    const svc = new GeolocationService();
    await assert.rejects(svc.getCurrentPosition(), (e) => e.errorType === 'PERMISSION_DENIED');
    assert.equal(svc.gpsStatus, 'error');
  });

  test('GPS apagado se reporta como LOCATION_DISABLED', async () => {
    native.state.geoPermission = 'granted';
    native.state.positionError = { message: 'Location services are not enabled' };
    await assert.rejects(new GeolocationService().getCurrentPosition(), (e) => e.errorType === 'LOCATION_DISABLED');
  });

  test('timeout en alta precisión reintenta con precisión balanceada', async () => {
    native.state.geoPermission = 'granted';
    native.state.positionError = (opts) => (opts.enableHighAccuracy ? { code: 3, message: 'timeout' } : null);
    const pos = await new GeolocationService().getCurrentPosition();
    assert.equal(native.state.calls.getCurrentPosition, 2);
    assert.equal(pos.latitude, MX_POS.latitude);
  });

  test('timeout persistente se reporta como TIMEOUT (no UNKNOWN)', async () => {
    native.state.geoPermission = 'granted';
    native.state.positionError = { code: 3, message: 'timeout' };
    await assert.rejects(new GeolocationService().getCurrentPosition(), (e) => e.errorType === 'TIMEOUT');
  });

  test('startWatch entrega posiciones y stopWatch libera el watcher', async () => {
    native.state.geoPermission = 'granted';
    const svc = new GeolocationService();
    const received = [];
    const id = await svc.startWatch((p) => received.push(p), () => {});
    await new Promise((r) => setTimeout(r, 5));
    assert.notEqual(id, null);
    assert.equal(received.length, 1);
    assert.equal(svc.gpsStatus, 'watching');
    await svc.stopWatch();
    assert.equal(svc.watchId, null);
    assert.equal(native.state.watchers.size, 0);
  });
});

describe('GeolocationService - fallback web', () => {
  let env;
  afterEach(() => env?.teardown());

  test('usa navigator.geolocation cuando no hay Capacitor', async () => {
    env = setupDom({
      geolocation: { getCurrentPosition: (ok) => ok(gpsReading()), watchPosition: () => 1, clearWatch: () => {} }
    });
    const pos = await new GeolocationService().getCurrentPosition();
    assert.equal(pos.source, 'web-gps');
    assert.equal(pos.latitude, MX_POS.latitude);
  });

  test('traduce PERMISSION_DENIED del navegador', async () => {
    env = setupDom({
      geolocation: { getCurrentPosition: (_ok, err) => err({ code: 1, message: 'User denied Geolocation' }) }
    });
    await assert.rejects(new GeolocationService().getCurrentPosition(), (e) => e.errorType === 'PERMISSION_DENIED');
  });

  test('sin soporte de geolocalización devuelve UNSUPPORTED', async () => {
    env = setupDom();
    delete env.window.navigator.geolocation;
    await assert.rejects(new GeolocationService().getCurrentPosition(), (e) => e.errorType === 'UNSUPPORTED');
  });
});
