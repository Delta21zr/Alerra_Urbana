import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WWW = path.join(ROOT, 'www');

const GLOBAL_KEYS = ['window', 'document', 'localStorage', 'navigator', 'Image', 'FileReader'];

function setGlobal(key, value) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/**
 * Crea un DOM aislado (jsdom) y expone window/document/localStorage/navigator como globales,
 * que es lo que usan los módulos de www/js. Devuelve { window, teardown }.
 */
export function setupDom({ html, geolocation, capacitor } = {}) {
  const markup = html ?? '<!DOCTYPE html><html><body></body></html>';
  const dom = new JSDOM(markup, { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;

  w.HTMLElement.prototype.scrollIntoView = () => {};
  if (geolocation) {
    Object.defineProperty(w.navigator, 'geolocation', { value: geolocation, configurable: true });
  }
  if (capacitor) w.Capacitor = capacitor;

  globalThis.__ALERTA_NO_AUTOSTART__ = true;
  setGlobal('window', w);
  setGlobal('document', w.document);
  setGlobal('localStorage', w.localStorage);
  setGlobal('navigator', w.navigator);
  setGlobal('Image', w.Image);
  setGlobal('FileReader', w.FileReader);

  return {
    window: w,
    teardown() {
      w.close();
      GLOBAL_KEYS.forEach((k) => delete globalThis[k]);
    }
  };
}

export function loadIndexHtml() {
  return fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
}

export const MX_POS = { latitude: 19.432608, longitude: -99.133209 };

export function gpsReading(overrides = {}) {
  return {
    timestamp: Date.now(),
    coords: { ...MX_POS, accuracy: 8, altitude: null, speed: null, heading: null },
    ...overrides
  };
}

/**
 * Simula el entorno nativo de Capacitor con los plugins Geolocation y Camera.
 * state permite modificar el comportamiento durante la prueba.
 */
export function makeNativeCapacitor(opts = {}) {
  const state = {
    geoPermission: 'prompt',
    geoAfterRequest: 'granted',
    camPermission: 'prompt',
    camAfterRequest: 'granted',
    position: gpsReading(),
    positionError: null, // objeto de error o función (options) => error | null
    photo: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
    photoError: null,
    watchers: new Map(),
    nextWatchId: 1,
    calls: { getCurrentPosition: 0, requestGeo: 0, requestCam: 0, getPhoto: 0 },
    ...opts
  };

  const Geolocation = {
    async checkPermissions() {
      return { location: state.geoPermission, coarseLocation: state.geoPermission };
    },
    async requestPermissions() {
      state.calls.requestGeo += 1;
      state.geoPermission = state.geoAfterRequest;
      return { location: state.geoPermission, coarseLocation: state.geoPermission };
    },
    async getCurrentPosition(options) {
      state.calls.getCurrentPosition += 1;
      const err = typeof state.positionError === 'function' ? state.positionError(options) : state.positionError;
      if (err) throw err;
      return state.position;
    },
    async watchPosition(options, cb) {
      const id = String(state.nextWatchId++);
      state.watchers.set(id, cb);
      queueMicrotask(() => cb(state.position, undefined));
      return id;
    },
    async clearWatch({ id }) {
      state.watchers.delete(id);
    }
  };

  const Camera = {
    async checkPermissions() {
      return { camera: state.camPermission, photos: state.camPermission };
    },
    async requestPermissions() {
      state.calls.requestCam += 1;
      state.camPermission = state.camAfterRequest;
      return { camera: state.camPermission, photos: state.camPermission };
    },
    async getPhoto() {
      state.calls.getPhoto += 1;
      if (state.photoError) throw state.photoError;
      return state.photo;
    }
  };

  return {
    state,
    capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { Geolocation, Camera }
    }
  };
}
