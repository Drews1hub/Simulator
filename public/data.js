// Market-data sources. Both expose the same interface:
//   getQuotes(symbols) -> { SYM: quote | {error} }
//   getChart(symbol, range, interval) -> quote + { candles: [{t,o,h,l,c,v}] }
//   lookup(symbol) -> quote (with isNYSE)
//   label, supportsHistory
'use strict';

// ---- 1. Bundled Node server (Yahoo Finance proxy): full intraday history ----
class ServerSource {
  constructor() { this.label = 'Live · server'; this.supportsHistory = true; }
  static async available() {
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      return r.ok && (await r.json()).ok === true;
    } catch (_) { return false; }
  }
  async getQuotes(symbols) {
    const res = await fetch('api/quotes?symbols=' + symbols.join(','));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    return data;
  }
  async getChart(symbol, range, interval) {
    const res = await fetch(`api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    return d;
  }
  lookup(symbol) { return this.getChart(symbol, '1d', '1m'); }
}

// ---- 2. Finnhub (browser-direct, free API key): real-time trades over WebSocket ----
// Free tier has no historical candles, so charts are built from live trades
// from the moment the page is opened.
class FinnhubSource {
  constructor(key) {
    this.key = key;
    this.label = 'Live · Finnhub';
    this.supportsHistory = false;
    this.base = {};      // sym -> REST quote/profile snapshot
    this.last = {};      // sym -> { price, t }
    this.bars = {};      // sym -> 1-minute bars built from trades
    this.subs = new Set();
    this.loadBars();
    window.addEventListener('pagehide', () => this.saveBars(true));
    this.queue = [];     // REST calls, throttled to stay under 60/min
    this.pumping = false;
    this.connect();
  }

  static async verify(key) {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=KO&token=${encodeURIComponent(key)}`);
    if (r.status === 401 || r.status === 403) throw new Error('Finnhub rejected that API key');
    if (!r.ok) throw new Error('Finnhub HTTP ' + r.status);
    const q = await r.json();
    if (!(q.c > 0)) throw new Error('Finnhub returned no price for KO');
  }

  connect() {
    try { this.ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(this.key)}`); } catch (_) { return; }
    this.ws.onopen = () => this.subs.forEach((s) => this.ws.send(JSON.stringify({ type: 'subscribe', symbol: s })));
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type !== 'trade' || !Array.isArray(m.data)) return;
      for (const tr of m.data) this.onTrade(tr.s, tr.p, tr.t, tr.v || 0);
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => setTimeout(() => this.connect(), 5000);
  }

  // Bars are remembered in localStorage so the chart keeps history across visits.
  loadBars() {
    try {
      const saved = JSON.parse(localStorage.getItem('nyse-sim-fh-bars') || '{}');
      const cutoff = Date.now() - 3 * 86400000;
      for (const [sym, bars] of Object.entries(saved)) this.bars[sym] = bars.filter((b) => b.t > cutoff);
    } catch (_) { /* ignore corrupt cache */ }
  }
  saveBars(force = false) {
    const write = () => {
      this._saved = Date.now(); this._timer = null;
      try { localStorage.setItem('nyse-sim-fh-bars', JSON.stringify(this.bars)); } catch (_) { /* quota */ }
    };
    if (force) { clearTimeout(this._timer); return write(); }
    if (this._timer) return;
    const wait = Math.max(0, 5000 - (Date.now() - (this._saved || 0)));
    this._timer = setTimeout(write, wait);
  }

  // Record the polled price too, so a chart exists even when no trades are printing (market closed).
  seed(sym, price) {
    const bars = (this.bars[sym] = this.bars[sym] || []);
    const bt = Math.floor(Date.now() / 60000) * 60000;
    const b = bars[bars.length - 1];
    if (!b || (b.t < bt && b.c !== price)) this.onTrade(sym, price, Date.now(), 0);
    else if (b.t === bt) { b.h = Math.max(b.h, price); b.l = Math.min(b.l, price); b.c = price; }
  }

  onTrade(sym, price, t, v) {
    if (!(price > 0)) return;
    if (!this.last[sym] || t >= this.last[sym].t) this.last[sym] = { price, t };
    const bars = (this.bars[sym] = this.bars[sym] || []);
    const bt = Math.floor(t / 60000) * 60000;
    const b = bars[bars.length - 1];
    if (b && b.t === bt) { b.h = Math.max(b.h, price); b.l = Math.min(b.l, price); b.c = price; b.v += v; }
    else if (!b || bt > b.t) { bars.push({ t: bt, o: price, h: price, l: price, c: price, v }); if (bars.length > 1500) bars.shift(); this.saveBars(); }
  }

  subscribe(sym) {
    if (this.subs.has(sym)) return;
    this.subs.add(sym);
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
  }

  api(path, priority = false) {
    return new Promise((resolve, reject) => {
      this.queue[priority ? 'unshift' : 'push']({ path, resolve, reject });
      this.pump();
    });
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length) {
      const { path, resolve, reject } = this.queue.shift();
      try {
        const r = await fetch(`https://finnhub.io/api/v1/${path}&token=${encodeURIComponent(this.key)}`);
        if (r.status === 429) { this.queue.unshift({ path, resolve, reject }); await new Promise((ok) => setTimeout(ok, 5000)); continue; }
        if (!r.ok) throw new Error('Finnhub HTTP ' + r.status);
        resolve(await r.json());
      } catch (e) { reject(e); }
      await new Promise((ok) => setTimeout(ok, 1100)); // ~55 req/min
    }
    this.pumping = false;
  }

  async refreshBase(sym, priority = false) {
    const b = this.base[sym] || {};
    if (b.loading) return b.loading;
    b.loading = (async () => {
      if (!b.profile) b.profile = await this.api(`stock/profile2?symbol=${encodeURIComponent(sym)}`, priority).catch(() => ({}));
      b.q = await this.api(`quote?symbol=${encodeURIComponent(sym)}`, priority);
      b.at = Date.now();
    })().finally(() => { b.loading = null; });
    this.base[sym] = b;
    return b.loading;
  }

  toQuote(sym) {
    const b = this.base[sym];
    if (!b || !b.q) return null;
    const p = b.profile || {};
    const live = this.last[sym];
    const price = live && live.t > b.q.t * 1000 ? live.price : b.q.c;
    if (!(price > 0)) return { symbol: sym, error: 'Unknown symbol' };
    const prev = b.q.pc;
    return {
      symbol: sym, name: p.name || sym,
      exchange: p.exchange || '', exchangeName: p.exchange ? p.exchange.replace(/, INC\.?$/i, '') : 'US',
      isNYSE: /NYSE|NEW YORK STOCK EXCHANGE/i.test(p.exchange || ''),
      price, prevClose: prev, change: prev ? price - prev : 0, changePct: prev ? ((price - prev) / prev) * 100 : 0,
      dayHigh: Math.max(b.q.h || 0, price), dayLow: b.q.l ? Math.min(b.q.l, price) : price,
      volume: null, marketTime: live ? live.t : b.q.t * 1000, tradingPeriod: null,
    };
  }

  async getQuotes(symbols) {
    symbols.forEach((s) => this.subscribe(s));
    // Load unseen symbols and refresh stale snapshots in the background (rate-limited);
    // live prices arrive over the WebSocket in between.
    symbols.filter((s) => !this.base[s] || (!this.base[s].loading && Date.now() - (this.base[s].at || 0) > 120000))
      .forEach((s) => this.refreshBase(s).catch(() => {}));
    const out = {};
    for (const s of symbols) { const q = this.toQuote(s); if (q) { out[s] = q; if (!q.error) this.seed(s, q.price); } }
    this.saveBars();
    return out;
  }

  async getChart(symbol, range, interval) {
    this.subscribe(symbol);
    if (!this.base[symbol] || !this.base[symbol].q) await this.refreshBase(symbol, true);
    const q = this.toQuote(symbol);
    if (!q || q.error) throw new Error((q && q.error) || 'No data');
    const mins = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 }[interval] || 1;
    const out = [];
    for (const b of this.bars[symbol] || []) {
      const t = Math.floor(b.t / (mins * 60000)) * mins * 60000;
      const o = out[out.length - 1];
      if (o && o.t === t) { o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l); o.c = b.c; o.v += b.v; }
      else out.push({ ...b, t });
    }
    return { ...q, candles: out };
  }

  async lookup(symbol) {
    await this.refreshBase(symbol, true);
    const q = this.toQuote(symbol);
    if (!q || q.error) throw new Error('Unknown symbol');
    return q;
  }
}

window.DataSources = { ServerSource, FinnhubSource };
