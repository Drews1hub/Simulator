// Trading engine: pure functions over a plain-object account state.
// Works in the browser (window.Engine) and in Node (module.exports) for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    startingCash: 100000,
    commissionPerShare: 0.005,
    minCommission: 1.0,
    slippageBps: 2,      // fill this many basis points away from last price (min 1 cent)
    leverage: 4,         // intraday buying power multiple (Reg-T day trading = 4x)
  };

  const round2 = (x) => Math.round(x * 100) / 100;

  function createAccount(settings = {}) {
    const s = { ...DEFAULTS, ...settings };
    return {
      settings: s,
      cash: s.startingCash,
      positions: {},   // sym -> { qty (signed: + long / - short), avgPrice }
      orders: [],      // open + historical orders
      fills: [],
      realized: 0,
      commissions: 0,
      nextId: 1,
      createdAt: Date.now(),
    };
  }

  function commissionFor(s, qty) {
    return round2(Math.max(s.minCommission, Math.abs(qty) * s.commissionPerShare));
  }

  function fillPrice(s, side, last) {
    const slip = Math.max(0.01, last * s.slippageBps / 10000);
    return round2(side === 'buy' ? last + slip : last - slip);
  }

  function marketValue(acct, prices) {
    let long = 0, short = 0;
    for (const [sym, p] of Object.entries(acct.positions)) {
      const px = prices[sym] ?? p.avgPrice;
      if (p.qty > 0) long += p.qty * px; else short += -p.qty * px;
    }
    return { long, short, gross: long + short, net: long - short };
  }

  function equity(acct, prices) {
    return acct.cash + marketValue(acct, prices).net;
  }

  function unrealized(acct, prices) {
    let u = 0;
    for (const [sym, p] of Object.entries(acct.positions)) {
      const px = prices[sym] ?? p.avgPrice;
      u += (px - p.avgPrice) * p.qty;
    }
    return u;
  }

  function buyingPower(acct, prices) {
    return Math.max(0, equity(acct, prices) * acct.settings.leverage - marketValue(acct, prices).gross);
  }

  // Additional gross exposure an order would add (closing trades add none).
  function exposureDelta(acct, sym, side, qty, price) {
    const cur = acct.positions[sym] ? acct.positions[sym].qty : 0;
    const next = cur + (side === 'buy' ? qty : -qty);
    return (Math.abs(next) - Math.abs(cur)) * price;
  }

  function applyFill(acct, order, price, time) {
    const s = acct.settings;
    const signed = order.side === 'buy' ? order.qty : -order.qty;
    const fee = commissionFor(s, order.qty);
    const pos = acct.positions[order.symbol] || { qty: 0, avgPrice: 0 };
    let realized = 0;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
      // Opening / adding: weighted-average cost.
      const newQty = pos.qty + signed;
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + price * Math.abs(signed)) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      // Reducing, closing, or flipping.
      const closing = Math.min(Math.abs(signed), Math.abs(pos.qty));
      realized = (price - pos.avgPrice) * closing * Math.sign(pos.qty);
      const newQty = pos.qty + signed;
      if (newQty === 0) pos.avgPrice = 0;
      else if (Math.sign(newQty) !== Math.sign(pos.qty)) pos.avgPrice = price; // flipped
      pos.qty = newQty;
    }

    acct.cash = acct.cash - signed * price - fee;
    acct.realized += realized;
    acct.commissions += fee;
    if (pos.qty === 0) delete acct.positions[order.symbol];
    else acct.positions[order.symbol] = pos;

    order.status = 'filled';
    order.fillPrice = price;
    order.filledAt = time;
    const fill = {
      id: acct.fills.length + 1, orderId: order.id, symbol: order.symbol, side: order.side,
      qty: order.qty, price, fee, realized: round2(realized), time,
    };
    acct.fills.push(fill);
    return fill;
  }

  // Order: { symbol, side: 'buy'|'sell', qty, type: 'market'|'limit'|'stop', limitPrice?, stopPrice? }
  // `quote` = { price } for the symbol; `prices` = map of all latest prices.
  function placeOrder(acct, req, quote, prices, time = Date.now()) {
    const qty = Math.floor(Number(req.qty));
    const symbol = String(req.symbol || '').toUpperCase();
    const type = req.type || 'market';
    if (!symbol) return { ok: false, error: 'Symbol required' };
    if (!(qty > 0)) return { ok: false, error: 'Quantity must be a positive whole number' };
    if (!['buy', 'sell'].includes(req.side)) return { ok: false, error: 'Side must be buy or sell' };
    if (!['market', 'limit', 'stop'].includes(type)) return { ok: false, error: 'Unknown order type' };
    if (!quote || !(quote.price > 0)) return { ok: false, error: `No live price for ${symbol}` };
    if (type === 'limit' && !(req.limitPrice > 0)) return { ok: false, error: 'Limit price required' };
    if (type === 'stop' && !(req.stopPrice > 0)) return { ok: false, error: 'Stop price required' };

    const order = {
      id: acct.nextId++, symbol, side: req.side, qty, type,
      limitPrice: type === 'limit' ? round2(req.limitPrice) : null,
      stopPrice: type === 'stop' ? round2(req.stopPrice) : null,
      status: 'open', createdAt: time,
    };

    const refPrice = type === 'limit' ? order.limitPrice : type === 'stop' ? order.stopPrice : quote.price;
    const need = exposureDelta(acct, symbol, order.side, qty, refPrice);
    const bp = buyingPower(acct, prices);
    if (need > bp + 1e-6) {
      return { ok: false, error: `Insufficient buying power: need $${need.toFixed(2)}, have $${bp.toFixed(2)}` };
    }

    acct.orders.push(order);
    const fill = tryFill(acct, order, quote.price, time);
    return { ok: true, order, fill };
  }

  function tryFill(acct, order, last, time) {
    if (order.status !== 'open') return null;
    const s = acct.settings;
    if (order.type === 'market') return applyFill(acct, order, fillPrice(s, order.side, last), time);
    if (order.type === 'limit') {
      const hit = order.side === 'buy' ? last <= order.limitPrice : last >= order.limitPrice;
      if (hit) {
        // Fill at the better of limit or last.
        const px = order.side === 'buy' ? Math.min(order.limitPrice, last) : Math.max(order.limitPrice, last);
        return applyFill(acct, order, round2(px), time);
      }
    }
    if (order.type === 'stop') {
      const hit = order.side === 'buy' ? last >= order.stopPrice : last <= order.stopPrice;
      if (hit) return applyFill(acct, order, fillPrice(s, order.side, last), time);
    }
    return null;
  }

  // Check every open order against fresh prices. Returns new fills.
  function processPrices(acct, prices, time = Date.now()) {
    const fills = [];
    for (const o of acct.orders) {
      if (o.status !== 'open' || !(prices[o.symbol] > 0)) continue;
      // Re-check buying power at fill time for exposure-increasing orders.
      const need = exposureDelta(acct, o.symbol, o.side, o.qty, prices[o.symbol]);
      if (need > 0 && need > buyingPower(acct, prices) + 1e-6) {
        const triggered = o.type === 'limit'
          ? (o.side === 'buy' ? prices[o.symbol] <= o.limitPrice : prices[o.symbol] >= o.limitPrice)
          : o.type === 'stop'
            ? (o.side === 'buy' ? prices[o.symbol] >= o.stopPrice : prices[o.symbol] <= o.stopPrice)
            : true;
        if (triggered) { o.status = 'rejected'; o.reason = 'Insufficient buying power at trigger'; }
        continue;
      }
      const f = tryFill(acct, o, prices[o.symbol], time);
      if (f) fills.push(f);
    }
    return fills;
  }

  function cancelOrder(acct, id) {
    const o = acct.orders.find((x) => x.id === id);
    if (!o || o.status !== 'open') return false;
    o.status = 'cancelled';
    return true;
  }

  // Market-close every position (end-of-day flatten).
  function flattenAll(acct, prices, time = Date.now()) {
    acct.orders.forEach((o) => { if (o.status === 'open') o.status = 'cancelled'; });
    const fills = [];
    for (const [sym, p] of Object.entries({ ...acct.positions })) {
      if (!(prices[sym] > 0)) continue;
      const order = { id: acct.nextId++, symbol: sym, side: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), type: 'market', status: 'open', createdAt: time };
      acct.orders.push(order);
      fills.push(tryFill(acct, order, prices[sym], time));
    }
    return fills;
  }

  // Count round-trip day trades in the trailing window (for the PDT warning).
  function dayTradeCount(acct, sinceMs) {
    const byDay = {};
    for (const f of acct.fills) {
      if (f.time < sinceMs) continue;
      const day = new Date(f.time).toISOString().slice(0, 10);
      const k = day + '|' + f.symbol;
      byDay[k] = byDay[k] || { buy: false, sell: false };
      byDay[k][f.side] = true;
    }
    return Object.values(byDay).filter((d) => d.buy && d.sell).length;
  }

  return {
    DEFAULTS, createAccount, placeOrder, processPrices, cancelOrder, flattenAll,
    equity, unrealized, buyingPower, marketValue, commissionFor, dayTradeCount,
  };
});
