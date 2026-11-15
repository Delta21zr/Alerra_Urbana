import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WWW, setupDom, loadIndexHtml, gpsReading } from '../helpers/env.js';

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('Smoke: estructura del proyecto', () => {
  test('existen los archivos esenciales', () => {
    for (const f of [
      'www/index.html', 'www/css/styles.css',
      'www/js/app.js', 'www/js/geolocation.js', 'www/js/media-capture.js',
      'www/js/proximity-engine.js', 'www/js/sync-manager.js',
      'capacitor.config.json', 'package.json', 'android/app/src/main/AndroidManifest.xml'
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `falta ${f}`);
    }
  });

  test('index.html referencia scripts y estilos que existen', () => {
    const html = loadIndexHtml();
    for (const m of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(WWW, m[1])), `recurso inexistente: ${m[1]}`);
    }
  });

  test('capacitor.config.json apunta a www y define appId', () => {
    const cfg = JSON.parse(read('capacitor.config.json'));
    assert.equal(cfg.webDir, 'www');
    assert.match(cfg.appId, /^[a-z]+(\.[a-z0-9]+)+$/);
  });

  test('dependencias de Capacitor en versión 8 con plugins de geolocalización y cámara', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ['@capacitor/core', '@capacitor/cli', '@capacitor/android', '@capacitor/geolocation', '@capacitor/camera']) {
      assert.ok(deps[name], `falta ${name}`);
      assert.match(deps[name], /^\^?8\./, `${name} debe ser 8.x`);
    }
  });
});

describe('Smoke: AndroidManifest', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const perm = (name) => manifest.match(new RegExp(`<uses-permission[^>]*${name}[^>]*>`));

  test('ubicación fina y aproximada sin maxSdkVersion', () => {
    for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
      const m = perm(p);
      assert.ok(m, `falta ${p}`);
      assert.doesNotMatch(m[0], /maxSdkVersion/);
    }
  });

  test('permisos de cámara, micrófono, internet y medios', () => {
    for (const p of ['CAMERA', 'RECORD_AUDIO', 'INTERNET', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO']) {
      assert.ok(perm(`android.permission.${p}`), `falta ${p}`);
    }
  });

  test('actividad principal exportada y FileProvider declarado', () => {
    assert.match(manifest, /android:exported="true"/);
    assert.match(manifest, /androidx\.core\.content\.FileProvider/);
  });
});

describe('Smoke: calidad del código web', () => {
  test('ningún archivo de www contiene emojis', () => {
    const emoji = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]/u;
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const f of walk(WWW).filter((x) => /\.(js|html|css)$/.test(x))) {
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => assert.doesNotMatch(l, emoji, `${path.relative(ROOT, f)}:${i + 1}`));
    }
  });

  test('todos los ids usados por app.js existen en index.html', () => {
    const html = loadIndexHtml();
    const js = read('www/js/app.js');
    const ids = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
  });

  test('los selectores por clase y data-attribute de app.js existen en el HTML', () => {
    const html = loadIndexHtml();
    const js = read('www/js/app.js');
    for (const m of js.matchAll(/querySelectorAll\('\.(radius-btn|nav-tab-btn|sim-error-btn)'\)/g)) {
      assert.ok(html.includes(m[1]), `no hay elementos .${m[1]} en el HTML`);
    }
  });

  test('módulos ES sin errores de sintaxis ni dependencias rotas', async () => {
    const env = setupDom();
    try {
      for (const f of ['geolocation', 'media-capture', 'proximity-engine', 'sync-manager', 'app']) {
        const mod = await import(`../../www/js/${f}.js`);
        assert.ok(Object.keys(mod).length > 0, `${f}.js no exporta nada`);
      }
    } finally {
      env.teardown();
    }
  });
});

describe('Smoke: arranque de la app en navegador (sin Capacitor)', () => {
  let env;
  afterEach(() => env?.teardown());

  test('inicia sin errores, renderiza categorías y obtiene coordenadas', async () => {
    env = setupDom({
      html: loadIndexHtml(),
      geolocation: { getCurrentPosition: (ok) => ok(gpsReading()), watchPosition: () => 1, clearWatch: () => {} }
    });
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      const { AlertaUrbanaApp } = await import('../../www/js/app.js');
      const app = new AlertaUrbanaApp();
      await app.init();
    } finally {
      console.error = origError;
    }

    assert.deepEqual(errors, []);
    assert.equal(document.querySelectorAll('#category-grid .cat-btn').length, 6);
    assert.equal(document.getElementById('coord-lat').textContent, '19.432608');
    assert.equal(document.getElementById('platform-badge').textContent, 'web');
    assert.equal(document.getElementById('tab-reportar').classList.contains('hidden'), false);
  });
});
