// Weather widget for Scriptable (https://scriptable.app).
// Loaded by the small installer script from widget/index.html; exports one async function.
//
// Widget parameter (long-press widget → Edit Widget → Parameter):
//   empty        → your current location
//   Berlin       → a fixed place by name
//   52.52,13.41  → fixed coordinates

module.exports = async function weatherWidget(opts = {}) {
  const APP_URL = opts.appUrl || 'https://krystofrobin.github.io/weather/';
  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
  const REFRESH_MIN = 15;
  const WET = 0.05; // mm per 15 minutes

  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.documentsDirectory(), 'weather-widget-cache.json');
  const cache = (() => {
    try { return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : {}; } catch (e) { return {}; }
  })();
  const saveCache = () => { try { fm.writeString(cachePath, JSON.stringify(cache)); } catch (e) { /* ignore */ } };

  // ---------- weather codes ----------

  const LABELS = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
  };
  const label = (c) => LABELS[c] || '';

  function symbolName(c, isDay) {
    if (c <= 1) return isDay ? 'sun.max.fill' : 'moon.stars.fill';
    if (c === 2) return isDay ? 'cloud.sun.fill' : 'cloud.moon.fill';
    if (c === 3) return 'cloud.fill';
    if (c === 45 || c === 48) return 'cloud.fog.fill';
    if (c >= 51 && c <= 57) return 'cloud.drizzle.fill';
    if (c === 80 || c === 81) return isDay ? 'cloud.sun.rain.fill' : 'cloud.moon.rain.fill';
    if (c === 65 || c === 82) return 'cloud.heavyrain.fill';
    if (c === 66 || c === 67) return 'cloud.sleet.fill';
    if (c >= 61 && c <= 67) return 'cloud.rain.fill';
    if (c >= 71 && c <= 86) return 'cloud.snow.fill';
    if (c >= 95) return 'cloud.bolt.rain.fill';
    return 'thermometer.medium';
  }

  function sky(c, isDay) {
    const kind = c >= 95 || c === 82 ? 'storm' : c >= 71 && c <= 86 && c !== 80 && c !== 81 ? 'snow'
      : c >= 51 ? 'rain' : c === 45 || c === 48 ? 'fog' : c >= 2 ? 'cloudy' : 'clear';
    const day = {
      clear: ['#3b82d6', '#1a4f94'], cloudy: ['#61758f', '#34465c'], rain: ['#46586e', '#232f3e'],
      snow: ['#8597ad', '#4a5a70'], storm: ['#3c3f55', '#181a26'], fog: ['#7d8794', '#4b535e'],
    };
    const night = {
      clear: ['#142446', '#060b18'], cloudy: ['#232c3d', '#0b1019'], rain: ['#1c2533', '#080c12'],
      snow: ['#2c3646', '#0f141c'], storm: ['#1d1c2c', '#07070d'], fog: ['#2a2f37', '#111418'],
    };
    return (isDay ? day : night)[kind];
  }

  // ---------- helpers ----------

  const WHITE = Color.white();
  const DIM = new Color('#ffffff', 0.72);
  const FAINT = new Color('#ffffff', 0.5);
  const RAIN = new Color('#5fb4ff');
  const deg = (t) => (t == null ? '–' : `${Math.round(t)}°`);
  const timeFmt = new DateFormatter();
  timeFmt.dateFormat = 'HH:mm';
  const hourFmt = new DateFormatter();
  hourFmt.dateFormat = 'HH';
  const dayFmt = new DateFormatter();
  dayFmt.dateFormat = 'EEE';
  const hhmm = (d) => timeFmt.string(d);

  async function getJSON(url) {
    const r = new Request(url);
    r.timeoutInterval = 15;
    const json = await r.loadJSON();
    if (r.response && r.response.statusCode >= 400) throw new Error(json.reason || `HTTP ${r.response.statusCode}`);
    return json;
  }

  // ---------- place ----------

  async function resolvePlace(param) {
    const coords = param.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      const lat = Number(coords[1]);
      const lon = Number(coords[2]);
      return { lat, lon, name: (await placeName(lat, lon)) || param, fixed: true };
    }
    if (param) {
      const key = `geo:${param.toLowerCase()}`;
      if (cache[key]) return cache[key];
      const q = encodeURIComponent(param);
      const r = await getJSON(`${GEOCODE_URL}?name=${q}&count=1&language=en&format=json`);
      const hit = r.results && r.results[0];
      if (!hit) throw new Error(`Place "${param}" not found`);
      cache[key] = { lat: hit.latitude, lon: hit.longitude, name: hit.name, fixed: true };
      saveCache();
      return cache[key];
    }
    try {
      Location.setAccuracyToThreeKilometers();
      const loc = await Location.current();
      const moved = !cache.gps || Math.abs(cache.gps.lat - loc.latitude) > 0.02 || Math.abs(cache.gps.lon - loc.longitude) > 0.02;
      const name = moved ? await placeName(loc.latitude, loc.longitude) : cache.gps.name;
      cache.gps = { lat: loc.latitude, lon: loc.longitude, name: name || (cache.gps && cache.gps.name) || 'My location' };
      saveCache();
    } catch (e) {
      if (!cache.gps) throw new Error('Location unavailable. Allow location for Scriptable, or set a town as the widget parameter.');
    }
    return cache.gps;
  }

  async function placeName(lat, lon) {
    try {
      const r = await Location.reverseGeocode(lat, lon);
      const p = r && r[0];
      return p ? p.locality || p.subAdministrativeArea || p.administrativeArea || p.name : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- forecast ----------

  async function loadForecast(place) {
    const p = [
      `latitude=${place.lat.toFixed(4)}`, `longitude=${place.lon.toFixed(4)}`,
      'models=icon_seamless',
      'current=temperature_2m,apparent_temperature,weather_code,is_day',
      'hourly=temperature_2m,weather_code,is_day,precipitation',
      'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
      'minutely_15=precipitation', 'past_minutely_15=4', 'forecast_minutely_15=24',
      'forecast_days=6', 'timezone=auto', 'timeformat=unixtime',
    ].join('&');
    const key = `fc:${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
    try {
      const fc = await getJSON(`${FORECAST_URL}?${p}`);
      if (!fc.current) throw new Error(fc.reason || 'No data');
      cache[key] = { at: Date.now(), fc };
      saveCache();
      return { fc, at: Date.now(), stale: false };
    } catch (e) {
      if (cache[key]) return { fc: cache[key].fc, at: cache[key].at, stale: true };
      throw e;
    }
  }

  function summarize(fc) {
    const now = Date.now();
    const c = fc.current;
    const h = fc.hourly;
    const d = fc.daily;

    let hi = h.time.findIndex((t) => t * 1000 > now) - 1;
    if (hi < 0) hi = 0;
    // Starts with the current hour ("Now"), so the rain chart above it can begin at the top of this hour.
    const hours = [];
    for (let i = hi; i < h.time.length && hours.length < 5; i++) {
      const isNow = i === hi;
      hours.push({
        t: new Date(h.time[i] * 1000), now: isNow,
        temp: isNow ? c.temperature_2m : h.temperature_2m[i],
        code: isNow ? c.weather_code : h.weather_code[i],
        isDay: isNow ? c.is_day : h.is_day[i],
      });
    }

    const m = fc.minutely_15 || { time: [], precipitation: [] };
    const slots = m.time
      .map((t, i) => ({ t: new Date(t * 1000), mm: m.precipitation[i] }))
      .filter((s) => s.t.getTime() > now - 15 * 60 * 1000 && s.mm != null)
      .slice(0, 9);
    const wet = slots.map((s) => s.mm >= WET);

    // 15-minute rain amounts for the hours shown in the hourly row, 4 per hour.
    const byTime = new Map(m.time.map((t, i) => [t * 1000, m.precipitation[i]]));
    const start = hours.length ? hours[0].t.getTime() : now;
    const timeline = [];
    for (let k = 0; k < hours.length * 4; k++) {
      const t = start + k * 15 * 60 * 1000;
      timeline.push({ mm: byTime.has(t) ? byTime.get(t) : null, past: t + 15 * 60 * 1000 <= now });
    }
    let rain = null;
    if (slots.length >= 2) {
      if (wet[0]) {
        const stop = wet.indexOf(false);
        rain = stop === -1 ? 'Rain for the next 2 h' : `Rain until ${hhmm(slots[stop].t)}`;
      } else {
        const start = wet.indexOf(true);
        rain = start === -1 ? 'No rain next 2 h' : `Rain from ${hhmm(slots[start].t)}`;
      }
    }

    const days = d.time.map((t, i) => ({
      t: new Date(t * 1000), code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], mm: d.precipitation_sum[i],
    })).filter((x) => x.max != null);

    return {
      temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, isDay: c.is_day,
      max: d.temperature_2m_max[0], min: d.temperature_2m_min[0],
      hours, timeline, rain, rainSoon: wet.some(Boolean), days,
    };
  }

  // ---------- drawing ----------

  // One bar per 15 minutes, 4 per hour column, so each bar sits above the hour it belongs to.
  function rainChart(timeline, colWidth, height) {
    const ctx = new DrawContext();
    const width = colWidth * (timeline.length / 4);
    ctx.size = new Size(width, height);
    ctx.opaque = false;
    ctx.respectScreenScale = true;
    const slot = colWidth / 4;
    const gap = 1.5;
    timeline.forEach((x, k) => {
      if (x.mm == null) return;
      const dry = x.mm < WET;
      const rate = x.mm * 4; // mm/h
      const bh = dry ? 2 : Math.max(6, Math.min(1, Math.sqrt(rate / 8)) * (height - 2));
      const alpha = x.past ? 0.35 : 1;
      ctx.setFillColor(dry ? new Color('#ffffff', 0.25 * alpha) : new Color('#5fb4ff', alpha));
      const path = new Path();
      path.addRoundedRect(new Rect(k * slot + gap / 2, height - bh, slot - gap, bh), 1.5, 1.5);
      ctx.addPath(path);
      ctx.fillPath();
    });
    return { image: ctx.getImage(), size: new Size(width, height) };
  }

  // Rain headline, then the rain chart directly above the hourly row, sharing its column grid.
  function timelineBlock(stack, s, width) {
    const colWidth = Math.floor(width / 5);
    rainLine(stack, s, 12);
    stack.addSpacer(6);
    if (s.timeline.some((x) => x.mm != null)) {
      const chart = rainChart(s.timeline, colWidth, 24);
      stack.addImage(chart.image).imageSize = chart.size;
      stack.addSpacer(2);
    }
    hourlyRow(stack, s.hours, 5, width);
  }

  function addSymbol(stack, name, size, color = WHITE) {
    const sf = SFSymbol.named(name) || SFSymbol.named('cloud.fill');
    const img = stack.addImage(sf.image);
    img.imageSize = new Size(size, size);
    img.tintColor = color;
    return img;
  }

  function addText(stack, text, size, opts = {}) {
    const t = stack.addText(String(text));
    t.font = opts.weight === 'bold' ? Font.boldSystemFont(size)
      : opts.weight === 'semibold' ? Font.semiboldSystemFont(size)
      : opts.weight === 'light' ? Font.lightSystemFont(size)
      : opts.rounded ? Font.semiboldRoundedSystemFont(size) : Font.systemFont(size);
    t.textColor = opts.color || WHITE;
    t.lineLimit = opts.lines || 1;
    if (opts.scale) t.minimumScaleFactor = opts.scale;
    return t;
  }

  function header(stack, place, size) {
    const row = stack.addStack();
    row.centerAlignContent();
    addText(row, place.name, size, { weight: 'semibold', scale: 0.7 });
    if (!place.fixed) {
      row.addSpacer(3);
      addSymbol(row, 'location.fill', size * 0.7, DIM);
    }
  }

  function currentBlock(stack, place, s, big) {
    header(stack, place, big ? 15 : 14);
    stack.addSpacer(big ? 4 : 2);
    const row = stack.addStack();
    row.centerAlignContent();
    addSymbol(row, symbolName(s.code, s.isDay), big ? 34 : 28);
    row.addSpacer(6);
    addText(row, deg(s.temp), big ? 40 : 36, { weight: 'light', scale: 0.7 });
    stack.addSpacer(2);
    addText(stack, label(s.code), 13, { weight: 'semibold', scale: 0.8 });
    addText(stack, `H:${deg(s.max)}  L:${deg(s.min)}`, 12, { color: DIM });
  }

  function rainLine(stack, s, size) {
    if (!s.rain) return;
    const row = stack.addStack();
    row.centerAlignContent();
    addSymbol(row, s.rainSoon ? 'umbrella.fill' : 'sun.max', size, s.rainSoon ? RAIN : DIM);
    row.addSpacer(4);
    addText(row, s.rain, size, { weight: 'semibold', color: s.rainSoon ? WHITE : DIM, scale: 0.75 });
  }

  // Fixed-width columns: flexible spacers between unsized columns squeeze the text until iOS truncates it.
  function hourlyRow(stack, hours, count, width) {
    const colWidth = Math.floor(width / count);
    const row = stack.addStack();
    row.size = new Size(colWidth * count, 0);
    const centered = (col) => {
      const r = col.addStack();
      r.size = new Size(colWidth, 0);
      r.addSpacer();
      return r;
    };
    hours.slice(0, count).forEach((h) => {
      const col = row.addStack();
      col.layoutVertically();
      col.size = new Size(colWidth, 0);
      const top = centered(col);
      addText(top, h.now ? 'Now' : hourFmt.string(h.t), 11, { color: h.now ? WHITE : DIM, weight: h.now ? 'semibold' : undefined, scale: 0.8 });
      top.addSpacer();
      col.addSpacer(3);
      const mid = centered(col);
      addSymbol(mid, symbolName(h.code, h.isDay), 16);
      mid.addSpacer();
      col.addSpacer(3);
      const bot = centered(col);
      addText(bot, deg(h.temp), 12, { weight: 'semibold', scale: 0.7 });
      bot.addSpacer();
    });
  }

  function footer(stack, at, stale) {
    const t = addText(stack, `${stale ? 'Offline · ' : ''}${hhmm(new Date(at))}`, 9, { color: FAINT });
    t.rightAlignText();
  }

  function build(family, place, s, at, stale) {
    const w = new ListWidget();
    w.url = APP_URL;
    w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);

    if (family === 'accessoryInline') {
      addText(w, `${deg(s.temp)} ${s.rainSoon && s.rain ? s.rain : label(s.code)}`, 12);
      return w;
    }
    if (family === 'accessoryCircular') {
      w.addAccessoryWidgetBackground = true;
      const st = w.addStack();
      st.layoutVertically();
      const a = st.addStack(); a.addSpacer(); addSymbol(a, symbolName(s.code, s.isDay), 18); a.addSpacer();
      const b = st.addStack(); b.addSpacer(); addText(b, deg(s.temp), 16, { weight: 'semibold' }); b.addSpacer();
      return w;
    }
    if (family === 'accessoryRectangular') {
      const r = w.addStack();
      r.centerAlignContent();
      addSymbol(r, symbolName(s.code, s.isDay), 14);
      r.addSpacer(4);
      addText(r, `${deg(s.temp)} ${place.name}`, 14, { weight: 'semibold', scale: 0.7 });
      addText(w, `H:${deg(s.max)} L:${deg(s.min)} · ${label(s.code)}`, 12, { scale: 0.7 });
      if (s.rain) addText(w, s.rain, 12, { weight: 'semibold', scale: 0.7 });
      return w;
    }

    const [a, b] = sky(s.code, s.isDay);
    const g = new LinearGradient();
    g.colors = [new Color(a), new Color(b)];
    g.locations = [0, 1];
    w.backgroundGradient = g;

    if (family === 'small') {
      w.setPadding(14, 14, 12, 14);
      currentBlock(w, place, s, false);
      w.addSpacer();
      rainLine(w, s, 11);
      return w;
    }

    w.setPadding(14, 16, 10, 16);
    const top = w.addStack();
    const left = top.addStack();
    left.layoutVertically();
    left.size = new Size(118, 0);
    currentBlock(left, place, s, family === 'large');
    top.addSpacer(12);
    const right = top.addStack();
    right.layoutVertically();
    right.size = new Size(160, 0);
    if (family === 'medium') {
      timelineBlock(right, s, 160);
      w.addSpacer();
      footer(w, at, stale);
      return w;
    }

    // large
    timelineBlock(right, s, 160);
    w.addSpacer(14);
    s.days.slice(1, 6).forEach((d) => {
      const r = w.addStack();
      r.centerAlignContent();
      const n = r.addStack(); n.size = new Size(44, 0); addText(n, dayFmt.string(d.t), 14, { weight: 'semibold' });
      addSymbol(r, symbolName(d.code, 1), 18);
      r.addSpacer(8);
      const p = r.addStack(); p.size = new Size(54, 0);
      addText(p, d.mm >= 0.5 ? `${d.mm < 10 ? d.mm.toFixed(1) : Math.round(d.mm)} mm` : '', 11, { color: RAIN });
      r.addSpacer();
      addText(r, deg(d.min), 14, { color: DIM });
      r.addSpacer(10);
      addText(r, deg(d.max), 14, { weight: 'semibold' });
      w.addSpacer(5);
    });
    w.addSpacer();
    footer(w, at, stale);
    return w;
  }

  function errorWidget(message) {
    const w = new ListWidget();
    w.url = APP_URL;
    w.backgroundColor = new Color('#1c2533');
    w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);
    addText(w, 'Weather', 14, { weight: 'semibold' });
    w.addSpacer(4);
    addText(w, message, 12, { color: DIM, lines: 5, scale: 0.7 });
    return w;
  }

  // ---------- run ----------

  const inWidget = config.runsInWidget || config.runsInAccessoryWidget;
  let family = config.widgetFamily;
  if (!inWidget) {
    const a = new Alert();
    a.title = 'Weather widget preview';
    ['Small', 'Medium', 'Large'].forEach((x) => a.addAction(x));
    a.addCancelAction('Cancel');
    const i = await a.presentSheet();
    if (i === -1) return;
    family = ['small', 'medium', 'large'][i];
  }

  let widget;
  try {
    const param = ((typeof args !== 'undefined' && args.widgetParameter) || '').trim();
    const place = await resolvePlace(param);
    const { fc, at, stale } = await loadForecast(place);
    widget = build(family || 'medium', place, summarize(fc), at, stale);
  } catch (e) {
    widget = errorWidget(e.message || String(e));
  }

  if (inWidget) {
    Script.setWidget(widget);
  } else if (family === 'small') {
    await widget.presentSmall();
  } else if (family === 'large') {
    await widget.presentLarge();
  } else {
    await widget.presentMedium();
  }
  Script.complete();
};
