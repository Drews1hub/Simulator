// Market-data proxy shared by the local Node server (server.js) and the
// Cloudflare Worker (worker/index.mjs). Fetches Yahoo Finance's public chart
// endpoint (browsers can't call it directly because of CORS) and normalizes it.
import Engine from '../public/engine.js';

const { FUTURES } = Engine; // futures contract table (MCL, CL, ...)
const UPSTREAM = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const CACHE_MS = 4000;
const STALE_MAX_MS = 10 * 60 * 1000;
// Exchange codes Yahoo uses for NYSE-family listings.
const NYSE_CODES = new Set(['NYQ', 'NYS', 'NYSE', 'ASE', 'PCX', 'NYSEArca', 'NYSE American']);
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const RANGES = new Set(['1d', '5d', '1mo']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m']);

export function normalize(r) {
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// `shared` is an optional cross-instance cache ({ get(key), put(key, data, ttlSec) }),
// e.g. Cloudflare's edge cache, so many users watching one symbol cost one upstream call.
export function createMarket({ shared = null } = {}) {
  const local = new Map(); // key -> { at, data }; also the stale fallback
  let backoffUntil = 0;    // set when Yahoo rate-limits us (HTTP 429)

  async function fetchChart(symbol, range = '1d', interval = '1m') {
    const key = `${symbol}|${range}|${interval}`;
    const hit = local.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    if (shared) {
      const data = await shared.get(key).catch(() => null);
      if (data) { local.set(key, { at: Date.now(), data }); return data; }
    }
    // While backing off, keep serving the last good data instead of hammering upstream.
    if (Date.now() < backoffUntil) {
      if (hit && Date.now() - hit.at < STALE_MAX_MS) return { ...hit.data, stale: true };
      throw httpError(503, 'Rate limited by data provider, retrying shortly');
    }

    const f = FUTURES[symbol];
    const upstream = f ? f.yahoo : symbol; // e.g. MCL -> MCL=F (continuous front-month contract)
    const url = `${UPSTREAM}${encodeURIComponent(upstream)}?range=${range}&interval=${interval}&includePrePost=true`;
    let res, body;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NYSE-Sim)' }, signal: AbortSignal.timeout(8000) });
      body = await res.json().catch(() => null);
    } catch (e) {
      if (hit) return { ...hit.data, stale: true };
      throw httpError(502, 'Data provider unreachable: ' + e.message);
    }
    if (res.status === 429) {
      backoffUntil = Date.now() + 15000;
      console.warn('Upstream rate limit hit; backing off 15s');
      if (hit) return { ...hit.data, stale: true };
    }
    const result = body && body.chart && body.chart.result && body.chart.result[0];
    if (!res.ok || !result) {
      const msg = (body && body.chart && body.chart.error && body.chart.error.description) || `Upstream HTTP ${res.status}`;
      throw httpError(res.status === 404 ? 404 : 502, msg);
    }
    const data = normalize(result);
    if (f) Object.assign(data, { symbol, name: f.name, isFuture: true, isNYSE: false, exchange: 'NYMEX', exchangeName: 'NYMEX (futures, delayed)' });
    local.set(key, { at: Date.now(), data });
    if (shared) await shared.put(key, data, Math.ceil(CACHE_MS / 1000)).catch(() => {});
    return data;
  }

  // Company-name / ticker search. Yahoo's public search endpoint; cached for 10 min.
  const searchCache = new Map();
  async function searchCompanies(q) {
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < 600000) return hit.data;
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NYSE-Sim)' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw httpError(502, 'Search unavailable right now');
    const body = await res.json();
    const data = (body.quotes || [])
      .filter((x) => x.quoteType === 'EQUITY' && x.symbol && !x.symbol.includes('=') && !x.symbol.includes('.'))
      .slice(0, 8)
      .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange || '' }));
    const fut = Object.entries(FUTURES)
      .filter(([sym, f]) => sym.toLowerCase() === key || f.name.toLowerCase().includes(key) || (/^(oil|crude|wti)/.test(key) && f.unit === 'barrels'))
      .map(([sym, f]) => ({ symbol: sym, name: f.name, exchange: 'NYMEX' }));
    const all = fut.concat(data.filter((d) => !FUTURES[d.symbol])).slice(0, 8);
    searchCache.set(key, { at: Date.now(), data: all });
    return all;
  }

  // Routes /api/* requests. Returns { status, body } for the caller to serialize.
  async function handleApi(url) {
    try {
      if (url.pathname === '/api/health') return { status: 200, body: { ok: true, source: 'yahoo' } };
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
        if (q.length < 2) return { status: 200, body: [] };
        return { status: 200, body: await searchCompanies(q) };
      }
      if (url.pathname === '/api/chart') {
        const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
        const range = url.searchParams.get('range') || '1d';
        const interval = url.searchParams.get('interval') || '1m';
        if (!SYMBOL_RE.test(symbol)) return { status: 400, body: { error: 'Invalid symbol' } };
        if (!RANGES.has(range) || !INTERVALS.has(interval)) return { status: 400, body: { error: 'Invalid range/interval' } };
        return { status: 200, body: await fetchChart(symbol, range, interval) };
      }
      if (url.pathname === '/api/quotes') {
        const symbols = (url.searchParams.get('symbols') || '').toUpperCase().split(',').filter(Boolean).slice(0, 40);
        if (!symbols.every((s) => SYMBOL_RE.test(s))) return { status: 400, body: { error: 'Invalid symbol list' } };
        const out = {};
        await Promise.all(symbols.map(async (s) => {
          try {
            const { candles, ...q } = await fetchChart(s);
            out[s] = q;
          } catch (e) {
            out[s] = { symbol: s, error: e.message };
          }
        }));
        return { status: 200, body: out };
      }
      return { status: 404, body: { error: 'Unknown endpoint' } };
    } catch (e) {
      return { status: e.status || 500, body: { error: e.message } };
    }
  }

  return { fetchChart, handleApi };
}
