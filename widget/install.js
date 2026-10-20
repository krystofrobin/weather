// icon-color: blue; icon-glyph: cloud-sun;
// Weather widget. Downloads the latest widget code from your weather app,
// so updates arrive automatically. Keeps a copy for when you're offline.
const APP = 'https://krystofrobin.github.io/weather/';
const fm = FileManager.local();
const file = fm.joinPath(fm.documentsDirectory(), 'weather-widget-code.js');
let code;
try {
  const req = new Request(`${APP}widget/weather-widget.js`);
  req.timeoutInterval = 10;
  code = await req.loadString();
  if (req.response.statusCode !== 200 || !code.includes('module.exports')) throw new Error('Download failed');
  fm.writeString(file, code);
} catch (e) {
  if (!fm.fileExists(file)) throw e;
  code = fm.readString(file);
}
const module = { exports: null };
new Function('module', code)(module);
await module.exports({ appUrl: APP });
