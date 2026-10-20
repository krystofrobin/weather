// Weather — a small, ad-free forecast + radar app.
// Forecast data: DWD ICON (via Open-Meteo). Radar: RainViewer (Europe/world) or DWD (Germany).

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const RAINVIEWER_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const DWD_WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';

const REFRESH_AFTER_MS = 10 * 60 * 1000;
const GPS_ID = 'gps';

// ---------- storage ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const state = {
  places: store.get('places', []),
  selected: store.get('selected', GPS_ID),
  gps: store.get('gps', null), // {lat, lon, name}
  settings: { model: 'icon_seamless', windUnit: 'kmh', ...store.get('settings', {}) },
  forecast: null,
  fetchedAt: 0,
  view: 'forecast',
};

// ---------- weather codes ----------

// WMO weather interpretation codes -> label, day icon, night icon, sky theme
const WMO = {
  0: ['Clear', '☀️', '🌙', 'clear'],
  1: ['Mostly clear', '🌤️', '🌙', 'clear'],
  2: ['Partly cloudy', '⛅', '☁️', 'cloudy'],
  3: ['Overcast', '☁️', '☁️', 'cloudy'],
  45: ['Fog', '🌫️', '🌫️', 'fog'],
  48: ['Freezing fog', '🌫️', '🌫️', 'fog'],
  51: ['Light drizzle', '🌦️', '🌧️', 'rain'],
  53: ['Drizzle', '🌦️', '🌧️', 'rain'],
  55: ['Heavy drizzle', '🌧️', '🌧️', 'rain'],
  56: ['Freezing drizzle', '🌧️', '🌧️', 'rain'],
  57: ['Freezing drizzle', '🌧️', '🌧️', 'rain'],
  61: ['Light rain', '🌦️', '🌧️', 'rain'],
  63: ['Rain', '🌧️', '🌧️', 'rain'],
  65: ['Heavy rain', '🌧️', '🌧️', 'rain'],
  66: ['Freezing rain', '🌧️', '🌧️', 'rain'],
  67: ['Freezing rain', '🌧️', '🌧️', 'rain'],
  71: ['Light snow', '🌨️', '🌨️', 'snow'],
  73: ['Snow', '🌨️', '🌨️', 'snow'],
  75: ['Heavy snow', '❄️', '❄️', 'snow'],
  77: ['Snow grains', '🌨️', '🌨️', 'snow'],
  80: ['Light showers', '🌦️', '🌧️', 'rain'],
  81: ['Showers', '🌧️', '🌧️', 'rain'],
  82: ['Heavy showers', '⛈️', '⛈️', 'storm'],
  85: ['Snow showers', '🌨️', '🌨️', 'snow'],
  86: ['Heavy snow showers', '❄️', '❄️', 'snow'],
  95: ['Thunderstorm', '⛈️', '⛈️', 'storm'],
  96: ['Thunderstorm, hail', '⛈️', '⛈️', 'storm'],
  99: ['Thunderstorm, hail', '⛈️', '⛈️', 'storm'],
};

const wmo = (code) => WMO[code] || ['—', '🌡️', '🌡️', 'cloudy'];
const wxLabel = (code) => wmo(code)[0];
const wxIcon = (code, isDay = 1) => wmo(code)[isDay ? 1 : 2];
const wxSky = (code, isDay = 1) => `${wmo(code)[3]}-${isDay ? 'day' : 'night'}`;

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => (n == null || Number.isNaN(n) ? '–' : Math.round(n));
const deg = (n) => `${round(n)}°`;

// Open-Meteo returns local wall-clock times ("2026-10-20T14:00") for the place's timezone.
// We treat them as UTC internally so formatting is independent of the device timezone.
const parseLocal = (t) => new Date(`${t}${t.length === 10 ? 'T00:00' : ''}Z`);
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function placeNow(fc) {
  return new Date(Date.now() + fc.utc_offset_seconds * 1000);
}

function windValue(kmh) {
  const unit = state.settings.windUnit;
  if (kmh == null) return { v: '–', u: '' };
  if (unit === 'ms') return { v: (kmh / 3.6).toFixed(kmh < 36 ? 1 : 0), u: 'm/s' };
  if (unit === 'bft') {
    const ms = kmh / 3.6;
    const limits = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    const b = limits.findIndex((l) => ms < l);
    return { v: b === -1 ? 12 : b, u: 'Bft' };
  }
  return { v: Math.round(kmh), u: 'km/h' };
}
const windText = (kmh) => {
  const w = windValue(kmh);
  return `${w.v} ${w.u}`;
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compassName = (d) => (d == null ? '' : COMPASS[Math.round(d / 45) % 8]);

// ---------- API ----------

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let reason = `${res.status}`;
    try { reason = (await res.json()).reason || reason; } catch { /* not JSON */ }
    throw new Error(reason);
  }
  return res.json();
}

const CURRENT_VARS = 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
const HOURLY_VARS = 'temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,uv_index,visibility';
const DAILY_VARS = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_hours,sunrise,sunset,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max';

function forecastUrl(lat, lon, model, withMinutely) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: CURRENT_VARS,
    hourly: HOURLY_VARS,
    daily: DAILY_VARS,
    timezone: 'auto',
    forecast_days: '10',
    wind_speed_unit: 'kmh',
  });
  if (model && model !== 'best_match') p.set('models', model);
  if (withMinutely) {
    p.set('minutely_15', 'precipitation');
    p.set('past_minutely_15', '1');
    p.set('forecast_minutely_15', '12');
  }
  return `${FORECAST_URL}?${p}`;
}

// Fill gaps (nulls, or variables a model doesn't provide) in `primary` from `fallback`, matched by timestamp.
function fillGaps(primary, fallback, section) {
  const a = primary[section];
  const b = fallback?.[section];
  if (!a || !b) return;
  const idx = new Map(b.time.map((t, i) => [t, i]));
  for (const key of Object.keys(b)) {
    if (key === 'time') continue;
    if (!a[key]) a[key] = new Array(a.time.length).fill(null);
    a[key] = a.time.map((t, i) => {
      const v = a[key][i];
      if (v != null) return v;
      const j = idx.get(t);
      return j == null ? null : b[key][j];
    });
  }
}

async function fetchForecast(lat, lon, model) {
  const primaryP = getJSON(forecastUrl(lat, lon, model, true));
  // A second "best match" request supplies precipitation probability (ensemble-based), UV index
  // and the days beyond the ICON model range (~7.5 days).
  const fallbackP = model === 'best_match' ? Promise.resolve(null) : getJSON(forecastUrl(lat, lon, 'best_match', false)).catch(() => null);
  const [fc, fb] = await Promise.all([primaryP, fallbackP]);
  if (fb) {
    fillGaps(fc, fb, 'hourly');
    fillGaps(fc, fb, 'daily');
    if (fc.current && fb.current) {
      for (const [k, v] of Object.entries(fb.current)) if (fc.current[k] == null) fc.current[k] = v;
    }
  }
  return fc;
}

async function reverseGeocode(lat, lon) {
  try {
    const p = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: 'en' });
    const r = await getJSON(`${REVERSE_URL}?${p}`);
    return r.locality || r.city || r.principalSubdivision || null;
  } catch {
    return null;
  }
}

async function searchPlaces(q) {
  const p = new URLSearchParams({ name: q, count: '8', language: 'en', format: 'json' });
  const r = await getJSON(`${GEOCODE_URL}?${p}`);
  return (r.results || []).map((x) => ({
    id: String(x.id),
    name: x.name,
    admin: x.admin1 || '',
    country: x.country || x.country_code || '',
    lat: x.latitude,
    lon: x.longitude,
  }));
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location not available'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1 ? 'Location permission denied' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

// ---------- places ----------

function selectedPlace() {
  if (state.selected === GPS_ID) return state.gps ? { id: GPS_ID, ...state.gps, name: state.gps.name || 'My location' } : null;
  return state.places.find((p) => p.id === state.selected) || null;
}

function savePlaces() {
  store.set('places', state.places);
  store.set('selected', state.selected);
}

function selectPlace(id) {
  state.selected = id;
  savePlaces();
  state.forecast = null;
  showView('forecast');
  loadForecast({ fresh: true });
}

// ---------- forecast rendering ----------

function setStatus(msg) {
  const el = $('#status');
  el.hidden = !msg;
  el.textContent = msg || '';
}

function cacheKey(place) {
  return `fc:${place.id}:${state.settings.model}`;
}

async function loadForecast({ fresh = false } = {}) {
  let place = selectedPlace();
  $('#place-name').textContent = place?.name || 'My location';

  if (place) {
    const cached = store.get(cacheKey(place), null);
    if (cached && (!state.forecast || fresh)) {
      state.forecast = cached.data;
      state.fetchedAt = cached.at;
      render();
    }
  }

  if (state.selected === GPS_ID) {
    try {
      if (!place) $('#updated').innerHTML = '<span class="spin">◌</span> Finding your location…';
      const pos = await locate();
      const moved = !state.gps || Math.abs(state.gps.lat - pos.lat) > 0.02 || Math.abs(state.gps.lon - pos.lon) > 0.02;
      if (moved) {
        state.gps = { ...pos, name: state.gps?.name };
        reverseGeocode(pos.lat, pos.lon).then((name) => {
          if (!name) return;
          state.gps = { ...state.gps, name };
          store.set('gps', state.gps);
          if (state.selected === GPS_ID) $('#place-name').textContent = name;
        });
      } else {
        state.gps = { ...state.gps, ...pos };
      }
      store.set('gps', state.gps);
      place = selectedPlace();
    } catch (err) {
      if (!place) {
        setStatus(`${err.message}. Search for a place in the Places tab instead.`);
        $('#updated').textContent = '';
        $('#place-name').textContent = 'No location';
        return;
      }
      // Fall back to the last known position.
    }
  }

  if (!place) return;
  $('#place-name').textContent = place.name;
  if (!fresh && state.forecast && Date.now() - state.fetchedAt < REFRESH_AFTER_MS) return;

  if (!state.forecast) $('#updated').innerHTML = '<span class="spin">◌</span> Loading…';
  try {
    const data = await fetchForecast(place.lat, place.lon, state.settings.model);
    if (selectedPlace()?.id !== place.id) return; // user switched place meanwhile
    state.forecast = data;
    state.fetchedAt = Date.now();
    store.set(cacheKey(place), { at: state.fetchedAt, data });
    setStatus('');
    render();
  } catch (err) {
    setStatus(state.forecast ? `Offline — showing forecast from ${timeAgo(state.fetchedAt)}.` : `Could not load forecast (${err.message}).`);
    updateStamp();
  }
}

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function updateStamp() {
  $('#updated').textContent = state.fetchedAt ? `Updated ${timeAgo(state.fetchedAt)}` : '';
}

function currentHourIndex(fc) {
  const now = placeNow(fc).toISOString().slice(0, 13);
  const i = fc.hourly.time.findIndex((t) => t.slice(0, 13) === now);
  return i === -1 ? 0 : i;
}

function render() {
  const fc = state.forecast;
  if (!fc) return;
  const c = fc.current;
  const d = fc.daily;
  const hi = currentHourIndex(fc);
  const isDay = c.is_day ?? fc.hourly.is_day?.[hi] ?? 1;

  document.body.dataset.sky = wxSky(c.weather_code, isDay);
  updateStamp();

  $('#current').innerHTML = `
    <div class="icon">${wxIcon(c.weather_code, isDay)}</div>
    <div class="temp">${deg(c.temperature_2m)}</div>
    <div class="cond">${esc(wxLabel(c.weather_code))}</div>
    <div class="range">H: ${deg(d.temperature_2m_max[0])}&nbsp;&nbsp;L: ${deg(d.temperature_2m_min[0])}</div>
    <div class="feels">Feels like ${deg(c.apparent_temperature)}</div>`;

  renderNowcast(fc);
  renderHourly(fc, hi);
  renderDaily(fc);
  renderDetails(fc, hi);
}

function renderNowcast(fc) {
  const el = $('#nowcast');
  const m = fc.minutely_15;
  if (!m?.precipitation) { el.hidden = true; return; }

  const nowMs = placeNow(fc).getTime();
  const slots = m.time
    .map((t, i) => ({ t: parseLocal(t), mm: m.precipitation[i] }))
    .filter((s) => s.t.getTime() > nowMs - 15 * 60 * 1000 && s.mm != null)
    .slice(0, 9);
  if (slots.length < 2) { el.hidden = true; return; }

  const WET = 0.05; // mm per 15 min
  const wet = slots.map((s) => s.mm >= WET);
  let headline;
  if (wet[0]) {
    const stop = wet.indexOf(false);
    headline = stop === -1 ? 'Rain continuing for the next 2 hours' : `Rain stopping around ${hhmm(slots[stop].t)}`;
  } else {
    const start = wet.indexOf(true);
    headline = start === -1 ? 'No rain expected in the next 2 hours' : `Rain likely from around ${hhmm(slots[start].t)}`;
  }

  // Bar height: rain rate in mm/h on a square-root scale, 8 mm/h = full height.
  const bars = slots.map((s) => {
    const rate = s.mm * 4;
    const h = s.mm < WET ? 4 : Math.max(10, Math.min(100, Math.sqrt(rate / 8) * 100));
    return `<i class="${s.mm < WET ? 'dry' : ''}" style="height:${h}%" title="${hhmm(s.t)}: ${rate.toFixed(1)} mm/h"></i>`;
  }).join('');

  const mid = slots[Math.floor(slots.length / 2)];
  el.hidden = false;
  el.innerHTML = `
    <div class="headline"><span class="drop">${slots.some((s) => s.mm >= WET) ? '☂︎' : '☀︎'}</span>${headline}</div>
    <div class="bars">${bars}</div>
    <div class="axis"><span>Now</span><span>${hhmm(mid.t)}</span><span>${hhmm(slots[slots.length - 1].t)}</span></div>`;
}

function renderHourly(fc, start) {
  const h = fc.hourly;
  const n = Math.min(27, h.time.length - start);
  const COL = 54;
  const items = [];
  for (let k = 0; k < n; k++) {
    const i = start + k;
    const t = parseLocal(h.time[i]);
    items.push({
      i,
      label: k === 0 ? 'Now' : String(t.getUTCHours()).padStart(2, '0'),
      newDay: k > 0 && t.getUTCHours() === 0,
      temp: k === 0 ? fc.current.temperature_2m : h.temperature_2m[i],
      code: h.weather_code[i],
      isDay: h.is_day?.[i] ?? 1,
      pop: h.precipitation_probability?.[i],
      mm: h.precipitation?.[i] ?? 0,
      wind: h.wind_speed_10m?.[i],
      dir: h.wind_direction_10m?.[i],
      weekday: WEEKDAYS[t.getUTCDay()],
    });
  }

  const temps = items.map((x) => x.temp).filter((x) => x != null);
  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const W = n * COL;
  const H = 104;
  const top = 30;
  const bottom = 72;
  const y = (t) => (tMax === tMin ? (top + bottom) / 2 : bottom - ((t - tMin) / (tMax - tMin)) * (bottom - top));
  const pts = items.map((x, k) => [k * COL + COL / 2, y(x.temp ?? tMin)]);
  const path = pts.map((p, k) => {
    if (k === 0) return `M${p[0]},${p[1]}`;
    const [px, py] = pts[k - 1];
    const cx = (px + p[0]) / 2;
    return `C${cx},${py} ${cx},${p[1]} ${p[0]},${p[1]}`;
  }).join(' ');
  const maxMm = Math.max(2, ...items.map((x) => x.mm));
  const rainBars = items.map((x, k) => {
    if (x.mm < 0.1) return '';
    const bh = Math.max(3, (x.mm / maxMm) * 26);
    return `<rect x="${k * COL + 8}" y="${H - bh}" width="${COL - 16}" height="${bh}" rx="2" fill="var(--rain)" opacity="0.55"/>
            <text x="${k * COL + COL / 2}" y="${H - bh - 3}" style="font-size:10px;fill:var(--rain)">${x.mm < 1 ? x.mm.toFixed(1) : Math.round(x.mm)}</text>`;
  }).join('');
  const dayLines = items.map((x, k) => (x.newDay
    ? `<line x1="${k * COL}" x2="${k * COL}" y1="0" y2="${H}" stroke="var(--line)"/>` : '')).join('');

  $('#hourly').innerHTML = `
    <h3 class="card-title">Next 24 hours</h3>
    <div class="scroller">
      <div style="width:${W + 12}px;padding:0 6px">
        <div class="strip" style="padding:0">
          ${items.map((x) => `
            <div class="hour ${x.label === 'Now' ? 'now' : ''}">
              <div class="t">${x.newDay ? `<b>${x.weekday}</b>` : x.label}</div>
              <div class="ic">${wxIcon(x.code, x.isDay)}</div>
              <div class="p">${x.pop >= 20 ? `${Math.round(x.pop / 10) * 10}%` : ''}</div>
            </div>`).join('')}
        </div>
        <svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
          ${dayLines}
          ${rainBars}
          <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>
          ${pts.map((p, k) => `<text x="${p[0]}" y="${p[1] - 8}">${deg(items[k].temp)}</text>`).join('')}
        </svg>
        <div class="strip" style="padding:0 0 10px">
          ${items.map((x) => `
            <div class="hour"><div class="w">
              <span class="arrow" style="transform:rotate(${(x.dir ?? 0) + 180}deg)">↑</span>
              ${windValue(x.wind).v}
            </div></div>`).join('')}
        </div>
      </div>
    </div>`;
}

function renderDaily(fc) {
  const d = fc.daily;
  const n = d.time.length;
  const valid = d.time.map((_, i) => i).filter((i) => d.temperature_2m_max[i] != null && d.temperature_2m_min[i] != null);
  const lo = Math.min(...valid.map((i) => d.temperature_2m_min[i]));
  const hi = Math.max(...valid.map((i) => d.temperature_2m_max[i]));
  const span = Math.max(1, hi - lo);
  const nowT = fc.current.temperature_2m;

  const rows = valid.map((i) => {
    const t = parseLocal(d.time[i]);
    const name = i === 0 ? 'Today' : WEEKDAYS[t.getUTCDay()];
    const min = d.temperature_2m_min[i];
    const max = d.temperature_2m_max[i];
    const left = ((min - lo) / span) * 100;
    const width = Math.max(4, ((max - min) / span) * 100);
    const pop = d.precipitation_probability_max?.[i];
    const sum = d.precipitation_sum?.[i];
    const showRain = (pop != null && pop >= 20) || (sum != null && sum >= 0.5);
    const dot = i === 0 && nowT != null ? `<span class="dot" style="left:${((Math.min(max, Math.max(min, nowT)) - lo) / span) * 100}%"></span>` : '';
    return `
      <div class="day">
        <div class="name">${name}</div>
        <div class="ic">${wxIcon(d.weather_code[i], 1)}</div>
        <div class="pp">${showRain ? `${pop != null ? `${Math.round(pop / 10) * 10}%` : ''}<small>${sum != null && sum >= 0.1 ? `${sum < 10 ? sum.toFixed(1) : Math.round(sum)} mm` : ''}</small>` : ''}</div>
        <div class="rangebar">
          <span class="lo">${deg(min)}</span>
          <div class="track"><div class="fill" style="clip-path:inset(0 ${Math.max(0, 100 - left - width)}% 0 ${left}% round 3px)"></div>${dot}</div>
        </div>
        <div class="hi">${deg(max)}</div>
      </div>`;
  }).join('');

  $('#daily').innerHTML = `<h3 class="card-title">${valid.length || n}-day forecast</h3>${rows}`;
}

function renderDetails(fc, hi) {
  const c = fc.current;
  const d = fc.daily;
  const h = fc.hourly;
  const wind = windValue(c.wind_speed_10m);
  const uv = h.uv_index?.[hi] ?? null;
  const uvMax = d.uv_index_max?.[0];
  const uvText = (u) => (u == null ? '' : u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme');
  const sunrise = d.sunrise?.[0] ? hhmm(parseLocal(d.sunrise[0])) : '–';
  const sunset = d.sunset?.[0] ? hhmm(parseLocal(d.sunset[0])) : '–';
  const vis = h.visibility?.[hi];
  const visText = vis == null ? '–' : vis >= 10000 ? `${Math.round(vis / 1000)}` : (vis / 1000).toFixed(1);

  const compass = `
    <svg class="compass" viewBox="0 0 54 54" aria-hidden="true">
      <circle cx="27" cy="27" r="24" fill="none" stroke="var(--line)" stroke-width="2"/>
      <text x="27" y="12" text-anchor="middle" font-size="8" fill="var(--text-3)">N</text>
      <g transform="rotate(${(c.wind_direction_10m ?? 0) + 180} 27 27)">
        <path d="M27 9 L32 27 L27 24 L22 27 Z" fill="var(--text)"/>
        <line x1="27" y1="24" x2="27" y2="43" stroke="var(--text)" stroke-width="2"/>
      </g>
    </svg>`;

  const tiles = [
    ['Wind', `${compass}${wind.v} <small>${wind.u}</small>`, `Gusts ${windText(c.wind_gusts_10m)} · from ${compassName(c.wind_direction_10m)}`],
    ['Precipitation', `${(d.precipitation_sum?.[0] ?? 0).toFixed(1)} <small>mm</small>`, `Today${d.precipitation_hours?.[0] ? ` · ${round(d.precipitation_hours[0])} h of rain` : ''}`],
    ['Humidity', `${round(c.relative_humidity_2m)}<small>%</small>`, `Dew point ${deg(c.dew_point_2m)}`],
    ['UV index', `${uv != null ? round(uv) : '–'}`, `${uvText(uv)}${uvMax != null ? ` · max ${round(uvMax)} today` : ''}`],
    ['Sunrise', sunrise, `Sunset ${sunset}`],
    ['Pressure', `${round(c.pressure_msl)} <small>hPa</small>`, `Clouds ${round(c.cloud_cover)}%`],
    ['Feels like', deg(c.apparent_temperature), c.apparent_temperature < c.temperature_2m - 1 ? 'Wind makes it feel colder' : c.apparent_temperature > c.temperature_2m + 1 ? 'Humidity makes it feel warmer' : 'Similar to actual temperature'],
    ['Visibility', `${visText} <small>km</small>`, vis != null && vis < 1000 ? 'Fog' : vis != null && vis < 5000 ? 'Hazy' : 'Clear view'],
  ];
  $('#details').innerHTML = tiles.map(([label, value, sub]) => `
    <div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`).join('');
}

// ---------- places view ----------

async function renderPlaces() {
  const list = [
    { id: GPS_ID, name: 'My location', sub: state.gps?.name || 'Uses your current position', lat: state.gps?.lat, lon: state.gps?.lon },
    ...state.places.map((p) => ({ ...p, sub: [p.admin, p.country].filter(Boolean).join(', ') })),
  ];
  const el = $('#places');
  el.innerHTML = list.map((p) => `
    <li>
      <div class="place-item ${p.id === state.selected ? 'selected' : ''}" role="button" tabindex="0" data-select="${esc(p.id)}">
        <div class="main"><div class="nm">${p.id === GPS_ID ? '📍 ' : ''}${esc(p.name)}</div><div class="sub">${esc(p.sub)}</div></div>
        <div class="tmp" data-temp="${esc(p.id)}"></div>
        ${p.id === GPS_ID ? '' : `<button class="rm" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>`}
      </div>
    </li>`).join('');

  // Current temperatures for all places in a single request.
  const withCoords = list.filter((p) => p.lat != null);
  if (!withCoords.length) return;
  try {
    const p = new URLSearchParams({
      latitude: withCoords.map((x) => x.lat.toFixed(3)).join(','),
      longitude: withCoords.map((x) => x.lon.toFixed(3)).join(','),
      current: 'temperature_2m,weather_code,is_day',
      timezone: 'auto',
    });
    if (state.settings.model !== 'best_match') p.set('models', state.settings.model);
    let res = await getJSON(`${FORECAST_URL}?${p}`);
    if (!Array.isArray(res)) res = [res];
    res.forEach((r, k) => {
      const cell = el.querySelector(`[data-temp="${CSS.escape(withCoords[k].id)}"]`);
      if (cell && r.current) cell.textContent = `${wxIcon(r.current.weather_code, r.current.is_day)} ${deg(r.current.temperature_2m)}`;
    });
  } catch { /* temperatures are optional */ }
}

let searchTimer;
let searchSeq = 0;
function onSearchInput(e) {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  const out = $('#search-results');
  if (q.length < 2) { out.innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const results = await searchPlaces(q);
      if (seq !== searchSeq) return;
      out.innerHTML = results.length
        ? results.map((r, k) => `
          <li><button class="place-item result-item" data-result="${k}">
            <div class="main"><div class="nm">${esc(r.name)}</div><div class="sub">${esc([r.admin, r.country].filter(Boolean).join(', '))}</div></div>
            <span>＋</span>
          </button></li>`).join('')
        : '<li class="hint">No places found</li>';
      out.onclick = (ev) => {
        const b = ev.target.closest('[data-result]');
        if (!b) return;
        const r = results[Number(b.dataset.result)];
        if (!state.places.some((p) => p.id === r.id)) state.places.push(r);
        $('#search').value = '';
        out.innerHTML = '';
        selectPlace(r.id);
      };
    } catch (err) {
      if (seq === searchSeq) out.innerHTML = `<li class="hint">Search failed (${esc(err.message)})</li>`;
    }
  }, 300);
}

// ---------- radar ----------

const radar = {
  map: null,
  frames: [], // {time: Date, kind: 'past'|'nowcast', layer}
  index: 0,
  timer: null,
  source: store.get('radarSource', 'rainviewer'),
  marker: null,
  loadedAt: 0,
};

function initMap() {
  if (radar.map || !window.L) return;
  const place = selectedPlace();
  const center = place ? [place.lat, place.lon] : [50.5, 10.5];
  radar.map = L.map('map', { zoomControl: true, attributionControl: true, minZoom: 3, maxZoom: 11 })
    .setView(center, place ? 8 : 6);
  radar.map.createPane('labels');
  radar.map.getPane('labels').style.zIndex = 650;
  radar.map.getPane('labels').style.pointerEvents = 'none';
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
  }).addTo(radar.map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', pane: 'labels',
  }).addTo(radar.map);
}

function updateRadarMarker() {
  const place = selectedPlace();
  if (!radar.map || !place) return;
  const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
  if (radar.marker) radar.marker.setLatLng([place.lat, place.lon]);
  else radar.marker = L.marker([place.lat, place.lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(radar.map);
}

function clearFrames() {
  stopRadar();
  for (const f of radar.frames) radar.map.removeLayer(f.layer);
  radar.frames = [];
}

async function loadRainViewer() {
  const data = await getJSON(RAINVIEWER_URL);
  const frames = [
    ...(data.radar?.past || []).map((f) => ({ ...f, kind: 'past' })),
    ...(data.radar?.nowcast || []).map((f) => ({ ...f, kind: 'nowcast' })),
  ];
  return frames.map((f) => ({
    time: new Date(f.time * 1000),
    kind: f.kind,
    layer: L.tileLayer(`${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0,
      maxNativeZoom: 7, // the free RainViewer API serves tiles up to zoom 7
      maxZoom: 11,
      attribution: '<a href="https://www.rainviewer.com/api.html">RainViewer</a>',
    }),
  }));
}

function loadDwd() {
  // DWD radar composite (5-minute steps). Use the last 2 hours in 10-minute steps,
  // ending a few minutes ago so the newest image is published.
  const step = 10 * 60 * 1000;
  const latest = Math.floor((Date.now() - 8 * 60 * 1000) / (5 * 60 * 1000)) * 5 * 60 * 1000;
  const frames = [];
  for (let k = 12; k >= 0; k--) {
    const time = new Date(latest - k * step);
    frames.push({
      time,
      kind: 'past',
      layer: L.tileLayer.wms(DWD_WMS_URL, {
        layers: 'dwd:Niederschlagsradar',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        time: time.toISOString().replace('.000', ''),
        opacity: 0,
        bounds: [[45.5, 1.5], [56.5, 18.5]],
        attribution: '<a href="https://www.dwd.de">DWD</a>',
      }),
    });
  }
  return frames;
}

async function loadRadar(force = false) {
  initMap();
  if (!radar.map) return;
  updateRadarMarker();
  if (!force && radar.frames.length && Date.now() - radar.loadedAt < 5 * 60 * 1000) return;
  clearFrames();
  $('#radar-time').textContent = 'Loading…';
  $('#radar-kind').textContent = '';
  try {
    radar.frames = radar.source === 'dwd' ? loadDwd() : await loadRainViewer();
  } catch (err) {
    $('#radar-time').textContent = 'Radar unavailable';
    $('#radar-kind').textContent = err.message;
    return;
  }
  radar.loadedAt = Date.now();
  for (const f of radar.frames) f.layer.addTo(radar.map);
  const slider = $('#radar-slider');
  slider.max = String(Math.max(0, radar.frames.length - 1));
  const lastPast = radar.frames.map((f) => f.kind).lastIndexOf('past');
  showFrame(lastPast === -1 ? radar.frames.length - 1 : lastPast);
}

function showFrame(i) {
  if (!radar.frames.length) return;
  radar.index = (i + radar.frames.length) % radar.frames.length;
  radar.frames.forEach((f, k) => f.layer.setOpacity(k === radar.index ? 0.75 : 0));
  const f = radar.frames[radar.index];
  const now = Date.now();
  $('#radar-slider').value = String(radar.index);
  $('#radar-time').textContent = f.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const mins = Math.round((f.time - now) / 60000);
  $('#radar-kind').textContent = f.kind === 'nowcast' ? `Forecast +${mins} min` : mins > -8 ? 'Latest' : `${-mins} min ago`;
}

function playRadar() {
  if (radar.timer || radar.frames.length < 2) return;
  $('#play-icon').setAttribute('d', 'M7 5h4v14H7zM13 5h4v14h-4z');
  const tick = () => {
    const next = radar.index + 1;
    showFrame(next >= radar.frames.length ? 0 : next);
    radar.timer = setTimeout(tick, radar.index === radar.frames.length - 1 ? 1500 : 450);
  };
  radar.timer = setTimeout(tick, 100);
}

function stopRadar() {
  clearTimeout(radar.timer);
  radar.timer = null;
  $('#play-icon').setAttribute('d', 'M8 5v14l11-7z');
}

// ---------- views ----------

function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'radar') {
    initMap();
    if (radar.map) {
      radar.map.invalidateSize();
      const place = selectedPlace();
      if (place) radar.map.setView([place.lat, place.lon], Math.max(radar.map.getZoom(), 7), { animate: false });
    }
    loadRadar();
  } else {
    stopRadar();
  }
  if (name === 'places') renderPlaces();
  window.scrollTo(0, 0);
}

function bind() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#place-button').addEventListener('click', () => showView('places'));
  $('#search').addEventListener('input', onSearchInput);

  $('#places').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      e.stopPropagation();
      const id = rm.dataset.remove;
      state.places = state.places.filter((p) => p.id !== id);
      try { localStorage.removeItem(`fc:${id}:${state.settings.model}`); } catch { /* ignore */ }
      if (state.selected === id) { state.selected = GPS_ID; state.forecast = null; }
      savePlaces();
      renderPlaces();
      return;
    }
    const sel = e.target.closest('[data-select]');
    if (sel) selectPlace(sel.dataset.select);
  });

  const model = $('#model');
  model.value = state.settings.model;
  model.addEventListener('change', () => {
    state.settings.model = model.value;
    store.set('settings', state.settings);
    state.forecast = null;
    loadForecast({ fresh: true });
  });
  const wind = $('#wind-unit');
  wind.value = state.settings.windUnit;
  wind.addEventListener('change', () => {
    state.settings.windUnit = wind.value;
    store.set('settings', state.settings);
    render();
  });

  document.querySelectorAll('#radar-source button').forEach((b) => {
    b.classList.toggle('on', b.dataset.source === radar.source);
    b.addEventListener('click', () => {
      radar.source = b.dataset.source;
      store.set('radarSource', radar.source);
      document.querySelectorAll('#radar-source button').forEach((x) => x.classList.toggle('on', x === b));
      loadRadar(true);
    });
  });
  $('#radar-play').addEventListener('click', () => (radar.timer ? stopRadar() : playRadar()));
  $('#radar-slider').addEventListener('input', (e) => { stopRadar(); showFrame(Number(e.target.value)); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    loadForecast();
    if (state.view === 'radar') loadRadar();
  });
  setInterval(updateStamp, 60 * 1000);
}

bind();
loadForecast();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
