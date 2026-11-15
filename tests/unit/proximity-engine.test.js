import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GeolocationService } from '../../www/js/geolocation.js';
import { ProximityEngine, INCIDENT_CATEGORIES } from '../../www/js/proximity-engine.js';
import { MX_POS } from '../helpers/env.js';

const at = (north, east, extra = {}) => ({
  id: `R-${north}-${east}`,
  category: 'bache',
  status: 'pendiente',
  title: 't',
  ...ProximityEngine.offsetCoordinatesByMeters(MX_POS.latitude, MX_POS.longitude, north, east),
  ...extra
});

describe('ProximityEngine', () => {
  test('offsetCoordinatesByMeters desplaza la distancia pedida', () => {
    const p = ProximityEngine.offsetCoordinatesByMeters(MX_POS.latitude, MX_POS.longitude, 100, 0);
    const d = GeolocationService.calculateDistanceMeters(MX_POS.latitude, MX_POS.longitude, p.latitude, p.longitude);
    assert.ok(Math.abs(d - 100) <= 1, `distancia ${d}`);
  });

  test('evaluateReportsProximity ordena del más cercano al más lejano', () => {
    const e = new ProximityEngine(35);
    const out = e.evaluateReportsProximity([at(195, 0), at(18, 0), at(62, 0)], MX_POS);
    const d = out.map((r) => r.distanceMeters);
    assert.deepEqual(d, [...d].sort((a, b) => a - b));
    assert.equal(out[0].isWithinDuplicateRadius, true);
    assert.equal(out[0].proximityZone, 'immediate');
    assert.equal(out[1].proximityZone, 'nearby');
  });

  test('sin GPS no calcula distancias', () => {
    const out = new ProximityEngine().evaluateReportsProximity([at(10, 0)], null);
    assert.equal(out[0].distanceMeters, null);
    assert.equal(out[0].distanceFormatted, 'Sin GPS');
  });

  test('checkPotentialDuplicates respeta el radio configurado', () => {
    const reports = [at(18, 0), at(62, 0)];
    const e = new ProximityEngine(35);
    assert.equal(e.checkPotentialDuplicates(reports, MX_POS).inRadiusCount, 1);
    e.setDuplicateRadius(100);
    assert.equal(e.checkPotentialDuplicates(reports, MX_POS).inRadiusCount, 2);
  });

  test('ignora reportes resueltos como posibles duplicados', () => {
    const e = new ProximityEngine(35);
    const r = e.checkPotentialDuplicates([at(10, 0, { status: 'resuelto' })], MX_POS);
    assert.equal(r.inRadiusCount, 0);
  });

  test('distingue coincidencias de la misma categoría', () => {
    const e = new ProximityEngine(35);
    const reports = [at(10, 0, { category: 'luminaria' }), at(15, 0, { category: 'bache' })];
    const r = e.checkPotentialDuplicates(reports, MX_POS, 'bache');
    assert.equal(r.nearbyInRadius.length, 2);
    assert.equal(r.exactCategoryMatches.length, 1);
  });

  test('checkPotentialDuplicates sin GPS indica hasGps=false', () => {
    assert.equal(new ProximityEngine().checkPotentialDuplicates([at(5, 0)], null).hasGps, false);
  });

  test('setDuplicateRadius ignora valores fuera de 10-500 m', () => {
    const e = new ProximityEngine(35);
    e.setDuplicateRadius(5);
    e.setDuplicateRadius(900);
    e.setDuplicateRadius('abc');
    assert.equal(e.duplicateRadiusMeters, 35);
    e.setDuplicateRadius(50);
    assert.equal(e.duplicateRadiusMeters, 50);
  });

  test('createContextualSeedReports genera 3 reportes a ~18, ~62 y ~195 m', () => {
    const seeds = ProximityEngine.createContextualSeedReports(MX_POS.latitude, MX_POS.longitude);
    assert.equal(seeds.length, 3);
    const d = seeds.map((s) => GeolocationService.calculateDistanceMeters(MX_POS.latitude, MX_POS.longitude, s.latitude, s.longitude));
    assert.ok(Math.abs(d[0] - 18) <= 2);
    assert.ok(Math.abs(d[1] - 62) <= 3);
    assert.ok(Math.abs(d[2] - 195) <= 5);
    assert.ok(seeds.every((s) => s.id.startsWith('REP-VEC-')));
  });

  test('todas las categorías tienen id, etiqueta y prioridad', () => {
    for (const c of Object.values(INCIDENT_CATEGORIES)) {
      assert.ok(c.id && c.label && c.shortLabel && c.priority);
    }
  });
});
