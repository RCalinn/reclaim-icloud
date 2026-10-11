// Test server for the end-to-end run: serves the extension folder at /, the harness at /__h/
// (review.html with the fake `browser` API injected, and the synthetic library as JSON), and
// the library's thumbnails as PNGs rendered from tests/fixtures.js. Nothing is written to disk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { library } from '../fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(rgba, w = 64, h = 64) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function start(port = 8765, { latency = 0, throttle = 0, bursts = 45, ttl = 0 } = {}) {
  const items = library(4, bursts);
  const pngs = new Map(items.map((p) => [p.id, png(p.px)]));
  const libJson = JSON.stringify(items.map(({ px, lab, ...rest }) => ({ ...rest, lab: [...lab] })));
  const page = () => fs.readFileSync(path.join(ROOT, 'review.html'), 'utf8')
    .replace('<head>', `<head>\n  <base href="/">\n  <script>window.__ttl = ${ttl};</script>\n  <script src="/__h/mock.js"></script>`);

  const stats = { active: 0, peak: 0, expired: 0 };
  let blockModel = false; // /__h/model?block=1: the model file 404s, to test the classic fallback
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    const send = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    let m;
    if ((m = pathname.match(/^\/img\/(\w+)\.png$/)) && pngs.has(m[1])) {
      // Behave like a real CDN: some latency, and occasional throttling (`throttle` = share of requests answered 429).
      const exp = +searchParams.get('exp');
      if (exp && Date.now() > exp) { stats.expired++; res.writeHead(403); return res.end(); }
      if (Math.random() < throttle) { res.writeHead(429); return res.end(); }
      stats.peak = Math.max(stats.peak, ++stats.active);
      return setTimeout(() => { stats.active--; send('image/png', pngs.get(m[1])); }, latency);
    }
    if (pathname === '/__h/test.html') return send('text/html', page());
    if (pathname === '/__h/library.json') return send('application/json', libJson);
    if (pathname === '/__h/model') { blockModel = searchParams.get('block') === '1'; return send('text/plain', 'ok'); }
    if (pathname.endsWith('.onnx') && blockModel) { res.writeHead(404); return res.end(); }
    const file = pathname === '/__h/mock.js' ? path.join(HERE, 'mock.js') : path.join(ROOT, decodeURIComponent(pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      send(types[path.extname(file)] || 'application/octet-stream', data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, count: items.length, stats })));
}
