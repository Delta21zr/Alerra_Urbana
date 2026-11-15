import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, makeNativeCapacitor, MX_POS } from '../helpers/env.js';
import { MediaCaptureService } from '../../www/js/media-capture.js';

describe('MediaCaptureService', () => {
  let env;
  let native;
  let svc;
  const gps = { ...MX_POS, accuracy: 8 };

  beforeEach(() => {
    native = makeNativeCapacitor();
    env = setupDom({ capacitor: native.capacitor });
    svc = new MediaCaptureService();
    // jsdom no implementa canvas: se aísla el estampado de la prueba de captura.
    svc.compressAndStampPhoto = async (d) => d;
  });
  afterEach(() => env.teardown());

  test('buildMediaRecord calcula tamaño y conserva el sello GPS', () => {
    const rec = svc.buildMediaRecord('photo', 'data:image/jpeg;base64,' + 'A'.repeat(4096), 'image/jpeg', gps);
    assert.equal(rec.type, 'photo');
    assert.equal(rec.sizeKb, 3);
    assert.deepEqual(rec.gpsSnapshot, { latitude: gps.latitude, longitude: gps.longitude, accuracy: 8 });
    assert.match(rec.fileName, /^photo_\d+\.jpg$/);
  });

  test('buildMediaRecord sin GPS deja gpsSnapshot en null', () => {
    assert.equal(svc.buildMediaRecord('video', 'data:video/mp4;base64,AAAA', 'video/mp4', null).gpsSnapshot, null);
  });

  test('capturePhoto pide permiso de cámara y devuelve el registro', async () => {
    const rec = await svc.capturePhoto('CAMERA', gps);
    assert.equal(native.state.calls.requestCam, 1);
    assert.equal(native.state.calls.getPhoto, 1);
    assert.equal(rec.type, 'photo');
    assert.equal(svc.currentMedia, rec);
    assert.equal(svc.cameraPermission, 'granted');
  });

  test('capturePhoto con permiso rechazado lanza CAMERA_PERMISSION_DENIED y no abre la cámara', async () => {
    native.state.camAfterRequest = 'denied';
    await assert.rejects(svc.capturePhoto('CAMERA', gps), (e) => e.errorType === 'CAMERA_PERMISSION_DENIED');
    assert.equal(native.state.calls.getPhoto, 0);
    assert.equal(svc.cameraPermission, 'denied');
  });

  test('cancelar la cámara devuelve { cancelled: true }', async () => {
    native.state.camPermission = 'granted';
    native.state.photoError = new Error('User cancelled photos app');
    assert.deepEqual(await svc.capturePhoto('CAMERA', gps), { cancelled: true });
    assert.equal(svc.currentMedia, null);
  });

  test('otros errores de captura se clasifican como CAPTURE_ERROR', async () => {
    native.state.camPermission = 'granted';
    native.state.photoError = new Error('fallo de hardware');
    await assert.rejects(svc.capturePhoto('CAMERA', gps), (e) => e.errorType === 'CAPTURE_ERROR');
  });

  test('checkPermissions refleja el estado nativo', async () => {
    native.state.camPermission = 'granted';
    const res = await svc.checkPermissions();
    assert.equal(res.camera, 'granted');
    assert.equal(res.source, 'capacitor-native');
  });

  test('clearMedia limpia la evidencia actual', async () => {
    await svc.capturePhoto('PHOTOS', gps);
    svc.clearMedia();
    assert.equal(svc.currentMedia, null);
  });
});
