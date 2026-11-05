// NYSE Day Trader Simulator — zero-dependency Node server.
// Serves the static UI and proxies live market data from Yahoo Finance's
// public chart endpoint (browsers can't call it directly because of CORS).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UPSTREAM = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const CACHE_MS = 4000;
// Exchange codes Yahoo uses for NYSE-family listings.
const NYSE_CODES = new Set(['NYQ', 'NYS', 'NYSE', 'ASE', 'PCX', 'NYSEArca', 'NYSE American']);

const cache = new Map(); // key -> { at, data }

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const RANGES = new Set(['1d', '5d', '1mo']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m']);

let backoffUntil = 0; // set when Yahoo rate-limits us (HTTP 429)
const STALE_MAX_MS = 10 * 60 * 1000;

async function fetchChart(symbol, range = '1d', interval = '1m') {
  const key = `${symbol}|${range}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  // While backing off, keep serving the last good data instead of hammering upstream.
  if (Date.now() < backoffUntil) {
    if (hit && Date.now() - hit.at < STALE_MAX_MS) return { ...hit.data, stale: true };
    const err = new Error('Rate limited by data provider, retrying shortly');
    err.status = 503;
    throw err;
  }

  const url = `${UPSTREAM}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=true`;
  let res, body;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NYSE-Sim)' }, signal: AbortSignal.timeout(8000) });
    body = await res.json().catch(() => null);
  } catch (e) {
    if (hit) return { ...hit.data, stale: true };
    const err = new Error('Data provider unreachable: ' + e.message);
    err.status = 502;
    throw err;
  }
  if (res.status === 429) {
    backoffUntil = Date.now() + 15000;
    console.warn('Upstream rate limit hit; backing off 15s');
    if (hit) return { ...hit.data, stale: true };
  }
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  if (!res.ok || !result) {
    const msg = (body && body.chart && body.chart.error && body.chart.error.description) || `Upstream HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  const data = normalize(result);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function normalize(r) {
  const m = r.meta || {};
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const ts = r.timestamp || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close == null || q.close[i] == null) continue;
    candles.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  }
  const last = candles.length ? candles[candles.length - 1] : null;
  // Latest trade includes pre/post-market prints when available.
  const price = last && last.t > (m.regularMarketTime || 0) * 1000 ? last.c : m.regularMarketPrice;
  const prevClose = m.chartPreviousClose ?? m.previousClose;
  return {
    symbol: m.symbol,
    name: m.longName || m.shortName || m.symbol,
    exchange: m.exchangeName,
    exchangeName: m.fullExchangeName,
    isNYSE: NYSE_CODES.has(m.exchangeName) || /NYSE/i.test(m.fullExchangeName || ''),
    currency: m.currency,
    price,
    regularMarketPrice: m.regularMarketPrice,
    prevClose,
    change: prevClose ? price - prevClose : 0,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
    volume: m.regularMarketVolume,
    marketTime: (last ? last.t : (m.regularMarketTime || 0) * 1000),
    tradingPeriod: m.currentTradingPeriod || null,
    candles,
  };
}

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
  try {
    if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, source: 'yahoo' });
    if (url.pathname === '/api/chart') {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
      const range = url.searchParams.get('range') || '1d';
      const interval = url.searchParams.get('interval') || '1m';
      if (!SYMBOL_RE.test(symbol)) return sendJSON(res, 400, { error: 'Invalid symbol' });
      if (!RANGES.has(range) || !INTERVALS.has(interval)) return sendJSON(res, 400, { error: 'Invalid range/interval' });
      return sendJSON(res, 200, await fetchChart(symbol, range, interval));
    }
    if (url.pathname === '/api/quotes') {
      const symbols = (url.searchParams.get('symbols') || '').toUpperCase().split(',').filter(Boolean).slice(0, 40);
      if (!symbols.every((s) => SYMBOL_RE.test(s))) return sendJSON(res, 400, { error: 'Invalid symbol list' });
      const out = {};
      await Promise.all(symbols.map(async (s) => {
        try {
          const { candles, ...q } = await fetchChart(s);
          out[s] = q;
        } catch (e) {
          out[s] = { symbol: s, error: e.message };
        }
      }));
      return sendJSON(res, 200, out);
    }
    if (url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return sendJSON(res, e.status || 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`NYSE Day Trader Simulator running at http://localhost:${PORT}`));
}
module.exports = { server, normalize };
