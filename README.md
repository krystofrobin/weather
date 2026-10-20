# Weather

A small, ad-free weather app with rain radar. It's a web app you install on your phone's home screen: no App Store, no ads, no tracking.

**Features**
- Current conditions, **next-2-hours rain** ("Rain likely from around 14:30") in 15-minute steps
- 24-hour temperature curve with rain amounts and chances, plus a 10-day forecast
- Wind, gusts, humidity, UV, sunrise/sunset, pressure, visibility
- Animated **rain radar** with **2-hour radar forecast** (DWD composite: Germany and border regions), or past-only radar for all of Europe (RainViewer)
- Your current location plus any number of saved places; works offline with the last forecast

**Data**
- Forecast: [DWD](https://www.dwd.de) ICON models (ICON-D2 2 km → ICON-EU → ICON global) via [Open-Meteo](https://open-meteo.com).
  Rain probability, UV and days 8–10 are filled in from Open-Meteo's "best match", because ICON doesn't provide them.
  You can switch to ECMWF or Météo-France in *Places → Settings*.
- Radar: [RainViewer](https://www.rainviewer.com/api.html), [DWD GeoServer](https://maps.dwd.de)
- Place search: Open-Meteo geocoding; place name for your location: BigDataCloud
- Map: © OpenStreetMap contributors, © CARTO

All of these are free and need no API key. Everything runs in the browser; there is no server.

## Home Screen widget

`widget/` holds a [Scriptable](https://scriptable.app) widget (small, medium, large and Lock Screen sizes).
Open **Places → Home Screen widget** in the app for the copy-and-paste setup. The pasted script is a small loader
that downloads `widget/weather-widget.js` from the site, so widget updates ship with the app.

## Install on iPhone

1. Open the site in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Open it from the home screen and allow location access.

On Android, use Chrome's menu → *Install app*.

## Hosting (GitHub Pages)

`.github/workflows/pages.yml` publishes the repo on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The app is then at `https://<user>.github.io/weather/`.

Note: on a free GitHub plan, Pages needs a public repository.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. The files are `index.html`, `styles.css`, `app.js`, `sw.js` (offline cache) and `manifest.webmanifest`.
