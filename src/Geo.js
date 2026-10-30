/**
 * Geofence and Presence Confidence (FR-07, FR-12, FR-13, FR-16; SRS §4.2–4.3).
 *
 * Pure functions: coordinates come in, a verdict goes out. Callers must not store or
 * log the coordinates; only the verdict, the reasons and a distance scalar leave here.
 */
var Geo = {
  EARTH_RADIUS_M: 6371008.8,

  haversine: function (lat1, lng1, lat2, lng2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLng = (lng2 - lng1) * rad;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * Geo.EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  },

  /** Metres east (x) and north (y) of an origin. Equirectangular: well under 1 % error across a building. */
  toXY: function (lat, lng, lat0, lng0) {
    var rad = Math.PI / 180;
    return { x: (lng - lng0) * rad * Geo.EARTH_RADIUS_M * Math.cos(lat0 * rad), y: (lat - lat0) * rad * Geo.EARTH_RADIUS_M };
  },

  polygonXY: function (lab) {
    return lab.boundary.map(function (p) { return Geo.toXY(p[0], p[1], lab.lat, lab.lng); });
  },

  /** Ray casting: is the point inside the polygon? */
  insidePolygon: function (pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  },

  /** Shortest distance (m) from the point to any edge of the polygon. */
  edgeDistance: function (pt, poly) {
    var best = Infinity;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[j], b = poly[i];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
      var ex = a.x + t * dx - pt.x, ey = a.y + t * dy - pt.y;
      best = Math.min(best, Math.sqrt(ex * ex + ey * ey));
    }
    return best;
  },

  /** Area in m² (shoelace formula). */
  areaM2: function (poly) {
    var s = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    return Math.abs(s / 2);
  },

  /**
   * Where a fix sits against the lab's virtual boundary: the drawn outline of the room when
   * there is one, otherwise the circle (radius around the centre).
   * @return {inside, outside_m (0 when inside), shape: 'polygon' | 'circle', centre_m}
   */
  place: function (lab, lat, lng) {
    var centre = Geo.haversine(lat, lng, lab.lat, lab.lng);
    if (lab.boundary && lab.boundary.length >= 3) {
      var pt = Geo.toXY(lat, lng, lab.lat, lab.lng);
      var poly = Geo.polygonXY(lab);
      var inside = Geo.insidePolygon(pt, poly);
      return { inside: inside, outside_m: inside ? 0 : Geo.edgeDistance(pt, poly), shape: 'polygon', centre_m: centre };
    }
    return { inside: centre <= lab.radius_m, outside_m: Math.max(0, centre - lab.radius_m), shape: 'circle', centre_m: centre };
  },

  /**
   * Lower bound on how far someone moved between two fixes, knowing only each fix's
   * distance from a lab centre (no stored coordinates needed):
   *   same lab:       |d1 − d2|                 (reverse triangle inequality)
   *   different labs: dist(L1, L2) − d1 − d2
   */
  travelLowerBound: function (prevLab, prevDist, lab, dist) {
    if (prevLab.lab_id === lab.lab_id) return Math.abs(prevDist - dist);
    return Math.max(0, Geo.haversine(prevLab.lat, prevLab.lng, lab.lat, lab.lng) - prevDist - dist);
  },

  /**
   * @param lab      lab settings
   * @param loc      {lat, lng, accuracy, mock, posAgeMs} as reported by the phone
   * @param prev     {labId, d, t} from the user's previous attempt, or null
   * @param prevLab  settings of prev.labId, or null
   * @param nowMs    server time
   * @return {level: GREEN|AMBER|RED, inside: bool, distance: metres, reasons: [string]}
   */
  evaluate: function (lab, loc, prev, prevLab, nowMs) {
    var red = [];
    var amber = [];
    var lat = Number(loc.lat);
    var lng = Number(loc.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      return { level: STATUS.CONF.RED, inside: false, distance: Infinity, reasons: ['Location data was missing or invalid'] };
    }
    var acc = Number(loc.accuracy);
    var accKnown = isFinite(acc) && acc >= 0;

    // Step 6: inside the virtual boundary (drawn outline, or the circle when none is drawn)?
    var place = Geo.place(lab, lat, lng);
    var d = place.centre_m;
    var inside = place.inside;
    if (!inside) {
      var margin = Math.min(accKnown ? acc : 0, lab.amber_margin_m);
      var near = place.outside_m <= margin;
      if (place.shape === 'polygon') {
        if (near) amber.push('Just outside the lab boundary (' + Math.round(place.outside_m) + ' m), within GPS uncertainty');
        else red.push('Outside the lab: about ' + Math.round(place.outside_m) + ' m outside the lab boundary');
      } else if (near) amber.push('Just outside the lab radius (' + Math.round(d) + ' m), within GPS uncertainty');
      else red.push('Outside the lab: about ' + Math.round(d) + ' m from the lab centre');
    }

    // Step 7: accuracy must be reasonable for the radius.
    if (!accKnown) amber.push('Phone did not report GPS accuracy');
    else if (acc > lab.accuracy_limit_m) amber.push('Poor GPS accuracy (±' + Math.round(acc) + ' m)');
    else if (acc === 0) amber.push('Implausible GPS accuracy (0 m)');

    // Step 8: travel speed since the previous attempt.
    if (prev && prevLab && isFinite(prev.d) && nowMs > prev.t) {
      var metres = Geo.travelLowerBound(prevLab, prev.d, lab, d);
      var hours = (nowMs - prev.t) / 3600000;
      var kmh = metres / 1000 / hours;
      if (metres >= 1000 && kmh > lab.speed_block_kmh) {
        red.push('Impossible travel: ' + Math.round(metres) + ' m in ' + U.durationText(nowMs - prev.t));
      } else if (metres >= 150 && kmh > lab.speed_flag_kmh) {
        amber.push('Unusual travel speed (~' + Math.round(kmh) + ' km/h since the last attempt)');
      }
    }

    // Step 9: mock-location signal, only where the browser exposes one.
    // A missing signal is not treated as proof of honesty; it simply adds nothing.
    if (loc.mock === true) red.push('Mock location detected on the device');

    var age = Number(loc.posAgeMs);
    if (isFinite(age) && age > 120000) amber.push('Location fix was more than 2 minutes old');

    var level = red.length ? STATUS.CONF.RED : amber.length ? STATUS.CONF.AMBER : STATUS.CONF.GREEN;
    return { level: level, inside: inside, distance: d, outside_m: place.outside_m, reasons: red.concat(amber) };
  }
};
