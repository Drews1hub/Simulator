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

// ---- AI coach: forwards the browser's request to Anthropic, adding the key ----
// The key comes from the ANTHROPIC_API_KEY environment variable and never reaches the browser.
// Only this computer may use it, so other devices on the network can't spend your credit.
const COACH_MODELS = new Set(['claude-opus-5-5']);
function isLoopback(addr) { return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'; }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
async function coachProxy(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return sendJSON(res, 503, { error: 'Start the server with ANTHROPIC_API_KEY set to use the coach' });
  if (!isLoopback(req.socket.remoteAddress)) return sendJSON(res, 403, { error: 'The coach is only available on the computer running the server' });
  let body;
  try { body = JSON.parse(await readBody(req, 512 * 1024)); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message || 'Invalid JSON' }); }
  if (!COACH_MODELS.has(body.model)) return sendJSON(res, 400, { error: 'Model not allowed' });
  body.max_tokens = Math.min(Number(body.max_tokens) || 16000, 16000);
  body.stream = true;
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2026-10-21',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return sendJSON(res, 502, { error: 'Could not reach Anthropic: ' + e.message });
  }
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
  try { for await (const chunk of upstream.body) res.write(chunk); } catch (_) { /* client went away */ }
  res.end();
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

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
  if (url.pathname === '/api/coach' && req.method === 'POST') return coachProxy(req, res);
  if (url.pathname.startsWith('/api/')) {
    const { status, body } = await (await marketReady).handleApi(url);
    // Local-only extra: tell the coach panel whether this server holds an Anthropic key.
    if (url.pathname === '/api/health') body.coach = !!process.env.ANTHROPIC_API_KEY;
    return sendJSON(res, status, body);
  }
  return serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`NYSE Day Trader Simulator running at http://localhost:${PORT}`));
}
module.exports = { server };
