// Static Leaflet page loaded into the map WebView. Uses OpenStreetMap tiles (free, no API key).
// `window.addPoint`/`window.setLive` are called from the RN side via injectJavaScript to
// incrementally update the map without reloading the whole page.
export const MAP_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; }
    .legend {
      position: absolute; bottom: 10px; left: 10px; z-index: 1000;
      background: rgba(255,255,255,0.9); padding: 6px 10px; border-radius: 8px;
      font-family: sans-serif; font-size: 11px; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    }
    .legend-bar { width: 120px; height: 10px; border-radius: 4px;
      background: linear-gradient(to right, #2b6cb0, #48bb78, #ecc94b, #e53e3e); margin: 2px 0; }
    .legend-labels { display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="legend">
    <div>Temperature</div>
    <div class="legend-bar"></div>
    <div class="legend-labels"><span>Cold</span><span>Hot</span></div>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    function reportToRN(type, message) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type, message }));
      }
    }

    window.onerror = function(message) {
      reportToRN('js-error', String(message));
    };

    if (typeof L === 'undefined') {
      reportToRN('leaflet-load-failed', 'Leaflet failed to load (no internet reaching unpkg.com CDN?)');
      document.getElementById('map').innerHTML =
        '<div style="display:flex;height:100%;align-items:center;justify-content:center;font-family:sans-serif;color:#666;padding:20px;text-align:center;">Map library failed to load. Check your internet connection.</div>';
      throw new Error('Leaflet did not load');
    }

    const map = L.map('map').setView([0, 0], 3);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const pathLatLngs = [];
    const polyline = L.polyline([], { color: '#2563EB', weight: 4, opacity: 0.7 }).addTo(map);
    let liveMarker = null;
    let hasCentered = false;

    function tempToColor(t) {
      if (t === null || t === undefined) return '#a0aec0';
      const stops = [
        [-10, [43, 108, 176]],
        [10, [72, 187, 120]],
        [25, [236, 201, 75]],
        [40, [229, 62, 62]],
      ];
      if (t <= stops[0][0]) return 'rgb(' + stops[0][1].join(',') + ')';
      if (t >= stops[stops.length - 1][0]) return 'rgb(' + stops[stops.length - 1][1].join(',') + ')';
      for (let i = 0; i < stops.length - 1; i++) {
        const [t0, c0] = stops[i];
        const [t1, c1] = stops[i + 1];
        if (t >= t0 && t <= t1) {
          const ratio = (t - t0) / (t1 - t0);
          const c = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * ratio));
          return 'rgb(' + c.join(',') + ')';
        }
      }
      return '#a0aec0';
    }

    window.addPoint = function(lat, lon, tempC, humidityPct, speedMps) {
      const latlng = [lat, lon];
      pathLatLngs.push(latlng);
      polyline.setLatLngs(pathLatLngs);

      const color = tempToColor(tempC);
      const speedKmh = speedMps !== null && speedMps !== undefined ? (speedMps * 3.6).toFixed(1) : 'n/a';
      const tempLabel = tempC !== null && tempC !== undefined ? tempC.toFixed(1) + ' C' : 'n/a';
      const humidityLabel = humidityPct !== null && humidityPct !== undefined ? humidityPct.toFixed(0) + '%' : 'n/a';

      L.circleMarker(latlng, { radius: 5, color, fillColor: color, fillOpacity: 0.85, weight: 1 })
        .bindPopup('Temp: ' + tempLabel + '<br/>Humidity: ' + humidityLabel + '<br/>Speed: ' + speedKmh + ' km/h')
        .addTo(map);

      if (!liveMarker) {
        liveMarker = L.marker(latlng).addTo(map);
      } else {
        liveMarker.setLatLng(latlng);
      }

      if (!hasCentered) {
        map.setView(latlng, 17);
        hasCentered = true;
      } else {
        map.panTo(latlng);
      }
    };

    window.fitToPath = function() {
      if (pathLatLngs.length > 0) {
        map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
      }
    };

    reportToRN('map-ready', 'ok');
    true;
  </script>
</body>
</html>
`;
