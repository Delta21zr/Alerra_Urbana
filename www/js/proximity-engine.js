/**
 * proximity-engine.js
 * Motor de lógica geográfica para AlertaUrbana (Reporte Ciudadano).
 * Centraliza el cálculo de distancias reales (Haversine), clasificación por anillos de proximidad,
 * detección automática de reportes duplicados dentro de un radio configurable y generación de
 * incidencias contextuales alrededor del GPS real del dispositivo.
 */

import { GeolocationService } from './geolocation.js';

export const INCIDENT_CATEGORIES = {
  bache: {
    id: 'bache',
    label: 'Bache / Hundimiento Vial',
    shortLabel: 'Bache Vial',
    priority: 'Alta'
  },
  luminaria: {
    id: 'luminaria',
    label: 'Luminaria Pública Apagada',
    shortLabel: 'Luminaria',
    priority: 'Media'
  },
  fuga_agua: {
    id: 'fuga_agua',
    label: 'Fuga de Agua / Drenaje',
    shortLabel: 'Fuga de Agua',
    priority: 'Urgente'
  },
  residuos: {
    id: 'residuos',
    label: 'Acumulación de Basura / Escombro',
    shortLabel: 'Residuos',
    priority: 'Media'
  },
  semaforo: {
    id: 'semaforo',
    label: 'Semáforo o Señalización Dañada',
    shortLabel: 'Semáforo',
    priority: 'Urgente'
  },
  arbol_riesgo: {
    id: 'arbol_riesgo',
    label: 'Árbol o Cableado en Riesgo',
    shortLabel: 'Riesgo Urbano',
    priority: 'Alta'
  }
};

export class ProximityEngine {
  constructor(defaultDuplicateRadiusMeters = 35) {
    this.duplicateRadiusMeters = defaultDuplicateRadiusMeters;
  }

  setDuplicateRadius(meters) {
    const parsed = Number(meters);
    if (!Number.isNaN(parsed) && parsed >= 10 && parsed <= 500) {
      this.duplicateRadiusMeters = parsed;
    }
  }

  /**
   * Enriquecer todos los reportes con su distancia exacta y rumbo respecto a la ubicación actual del usuario,
   * ordenados del más cercano al más lejano.
   */
  evaluateReportsProximity(reports, userPos) {
    if (!Array.isArray(reports)) return [];

    if (!userPos || typeof userPos.latitude !== 'number' || typeof userPos.longitude !== 'number') {
      return reports.map((r) => ({
        ...r,
        distanceMeters: null,
        distanceFormatted: 'Sin GPS',
        bearing: null,
        proximityZone: 'unknown',
        isWithinDuplicateRadius: false
      }));
    }

    const enriched = reports.map((report) => {
      const distanceMeters = GeolocationService.calculateDistanceMeters(
        userPos.latitude,
        userPos.longitude,
        Number(report.latitude),
        Number(report.longitude)
      );

      const bearing = GeolocationService.calculateBearing(
        userPos.latitude,
        userPos.longitude,
        Number(report.latitude),
        Number(report.longitude)
      );

      let proximityZone = 'distant';
      let proximityLabel = 'En otro sector';
      if (distanceMeters <= this.duplicateRadiusMeters) {
        proximityZone = 'immediate';
        proximityLabel = `En tu radio inmediato (≤${this.duplicateRadiusMeters}m)`;
      } else if (distanceMeters <= 250) {
        proximityZone = 'nearby';
        proximityLabel = 'En tu cuadra / muy cercano';
      } else if (distanceMeters <= 1500) {
        proximityZone = 'zone';
        proximityLabel = 'En tu zona';
      }

      return {
        ...report,
        distanceMeters,
        distanceFormatted: GeolocationService.formatDistance(distanceMeters),
        bearing,
        proximityZone,
        proximityLabel,
        isWithinDuplicateRadius: distanceMeters <= this.duplicateRadiusMeters
      };
    });

    return enriched.sort((a, b) => (a.distanceMeters ?? 999999) - (b.distanceMeters ?? 999999));
  }

  /**
   * Analiza si el reporte que el ciudadano está por levantar tiene posibles duplicados
   * dentro del radio configurado (por defecto 35 m) respecto a su ubicación actual.
   */
  checkPotentialDuplicates(reports, userPos, selectedCategory = null) {
    if (!userPos) {
      return {
        hasGps: false,
        inRadiusCount: 0,
        exactCategoryMatches: [],
        nearbyInRadius: [],
        closestReport: null
      };
    }

    const evaluated = this.evaluateReportsProximity(reports, userPos);
    const activeReports = evaluated.filter((r) => r.status !== 'resuelto');

    const nearbyInRadius = activeReports.filter(
      (r) => r.distanceMeters !== null && r.distanceMeters <= this.duplicateRadiusMeters
    );

    const exactCategoryMatches = selectedCategory
      ? nearbyInRadius.filter((r) => r.category === selectedCategory)
      : nearbyInRadius;

    return {
      hasGps: true,
      radiusMeters: this.duplicateRadiusMeters,
      inRadiusCount: nearbyInRadius.length,
      exactCategoryMatches,
      nearbyInRadius,
      closestReport: activeReports[0] || null
    };
  }

  /**
   * Desplaza una coordenada (lat, lon) una cantidad exacta de metros hacia el Norte y Este
   * para generar incidencias de demostración alrededor del GPS real del usuario.
   */
  static offsetCoordinatesByMeters(lat, lon, northMeters, eastMeters) {
    const earthRadius = 6378137;
    const dLat = northMeters / earthRadius;
    const dLon = eastMeters / (earthRadius * Math.cos((Math.PI * lat) / 180));

    const newLat = lat + (dLat * 180) / Math.PI;
    const newLon = lon + (dLon * 180) / Math.PI;
    return {
      latitude: Number(newLat.toFixed(6)),
      longitude: Number(newLon.toFixed(6))
    };
  }

  /**
   * Genera 3 incidencias ciudadanas realistas alrededor de las coordenadas GPS actuales del dispositivo
   * (a ~18 m, ~62 m y ~195 m) para demostrar la validación antiduplicados y el radar de proximidad en tiempo real.
   */
  static createContextualSeedReports(baseLat, baseLon) {
    const pos18m = ProximityEngine.offsetCoordinatesByMeters(baseLat, baseLon, 14, 11); // ~18 metros NE
    const pos62m = ProximityEngine.offsetCoordinatesByMeters(baseLat, baseLon, -48, 39); // ~62 metros SE
    const pos195m = ProximityEngine.offsetCoordinatesByMeters(baseLat, baseLon, 150, -125); // ~195 metros NO

    const now = Date.now();

    return [
      {
        id: `REP-VEC-${ String(now).slice(-4) }A`,
        category: 'bache',
        title: 'Hundimiento asfáltico en carril de circulación',
        description: 'Bache profundo de aprox. 60 cm que obliga a los vehículos a frenar bruscamente.',
        latitude: pos18m.latitude,
        longitude: pos18m.longitude,
        accuracy: 8.5,
        confirmations: 3,
        status: 'en_revision',
        syncState: 'synced',
        createdAt: new Date(now - 1000 * 60 * 42).toISOString(),
        author: 'Vecino Verificado #204',
        media: null
      },
      {
        id: `REP-VEC-${ String(now).slice(-4) }B`,
        category: 'luminaria',
        title: 'Poste de alumbrado público apagado en esquina',
        description: 'La lámpara LED parpadea y queda totalmente a oscuras durante la noche.',
        latitude: pos62m.latitude,
        longitude: pos62m.longitude,
        accuracy: 11.0,
        confirmations: 2,
        status: 'pendiente',
        syncState: 'synced',
        createdAt: new Date(now - 1000 * 60 * 165).toISOString(),
        author: 'Brigada Barrial',
        media: null
      },
      {
        id: `REP-VEC-${ String(now).slice(-4) }C`,
        category: 'fuga_agua',
        title: 'Fuga de agua potable en banqueta',
        description: 'Brote constante de agua limpia junto al registro de la acera.',
        latitude: pos195m.latitude,
        longitude: pos195m.longitude,
        accuracy: 14.2,
        confirmations: 5,
        status: 'en_atencion',
        syncState: 'synced',
        createdAt: new Date(now - 1000 * 60 * 320).toISOString(),
        author: 'Reporte Ciudadano #819',
        media: null
      }
    ];
  }
}
