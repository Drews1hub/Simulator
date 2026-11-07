/* global Engine */
'use strict';

const STORE_KEY = 'nyse-sim-v1';
const DEFAULT_WATCH = ['JPM', 'KO', 'IBM', 'DIS', 'BA', 'GE', 'XOM', 'WMT', 'V', 'BAC', 'NKE', 'F', 'CVX', 'GS', 'T'];
const QUOTE_MS = 5000;
const CHART_MS = 20000;

// ---------- state ----------
let store = migrate(load());
const quotes = {};          // sym -> latest quote
let chartData = null;
let chartRange = { r: '1d', i: '1m' };
let side = 'buy';
let activeTab = 'positions';
let src = null;               // active market-data source (see data.js)
const ind = { vwap: true, ema9: true, ema21: false };

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.acct && s.watch) return s;
  } catch (_) { /* fall through */ }
  return { acct: Engine.createAccount(), watch: DEFAULT_WATCH.slice(), selected: 'JPM', allowOutside: true, dayStart: null };
}
function migrate(s) {
  return { autoFlatten: false, sound: true, equityHist: [], finnhubKey: '', lastAutoFlatten: '', ...s };
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
  scheduleCloudPush();
}

// ---------- optional cloud sync (Supabase; see auth.js) ----------
// finnhubKey stays in this browser only and is never uploaded.
let cloudReady = false, pushTimer = null;
const cloudCopy = () => { const { finnhubKey, ...rest } = store; return rest; };
function scheduleCloudPush() {
  if (!cloudReady) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try { await Auth.push(cloudCopy()); setSyncLabel('synced'); } catch (e) { setSyncLabel('sync failed'); console.warn(e); }
  }, 1500);
}
function setSyncLabel(t) { const el = document.getElementById('aSync'); if (el) el.textContent = t; }

const $ = (id) => document.getElementById(id);
const fmt$ = (x) => (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPx = (x) => x == null ? '—' : x.toFixed(2);
const fmtPct = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
const cls = (x) => x > 0 ? 'up' : x < 0 ? 'down' : '';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const prices = () => Object.fromEntries(Object.entries(quotes).filter(([, q]) => q.price > 0).map(([s, q]) => [s, q.price]));

// ---------- market session (America/New_York) ----------
function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, mins: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
function session() {
  // Prefer the exchange's own trading-period data (handles holidays & early closes).
  const tp = Object.values(quotes).find((q) => q.tradingPeriod)?.tradingPeriod;
  const now = Date.now() / 1000;
  if (tp && tp.regular && tp.pre && tp.post && now >= tp.pre.start && now < tp.post.end) {
    if (now >= tp.regular.start && now < tp.regular.end) return { state: 'open', label: 'NYSE Open' };
    if (now >= tp.pre.start && now < tp.pre.end) return { state: 'ext', label: 'Pre-Market' };
    if (now >= tp.post.start && now < tp.post.end) return { state: 'ext', label: 'After Hours' };
    return { state: 'closed', label: 'Market Closed' };
  }
  const { wd, mins } = etParts();
  if (wd === 'Sat' || wd === 'Sun') return { state: 'closed', label: 'Market Closed (weekend)' };
  if (mins >= 570 && mins < 960) return { state: 'open', label: 'NYSE Open' };
  if (mins >= 240 && mins < 570) return { state: 'ext', label: 'Pre-Market' };
  if (mins >= 960 && mins < 1200) return { state: 'ext', label: 'After Hours' };
  return { state: 'closed', label: 'Market Closed' };
}
const canTrade = () => session().state === 'open' || store.allowOutside;

// ---------- data ----------
function trackedSymbols() {
  const set = new Set(store.watch);
  Object.keys(store.acct.positions).forEach((s) => set.add(s));
  store.acct.orders.filter((o) => o.status === 'open').forEach((o) => set.add(o.symbol));
  if (store.selected) set.add(store.selected);
  return [...set];
}

async function pollQuotes() {
  const syms = trackedSymbols();
  if (!syms.length || !src) return;
  try {
    const data = await src.getQuotes(syms);
    for (const [s, q] of Object.entries(data)) {
      if (q.error) { if (!quotes[s]) quotes[s] = { symbol: s, error: q.error }; continue; }
      const prev = quotes[s];
      q.flash = prev && prev.price && q.price !== prev.price ? (q.price > prev.price ? 'up' : 'down') : '';
      quotes[s] = q;
    }
    const stale = Object.values(data).some((q) => q.stale);
    $('lastUpdate').textContent = (stale ? 'Delayed (provider rate limit) · ' : src.label + ' · ') + new Date().toLocaleTimeString();
    $('lastUpdate').className = stale ? 'warn' : 'muted';
    if (canTrade()) {
      const fills = Engine.processPrices(store.acct, prices());
      fills.forEach(announceFill);
      autoFlattenCheck();
    }
    rollDay();
    sampleEquity();
    save();
    if (chartData && quotes[chartData.symbol]) mergeLiveCandle(quotes[chartData.symbol]);
    renderAll();
  } catch (e) {
    $('lastUpdate').textContent = 'Data error: ' + e.message;
    $('lastUpdate').className = 'down';
  }
}

async function loadChart() {
  const sym = store.selected;
  if (!sym) return;
  try {
    if (!src) return;
    const d = await src.getChart(sym, chartRange.r, chartRange.i);
    if (sym !== store.selected) return;
    chartData = d;
    const { candles, ...q } = d;
    quotes[sym] = { ...quotes[sym], ...q };
    drawChart();
    renderTicketQuote();
  } catch (e) {
    toast(`Chart for ${sym}: ${e.message}`, 'err');
  }
}

function mergeLiveCandle(q) {
  const c = chartData.candles;
  if (!c.length || !(q.price > 0)) return;
  if (!src.supportsHistory) { loadChart(); return; } // Finnhub: bars are rebuilt from trades
  const last = c[c.length - 1];
  last.c = q.price; last.h = Math.max(last.h, q.price); last.l = Math.min(last.l, q.price);
  drawChart();
}

// Snapshot equity at the start of each ET trading day for Day P&L.
function rollDay() {
  const today = etParts().date;
  if (!store.dayStart || store.dayStart.date !== today) {
    store.dayStart = { date: today, equity: Engine.equity(store.acct, prices()) };
  }
}

function announceFill(f) {
  toast(`Filled ${f.side.toUpperCase()} ${f.qty} ${f.symbol} @ ${fmtPx(f.price)}${f.realized ? ' · P&L ' + fmt$(f.realized) : ''}`, 'ok');
  if (store.sound) beep(f.side === 'buy' ? 880 : 660);
}

let audioCtx = null;
function beep(freq) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.16);
  } catch (_) { /* audio unavailable */ }
}

// Record equity at most once a minute (for the equity curve).
function sampleEquity() {
  const h = store.equityHist, now = Date.now();
  if (h.length && now - h[h.length - 1].t < 60000) return;
  h.push({ t: now, eq: Engine.equity(store.acct, prices()) });
  if (h.length > 3000) h.splice(0, h.length - 3000);
}

// Optional end-of-day discipline: flatten at 15:55 ET during the regular session.
function autoFlattenCheck() {
  if (!store.autoFlatten || session().state !== 'open') return;
  const { mins, date } = etParts();
  if (mins >= 955 && store.lastAutoFlatten !== date) {
    store.lastAutoFlatten = date;
    if (Object.keys(store.acct.positions).length) { toast('15:55 ET — auto-flattening all positions', 'ok'); flatten(); }
  }
}

function exportCSV() {
  const rows = [['time', 'symbol', 'side', 'qty', 'price', 'fee', 'realized_pnl']]
    .concat(store.acct.fills.map((f) => [new Date(f.time).toISOString(), f.symbol, f.side, f.qty, f.price, f.fee, f.realized]));
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `nyse-sim-trades-${etParts().date}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- rendering ----------
function renderAll() {
  renderHeader(); renderWatch(); renderTicketQuote(); renderEstimate(); renderTab();
}

function renderHeader() {
  const px = prices(), a = store.acct;
  const eq = Engine.equity(a, px), un = Engine.unrealized(a, px);
  const day = store.dayStart ? eq - store.dayStart.equity : 0;
  $('mEquity').textContent = fmt$(eq);
  $('mDayPnl').textContent = fmt$(day); $('mDayPnl').className = cls(day);
  $('mUnreal').textContent = fmt$(un); $('mUnreal').className = cls(un);
  $('mReal').textContent = fmt$(a.realized - a.commissions); $('mReal').className = cls(a.realized - a.commissions);
  $('mBP').textContent = fmt$(Engine.buyingPower(a, px));
  $('mCash').textContent = fmt$(a.cash);
  const s = session();
  $('marketStatus').textContent = s.label;
  $('marketStatus').className = 'status-pill ' + s.state;
  const b = $('banner');
  if (s.state !== 'open') {
    b.textContent = store.allowOutside
      ? `${s.label}: orders fill against the latest extended-hours or last-close price. Turn this off in Settings to trade only during the regular session (9:30–16:00 ET).`
      : `${s.label}: trading is paused until the NYSE regular session opens (9:30 ET). Quotes keep updating.`;
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}

function renderWatch() {
  const tb = $('watchTable').querySelector('tbody');
  tb.innerHTML = store.watch.map((s) => {
    const q = quotes[s] || {};
    const pos = store.acct.positions[s];
    return `<tr data-s="${s}" class="${s === store.selected ? 'sel' : ''}">
      <td><span class="sym">${s}</span>${pos ? ` <span class="${pos.qty > 0 ? 'up' : 'down'}" title="position">●</span>` : ''}</td>
      <td class="r ${q.flash ? 'flash-' + q.flash : ''}">${q.error ? '<span class="down" title="' + esc(q.error) + '">err</span>' : fmtPx(q.price)}</td>
      <td class="r ${cls(q.changePct)}">${q.changePct != null ? fmtPct(q.changePct) : ''}</td>
      <td><button class="x" data-rm="${s}" title="Remove">×</button></td></tr>`;
  }).join('');
}

function renderTicketQuote() {
  const s = $('oSymbol').value.toUpperCase();
  const q = quotes[s];
  const box = $('oQuote');
  if (!q || !q.price) { box.innerHTML = s ? '<span class="muted">Loading quote…</span>' : '—'; return; }
  const pos = store.acct.positions[s];
  box.innerHTML = `<div class="big">${fmtPx(q.price)} <small class="${cls(q.change)}">${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${fmtPct(q.changePct)})</small></div>
    <div class="muted">H ${fmtPx(q.dayHigh)} · L ${fmtPx(q.dayLow)} · Vol ${q.volume != null ? q.volume.toLocaleString() : '—'}</div>
    <div class="muted">Position: ${pos ? `${pos.qty} @ ${fmtPx(pos.avgPrice)}` : 'flat'}</div>`;
}

function renderEstimate() {
  const s = $('oSymbol').value.toUpperCase();
  const q = quotes[s], qty = Math.floor(Number($('oQty').value));
  const type = $('oType').value;
  const btn = $('btnSubmit');
  btn.className = 'btn submit ' + side;
  const pos = store.acct.positions[s];
  let verb = side === 'buy' ? (pos && pos.qty < 0 ? 'Buy to Cover' : 'Buy') : (pos && pos.qty > 0 ? 'Sell' : 'Sell Short');
  btn.textContent = `${verb} ${qty > 0 ? qty : ''} ${s} ${type !== 'market' ? type.toUpperCase() : 'MKT'}`;
  btn.disabled = !canTrade() || !q || !q.price;
  if (!q || !q.price || !(qty > 0)) { $('oEst').textContent = '—'; return; }
  const px = type === 'market' ? q.price : Number($('oPrice').value) || q.price;
  const fee = Engine.commissionFor(store.acct.settings, qty);
  let rr = '';
  if ($('oBracket').checked) {
    const sl = Number($('oSL').value), tp = Number($('oTP').value);
    const risk = sl ? Math.abs(px - sl) * qty : 0, reward = tp ? Math.abs(tp - px) * qty : 0;
    rr = `<br>Risk <span class="down">${fmt$(risk)}</span> · Reward <span class="up">${fmt$(reward)}</span>${risk && reward ? ` · R:R 1:${(reward / risk).toFixed(1)}` : ''}`;
  }
  $('oEst').innerHTML = `Est. value ${fmt$(px * qty)} · commission ${fmt$(fee)}<br>Buying power ${fmt$(Engine.buyingPower(store.acct, prices()))}${rr}`;
}

function renderTab() {
  const body = $('tabBody'), a = store.acct, px = prices();
  if (activeTab === 'positions') {
    const rows = Object.entries(a.positions);
    if (!rows.length) { body.innerHTML = '<div class="empty">No open positions. Pick a stock and place an order.</div>'; return; }
    body.innerHTML = `<table class="tbl"><thead><tr><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Avg</th><th class="r">Last</th><th class="r">Mkt Value</th><th class="r">Unrealized</th><th class="r">%</th><th></th></tr></thead><tbody>` +
      rows.map(([s, p]) => {
        const last = px[s] ?? p.avgPrice, u = (last - p.avgPrice) * p.qty, pct = (u / (p.avgPrice * Math.abs(p.qty))) * 100;
        return `<tr><td class="sym">${s}</td><td class="${p.qty > 0 ? 'up' : 'down'}">${p.qty > 0 ? 'LONG' : 'SHORT'}</td><td class="r">${Math.abs(p.qty)}</td><td class="r">${fmtPx(p.avgPrice)}</td><td class="r">${fmtPx(last)}</td><td class="r">${fmt$(Math.abs(p.qty) * last)}</td><td class="r ${cls(u)}">${fmt$(u)}</td><td class="r ${cls(u)}">${fmtPct(pct)}</td><td><button class="btn small" data-close="${s}">Close</button></td></tr>`;
      }).join('') + '</tbody></table>';
  } else if (activeTab === 'orders') {
    const rows = a.orders.filter((o) => o.status === 'open');
    if (!rows.length) { body.innerHTML = '<div class="empty">No working orders.</div>'; return; }
    body.innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Type</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Last</th><th>Placed</th><th></th></tr></thead><tbody>` +
      rows.map((o) => `<tr><td>${o.id}</td><td class="sym">${o.symbol}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side.toUpperCase()}</td><td>${o.type.toUpperCase()}${o.tag ? ` <span class="tag">${o.tag}</span>` : ''}${o.bracket ? ' <span class="tag">+BRACKET</span>' : ''}</td><td class="r">${o.qty}</td><td class="r">${fmtPx(o.limitPrice ?? o.stopPrice)}</td><td class="r">${fmtPx(px[o.symbol])}</td><td>${new Date(o.createdAt).toLocaleTimeString()}</td><td><button class="btn small" data-cancel="${o.id}">Cancel</button></td></tr>`).join('') + '</tbody></table>';
  } else if (activeTab === 'fills') {
    const rows = a.fills.slice().reverse();
    if (!rows.length) { body.innerHTML = '<div class="empty">No trades yet.</div>'; return; }
    body.innerHTML = `<div class="tab-tools"><button class="btn small" data-export="1">Export CSV</button></div><table class="tbl"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fee</th><th class="r">Realized P&amp;L</th></tr></thead><tbody>` +
      rows.map((f) => `<tr><td>${new Date(f.time).toLocaleString()}</td><td class="sym">${f.symbol}</td><td class="${f.side === 'buy' ? 'up' : 'down'}">${f.side.toUpperCase()}</td><td class="r">${f.qty}</td><td class="r">${fmtPx(f.price)}</td><td class="r">${fmt$(f.fee)}</td><td class="r ${cls(f.realized)}">${f.realized ? fmt$(f.realized) : ''}</td></tr>`).join('') + '</tbody></table>';
  } else {
    requestAnimationFrame(drawEquityCurve);
    const closes = a.fills.filter((f) => f.realized !== 0);
    const wins = closes.filter((f) => f.realized > 0), losses = closes.filter((f) => f.realized < 0);
    const sum = (arr) => arr.reduce((t, f) => t + f.realized, 0);
    const eq = Engine.equity(a, px), start = a.settings.startingCash;
    const fiveDays = Date.now() - 7 * 86400000;
    const dt = Engine.dayTradeCount(a, fiveDays);
    const stat = (l, v, c = '') => `<div class="stat"><label>${l}</label><b class="${c}">${v}</b></div>`;
    body.innerHTML = '<div class="stats-grid">' +
      stat('Total return', fmtPct(((eq - start) / start) * 100), cls(eq - start)) +
      stat('Net P&L', fmt$(eq - start), cls(eq - start)) +
      stat('Closing trades', closes.length) +
      stat('Win rate', closes.length ? ((wins.length / closes.length) * 100).toFixed(1) + '%' : '—') +
      stat('Avg win', wins.length ? fmt$(sum(wins) / wins.length) : '—', 'up') +
      stat('Avg loss', losses.length ? fmt$(sum(losses) / losses.length) : '—', 'down') +
      stat('Profit factor', losses.length ? (sum(wins) / -sum(losses)).toFixed(2) : '—') +
      stat('Commissions paid', fmt$(a.commissions)) +
      stat('Day trades (5 sessions)', dt, dt >= 4 && eq < 25000 ? 'down' : '') +
      '</div><div class="eq-wrap"><div class="muted eq-title">Equity curve</div><canvas id="eqCurve"></canvas></div>' +
      (dt >= 4 && eq < 25000 ? '<p class="empty down">Pattern Day Trader flag: 4+ day trades in 5 sessions with under $25,000 equity would restrict a real margin account.</p>' : '');
  }
}

function drawEquityCurve() {
  const cv = $('eqCurve'); if (!cv) return;
  const h = store.equityHist.concat([{ t: Date.now(), eq: Engine.equity(store.acct, prices()) }]);
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const base = store.acct.settings.startingCash;
  let lo = Math.min(base, ...h.map((p) => p.eq)), hi = Math.max(base, ...h.map((p) => p.eq));
  const pad = (hi - lo) * 0.1 || base * 0.001; lo -= pad; hi += pad;
  const y = (v) => 4 + (hi - v) / (hi - lo) * (H - 8);
  const x = (i) => h.length > 1 ? 50 + i / (h.length - 1) * (W - 54) : 50;
  g.font = '10px ui-sans-serif, system-ui'; g.fillStyle = '#7d8a99'; g.textBaseline = 'middle';
  g.fillText(fmt$(hi).replace(/\.\d+$/, ''), 0, 8); g.fillText(fmt$(lo).replace(/\.\d+$/, ''), 0, H - 8);
  g.setLineDash([3, 4]); g.strokeStyle = '#7d8a99'; g.beginPath(); g.moveTo(50, y(base)); g.lineTo(W, y(base)); g.stroke(); g.setLineDash([]);
  const last = h[h.length - 1].eq;
  g.strokeStyle = last >= base ? '#22c55e' : '#ef4444'; g.lineWidth = 1.5; g.beginPath();
  h.forEach((p, i) => (i ? g.lineTo(x(i), y(p.eq)) : g.moveTo(x(i), y(p.eq)))); g.stroke(); g.lineWidth = 1;
}

function ema(vals, n) {
  const k = 2 / (n + 1), out = []; let e;
  vals.forEach((v, i) => { e = i ? v * k + e * (1 - k) : v; out.push(e); });
  return out;
}
// VWAP resets each ET trading day.
function vwap(candles) {
  let pv = 0, vol = 0, day = '';
  return candles.map((c) => {
    const d = new Date(c.t).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; vol += c.v;
    return vol ? pv / vol : null;
  });
}

// ---------- chart (canvas) ----------
function drawChart() {
  const cv = $('chart'), wrap = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!chartData) return;

  const d = chartData;
  $('chartTitle').textContent = `${d.symbol} · ${d.name}`;
  $('chartSub').innerHTML = `${esc(d.exchangeName || d.exchange)} · ${fmtPx(d.price)} <span class="${cls(d.change)}">${fmtPct(d.changePct || 0)}</span>`;

  const candles = d.candles;
  if (!candles.length) {
    g.fillStyle = '#7d8a99'; g.font = '13px ui-sans-serif, system-ui';
    g.fillText(src && !src.supportsHistory ? 'Building chart from live trades… (Finnhub mode has no history; bars appear as trades print)' : 'No intraday data yet', 20, 30);
    return;
  }
  const padR = 64, padB = 22, volH = 60;
  const plotW = W - padR, plotH = H - padB - volH - 8;
  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vmax = Math.max(vmax, c.v); }
  const pos = store.acct.positions[d.symbol];
  const levels = [];
  if (pos) levels.push({ p: pos.avgPrice, color: '#3b82f6', label: `AVG ${pos.qty}` });
  store.acct.orders.filter((o) => o.status === 'open' && o.symbol === d.symbol)
    .forEach((o) => levels.push({ p: o.limitPrice ?? o.stopPrice, label: o.tag ? `${o.tag === 'SL' ? 'STOP-LOSS' : 'TAKE-PROFIT'}` : `${o.side.toUpperCase()} ${o.type.toUpperCase()}`, color: o.tag === 'SL' ? '#ef4444' : o.tag === 'TP' ? '#22c55e' : '#f59e0b' }));
  levels.forEach((l) => { lo = Math.min(lo, l.p); hi = Math.max(hi, l.p); });
  if (d.prevClose && d.prevClose > lo * 0.97 && d.prevClose < hi * 1.03) { lo = Math.min(lo, d.prevClose); hi = Math.max(hi, d.prevClose); }
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const y = (p) => 6 + (hi - p) / (hi - lo) * plotH;
  const step = plotW / Math.max(candles.length, 60), bw = Math.max(1, step * 0.7); // min 60 slots so sparse charts aren't stretched

  // grid + price axis
  g.font = '11px ui-sans-serif, system-ui'; g.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const p = lo + (hi - lo) * i / 5, yy = y(p);
    g.strokeStyle = '#1a2230'; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
    g.fillStyle = '#7d8a99'; g.fillText(p.toFixed(2), plotW + 6, yy);
  }
  // time axis
  g.textBaseline = 'top';
  const multiDay = chartRange.r !== '1d';
  const every = Math.ceil(candles.length / 6);
  for (let i = 0; i < candles.length; i += every) {
    const t = new Date(candles[i].t);
    const lbl = multiDay ? t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
      : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
    g.fillStyle = '#7d8a99'; g.fillText(lbl, i * step, H - padB + 6);
  }
  // prev close
  if (d.prevClose && d.prevClose > lo && d.prevClose < hi) {
    g.setLineDash([2, 4]); g.strokeStyle = '#7d8a99'; g.beginPath(); g.moveTo(0, y(d.prevClose)); g.lineTo(plotW, y(d.prevClose)); g.stroke(); g.setLineDash([]);
  }
  // candles + volume
  const volTop = H - padB - volH;
  candles.forEach((c, i) => {
    const x = i * step + step / 2, up = c.c >= c.o;
    g.strokeStyle = g.fillStyle = up ? '#22c55e' : '#ef4444';
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    const top = y(Math.max(c.o, c.c)), h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    g.fillRect(x - bw / 2, top, bw, h);
    g.globalAlpha = 0.35;
    const vh = vmax ? (c.v / vmax) * volH : 0;
    g.fillRect(x - bw / 2, volTop + volH - vh, bw, vh);
    g.globalAlpha = 1;
  });
  // indicators
  const line = (vals, color) => {
    g.strokeStyle = color; g.lineWidth = 1.3; g.beginPath(); let started = false;
    vals.forEach((v, i) => { if (v == null) return; const xx = i * step + step / 2; started ? g.lineTo(xx, y(v)) : g.moveTo(xx, y(v)); started = true; });
    g.stroke(); g.lineWidth = 1;
  };
  const closes = candles.map((c) => c.c);
  if (ind.vwap && candles.some((c) => c.v)) line(vwap(candles), '#a855f7');
  if (ind.ema9) line(ema(closes, 9), '#38bdf8');
  if (ind.ema21) line(ema(closes, 21), '#f472b6');

  // position / order levels
  g.textBaseline = 'middle';
  levels.forEach((l) => {
    const yy = y(l.p);
    g.setLineDash([6, 4]); g.strokeStyle = l.color; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.setLineDash([]);
    g.fillStyle = l.color; g.fillText(`${l.label} ${l.p.toFixed(2)}`, 6, yy - 8);
  });
  // last price tag
  const last = candles[candles.length - 1].c, ly = y(last);
  g.fillStyle = last >= (d.prevClose || last) ? '#22c55e' : '#ef4444';
  g.fillRect(plotW, ly - 9, padR, 18);
  g.fillStyle = '#fff'; g.fillText(last.toFixed(2), plotW + 6, ly);

  cv._geom = { step, plotW, candles };
}

$('chart').addEventListener('mousemove', (e) => {
  const geo = e.target._geom, tip = $('chartTip');
  if (!geo) return;
  const rect = e.target.getBoundingClientRect();
  const i = Math.floor((e.clientX - rect.left) / geo.step);
  const c = geo.candles[i];
  if (!c || e.clientX - rect.left > geo.plotW) { tip.classList.add('hidden'); return; }
  tip.classList.remove('hidden');
  tip.textContent = `${new Date(c.t).toLocaleString([], { timeZone: 'America/New_York' })} ET  O ${c.o.toFixed(2)}  H ${c.h.toFixed(2)}  L ${c.l.toFixed(2)}  C ${c.c.toFixed(2)}  V ${c.v.toLocaleString()}`;
});
$('chart').addEventListener('mouseleave', () => $('chartTip').classList.add('hidden'));
window.addEventListener('resize', drawChart);

// ---------- actions ----------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function selectSymbol(s) {
  store.selected = s; save();
  $('oSymbol').value = s;
  chartData = null; drawChart();
  loadChart(); renderAll();
}

function submit(req) {
  if (!canTrade()) return toast('Market closed. Enable outside-hours trading in Settings.', 'err');
  const q = quotes[req.symbol];
  const r = Engine.placeOrder(store.acct, req, q, prices());
  if (!r.ok) return toast(r.error, 'err');
  if (r.fill) announceFill(r.fill);
  else toast(`Working: ${req.side.toUpperCase()} ${r.order.qty} ${r.order.symbol} ${r.order.type.toUpperCase()} @ ${fmtPx(r.order.limitPrice ?? r.order.stopPrice)}`);
  save(); renderAll(); drawChart();
}

function closePosition(s) {
  const p = store.acct.positions[s];
  if (!p) return toast(`No position in ${s}`, 'err');
  submit({ symbol: s, side: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), type: 'market' });
}

async function addSymbol(raw) {
  const s = raw.trim().toUpperCase();
  if (!s) return;
  if (store.watch.includes(s)) return selectSymbol(s);
  try {
    const d = await src.lookup(s);
    if (!d.isNYSE) return toast(`${s} trades on ${d.exchangeName || d.exchange}, not the NYSE.`, 'err');
    const { candles, ...q } = d; quotes[s] = q;
    store.watch.push(s); save();
    selectSymbol(s);
  } catch (e) { toast(`${s}: ${e.message}`, 'err'); }
}

$('addForm').addEventListener('submit', (e) => { e.preventDefault(); addSymbol($('addSymbol').value); $('addSymbol').value = ''; });
$('watchTable').addEventListener('click', (e) => {
  const rm = e.target.dataset.rm;
  if (rm) { store.watch = store.watch.filter((x) => x !== rm); save(); renderWatch(); return; }
  const tr = e.target.closest('tr[data-s]');
  if (tr) selectSymbol(tr.dataset.s);
});
$('rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...$('rangeSeg').children].forEach((x) => x.classList.toggle('on', x === b));
  chartRange = { r: b.dataset.r, i: b.dataset.i }; loadChart();
});
$('sideSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  side = b.dataset.side;
  [...$('sideSeg').children].forEach((x) => x.classList.toggle('on', x === b));
  renderEstimate();
});
$('oType').addEventListener('change', () => {
  const t = $('oType').value;
  $('priceField').classList.toggle('hidden', t === 'market');
  $('priceLabel').textContent = t === 'limit' ? 'Limit Price' : 'Stop Price';
  const q = quotes[$('oSymbol').value.toUpperCase()];
  if (t !== 'market' && q && q.price) $('oPrice').value = q.price.toFixed(2);
  renderEstimate();
});
$('oSymbol').addEventListener('change', () => {
  const s = $('oSymbol').value.trim().toUpperCase();
  if (s && s !== store.selected) store.watch.includes(s) ? selectSymbol(s) : addSymbol(s);
});
['oQty', 'oPrice'].forEach((id) => $(id).addEventListener('input', renderEstimate));
document.querySelector('.quick').addEventListener('click', (e) => {
  const q = e.target.dataset.q; if (!q) return;
  if (q === 'max') {
    const qt = quotes[$('oSymbol').value.toUpperCase()];
    if (qt && qt.price) $('oQty').value = Math.max(1, Math.floor(Engine.buyingPower(store.acct, prices()) / (qt.price * 1.001)));
  } else $('oQty').value = q;
  renderEstimate();
});
$('orderForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const type = $('oType').value;
  submit({
    symbol: $('oSymbol').value.trim().toUpperCase(), side, qty: $('oQty').value, type,
    limitPrice: type === 'limit' ? Number($('oPrice').value) : undefined,
    stopPrice: type === 'stop' ? Number($('oPrice').value) : undefined,
    ...($('oBracket').checked ? { stopLoss: Number($('oSL').value) || 0, takeProfit: Number($('oTP').value) || 0 } : {}),
  });
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  activeTab = b.dataset.tab;
  [...$('tabs').children].forEach((x) => x.classList.toggle('on', x === b));
  renderTab();
});
$('tabBody').addEventListener('click', (e) => {
  if (e.target.dataset.export) exportCSV();
  if (e.target.dataset.close) closePosition(e.target.dataset.close);
  if (e.target.dataset.cancel) { Engine.cancelOrder(store.acct, Number(e.target.dataset.cancel)); save(); renderTab(); drawChart(); }
});
function flatten() {
  if (!canTrade()) return toast('Market closed.', 'err');
  if (!Object.keys(store.acct.positions).length) return toast('Already flat.');
  const fills = Engine.flattenAll(store.acct, prices()).filter(Boolean);
  const pnl = fills.reduce((t, f) => t + f.realized, 0);
  toast(`Flattened ${fills.length} position(s) · P&L ${fmt$(pnl)}`, 'ok');
  save(); renderAll(); drawChart();
}
$('btnFlatten').addEventListener('click', flatten);

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const s = $('oSymbol').value.trim().toUpperCase(), qty = $('oQty').value;
  const k = e.key.toLowerCase();
  if (k === 'b') submit({ symbol: s, side: 'buy', qty, type: 'market' });
  else if (k === 's') submit({ symbol: s, side: 'sell', qty, type: 'market' });
  else if (k === 'x') closePosition(s);
  else if (k === 'f') flatten();
});

// bracket: prefill stop-loss / take-profit around the entry using a % offset
function prefillBracket() {
  const q = quotes[$('oSymbol').value.toUpperCase()];
  if (!q || !q.price) return;
  const t = $('oType').value;
  const entry = t === 'market' ? q.price : Number($('oPrice').value) || q.price;
  const pct = Number($('oRisk').value) / 100 || 0.005, dir = side === 'buy' ? 1 : -1;
  $('oSL').value = (entry * (1 - dir * pct)).toFixed(2);
  $('oTP').value = (entry * (1 + dir * pct * 2)).toFixed(2);
  renderEstimate();
}
$('oBracket').addEventListener('change', () => { $('bracketFields').classList.toggle('hidden', !$('oBracket').checked); if ($('oBracket').checked) prefillBracket(); });
$('oRisk').addEventListener('change', prefillBracket);
$('sideSeg').addEventListener('click', () => { if ($('oBracket').checked) prefillBracket(); });
['oSL', 'oTP'].forEach((id) => $(id).addEventListener('input', renderEstimate));
$('indSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  ind[b.dataset.ind] = !ind[b.dataset.ind]; b.classList.toggle('on', ind[b.dataset.ind]); drawChart();
});

// settings
$('btnSettings').addEventListener('click', () => {
  const s = store.acct.settings;
  $('sCash').value = s.startingCash; $('sLev').value = String(s.leverage);
  $('sComm').value = s.commissionPerShare; $('sMinComm').value = s.minCommission; $('sSlip').value = s.slippageBps;
  $('sOutside').checked = store.allowOutside;
  $('sAutoFlat').checked = store.autoFlatten; $('sSound').checked = store.sound;
  $('sKey').value = store.finnhubKey || '';
  $('settingsDlg').showModal();
});
$('settingsDlg').addEventListener('close', () => {
  store.allowOutside = $('sOutside').checked;
  store.autoFlatten = $('sAutoFlat').checked; store.sound = $('sSound').checked;
  const key = $('sKey').value.trim();
  if (key !== (store.finnhubKey || '')) { store.finnhubKey = key; save(); if (!(src instanceof DataSources.ServerSource)) location.reload(); }
  if ($('settingsDlg').returnValue === 'reset') {
    if (!confirm('Reset the account? All positions and trade history will be erased.')) { save(); renderAll(); return; }
    store.acct = Engine.createAccount({
      startingCash: Number($('sCash').value) || 100000, leverage: Number($('sLev').value),
      commissionPerShare: Number($('sComm').value), minCommission: Number($('sMinComm').value), slippageBps: Number($('sSlip').value),
    });
    store.dayStart = null; store.equityHist = [];
    toast('Account reset.', 'ok');
  }
  save(); renderAll(); drawChart();
});

// ---------- account / sign-in ----------
async function onAuthChange(user) {
  cloudReady = false;
  const btn = $('btnAccount');
  btn.classList.remove('hidden');
  btn.textContent = user ? user.email : 'Sign in';
  if (!user) return;
  try {
    const remote = await Auth.pull();
    if (!remote) {
      await Auth.push(cloudCopy());
    } else {
      const localUsed = store.acct.fills.length || Object.keys(store.acct.positions).length;
      if (!localUsed || confirm('Load your saved cloud account?\n\nOK = use the cloud copy.\nCancel = overwrite the cloud with this browser\'s data.')) {
        store = migrate({ ...remote, finnhubKey: store.finnhubKey });
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        renderAll(); drawChart();
      } else {
        await Auth.push(cloudCopy());
      }
    }
    cloudReady = true;
    setSyncLabel('synced');
    Auth.plan().then((p) => { $('aPlan').textContent = p; }).catch(() => {});
  } catch (e) { toast('Cloud sync unavailable: ' + e.message, 'err'); }
}

function openAuth() {
  const u = Auth.user();
  $('authTitle').textContent = u ? 'Your account' : 'Sign in';
  $('authOut').classList.toggle('hidden', !!u);
  $('authIn').classList.toggle('hidden', !u);
  if (u) $('aWho').textContent = u.email;
  $('authErr').textContent = '';
  $('authDlg').showModal();
}
function authMsg(text, ok) {
  const el = $('authErr');
  el.textContent = text;
  el.className = ok ? 'up' : 'down';
}
// fn returns a success message to keep the dialog open, or nothing to close it.
let authBusy = false;
async function authAction(fn) {
  if (authBusy) return;
  const email = $('aEmail').value.trim(), pass = $('aPass').value;
  const btns = ['aSignIn', 'aSignUp', 'aReset'].map($);
  authBusy = true; btns.forEach((b) => { b.disabled = true; });
  authMsg('');
  try {
    const msg = await fn(email, pass);
    if (msg) authMsg(msg, true); else $('authDlg').close();
  } catch (e) {
    const m = /only request this after (\d+) seconds/i.exec(e.message || '');
    authMsg(m ? `Email already sent. Check your inbox (and spam). You can retry in ${m[1]}s.` : e.message);
  } finally {
    authBusy = false; btns.forEach((b) => { b.disabled = false; });
  }
}
$('btnAccount').addEventListener('click', openAuth);
$('authForm').addEventListener('submit', (e) => { if (!Auth.user()) { e.preventDefault(); authAction((em, p) => Auth.signIn(em, p).then(() => null)); } });
$('aSignUp').addEventListener('click', () => {
  if (!$('aEmail').value.trim()) { authMsg('Enter your email.'); return; }
  if ($('aPass').value.length < 6) { authMsg('Password must be 6+ characters.'); return; }
  authAction(async (e, p) => {
    const r = await Auth.signUp(e, p);
    return r.session ? null : 'Account created. Check your email for a confirmation link, then come back and sign in.';
  });
});
$('aReset').addEventListener('click', () => {
  if (!$('aEmail').value.trim()) { authMsg('Enter your email first.'); return; }
  authAction((e) => Auth.reset(e).then(() => 'Password reset email sent.'));
});
$('aSignOut').addEventListener('click', async () => { await Auth.signOut(); $('authDlg').close(); toast('Signed out. Continuing as guest.', 'ok'); });
$('aClose').addEventListener('click', () => $('authDlg').close());
// Never let auth problems block the simulator from booting.
if (window.Auth && Auth.enabled) Promise.resolve().then(() => Auth.init(onAuthChange)).catch((e) => console.warn('Auth init failed:', e));

// ---------- boot ----------
// Prefer the bundled server (full history). On static hosting (e.g. GitHub
// Pages) fall back to Finnhub direct-from-browser with the user's free key.
async function pickSource() {
  if (await DataSources.ServerSource.available()) return new DataSources.ServerSource();
  if (store.finnhubKey) return new DataSources.FinnhubSource(store.finnhubKey);
  return null;
}

function askForKey() {
  const dlg = $('keyDlg');
  dlg.showModal();
  $('keyForm').onsubmit = async (e) => {
    e.preventDefault();
    const key = $('keyInput').value.trim();
    $('keyErr').textContent = 'Checking…';
    try {
      await DataSources.FinnhubSource.verify(key);
      store.finnhubKey = key; save();
      dlg.close();
      start(new DataSources.FinnhubSource(key));
    } catch (err) { $('keyErr').textContent = err.message; }
  };
}

function start(source) {
  src = source;
  if (!src.supportsHistory) {
    // No historical bars in Finnhub mode: only minute-based views make sense.
    [...$('rangeSeg').children].forEach((b) => { b.disabled = b.dataset.r !== '1d'; });
  }
  loadChart();
  pollQuotes();
  setInterval(pollQuotes, src.supportsHistory ? QUOTE_MS : 2000);
  setInterval(loadChart, CHART_MS);
}

$('oSymbol').value = store.selected || store.watch[0] || '';
renderAll();
setInterval(renderHeader, 30000);
pickSource().then((s) => (s ? start(s) : askForKey()));
