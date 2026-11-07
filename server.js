// NYSE Day Trader Simulator — zero-dependency local Node server.
// Serves the static UI and proxies live market data (see lib/market.mjs, which
// the Cloudflare Worker in worker/index.mjs shares for production).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const marketReady = import('./lib/market.mjs').then((m) => m.createMarket());

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return sendJSON(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const { status, body } = await (await marketReady).handleApi(url);
    return sendJSON(res, status, body);
  }
  return serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`NYSE Day Trader Simulator running at http://localhost:${PORT}`));
}
module.exports = { server };
