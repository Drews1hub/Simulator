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

  // Futures contracts. Anything not listed here is a stock (1 share = 1 unit).
  // multiplier: barrels per contract, so a $1 move = multiplier dollars per contract.
  // margin: deposit held per open contract (approximate, simulator-only).
  // feePerContract: commission per contract per side.
  const FUTURES = {
    MCL: { name: 'Micro WTI Crude Oil (futures)', yahoo: 'MCL=F', multiplier: 100, margin: 1000, feePerContract: 1.0, unit: 'barrels' },
    CL: { name: 'WTI Crude Oil (futures)', yahoo: 'CL=F', multiplier: 1000, margin: 10000, feePerContract: 2.5, unit: 'barrels' },
  };
  const futuresSpec = (sym) => (Object.prototype.hasOwnProperty.call(FUTURES, sym) ? FUTURES[sym] : null);
  const multiplier = (sym) => (futuresSpec(sym) ? futuresSpec(sym).multiplier : 1);

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

  function commissionFor(s, qty, sym) {
    const f = futuresSpec(sym);
    if (f) return round2(Math.abs(qty) * f.feePerContract);
    return round2(Math.max(s.minCommission, Math.abs(qty) * s.commissionPerShare));
  }

  function fillPrice(s, side, last) {
    const slip = Math.max(0.01, last * s.slippageBps / 10000);
    return round2(side === 'buy' ? last + slip : last - slip);
  }

  function marketValue(acct, prices) {
    let long = 0, short = 0;
    for (const [sym, p] of Object.entries(acct.positions)) {
      if (futuresSpec(sym)) continue; // futures aren't bought outright; see futuresOpenPnl
      const px = prices[sym] ?? p.avgPrice;
      if (p.qty > 0) long += p.qty * px; else short += -p.qty * px;
    }
    return { long, short, gross: long + short, net: long - short };
  }

  // Open profit/loss on futures (they settle in cash; nothing is paid for the contract itself).
  function futuresOpenPnl(acct, prices) {
    let u = 0;
    for (const [sym, p] of Object.entries(acct.positions)) {
      const f = futuresSpec(sym);
      if (f) u += ((prices[sym] ?? p.avgPrice) - p.avgPrice) * p.qty * f.multiplier;
    }
    return u;
  }
  function futuresMargin(acct) {
    let m = 0;
    for (const [sym, p] of Object.entries(acct.positions)) { const f = futuresSpec(sym); if (f) m += Math.abs(p.qty) * f.margin; }
    return m;
  }

  function equity(acct, prices) {
    return acct.cash + marketValue(acct, prices).net + futuresOpenPnl(acct, prices);
  }

  function unrealized(acct, prices) {
    let u = 0;
    for (const [sym, p] of Object.entries(acct.positions)) {
      const px = prices[sym] ?? p.avgPrice;
      u += (px - p.avgPrice) * p.qty * multiplier(sym);
    }
    return u;
  }

  function buyingPower(acct, prices) {
    // Futures margin is set aside first; the rest supports stock positions at the chosen leverage.
    return Math.max(0, (equity(acct, prices) - futuresMargin(acct)) * acct.settings.leverage - marketValue(acct, prices).gross);
  }

  // Error message if an order would add more exposure than the account supports, else null.
  function capacityError(acct, sym, side, qty, price, prices) {
    const cur = acct.positions[sym] ? acct.positions[sym].qty : 0;
    const add = Math.abs(cur + (side === 'buy' ? qty : -qty)) - Math.abs(cur);
    if (add <= 0) return null; // closing / reducing never needs more
    const bp = buyingPower(acct, prices), f = futuresSpec(sym);
    if (f) {
      const need = add * f.margin, have = bp / acct.settings.leverage;
      return need > have + 1e-6 ? `Insufficient margin: need $${need.toFixed(2)} (${add} x $${f.margin}), have $${have.toFixed(2)}` : null;
    }
    const need = add * price;
    return need > bp + 1e-6 ? `Insufficient buying power: need $${need.toFixed(2)}, have $${bp.toFixed(2)}` : null;
  }

  function applyFill(acct, order, price, time) {
    const s = acct.settings;
    const signed = order.side === 'buy' ? order.qty : -order.qty;
    const fee = commissionFor(s, order.qty, order.symbol);
    const mult = multiplier(order.symbol), isFut = !!futuresSpec(order.symbol);
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
      realized = (price - pos.avgPrice) * closing * Math.sign(pos.qty) * mult;
      const newQty = pos.qty + signed;
      if (newQty === 0) pos.avgPrice = 0;
      else if (Math.sign(newQty) !== Math.sign(pos.qty)) pos.avgPrice = price; // flipped
      pos.qty = newQty;
    }

    // Stocks: pay / receive the full price. Futures: only the profit or loss changes hands.
    acct.cash = isFut ? acct.cash + realized - fee : acct.cash - signed * price - fee;
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

    // One-cancels-other: a filled bracket leg cancels its sibling.
    if (order.ocoGroup != null) {
      acct.orders.forEach((o) => {
        if (o !== order && o.status === 'open' && o.ocoGroup === order.ocoGroup) { o.status = 'cancelled'; o.reason = 'OCO sibling filled'; }
      });
    }
    // Flat: exit-only orders for this symbol no longer have anything to exit.
    if (!acct.positions[order.symbol]) {
      acct.orders.forEach((o) => {
        if (o.status === 'open' && o.reduceOnly && o.symbol === order.symbol) { o.status = 'cancelled'; o.reason = 'Position closed'; }
      });
    }
    if (order.bracket) spawnBracket(acct, order, time);
    return fill;
  }

  function spawnBracket(acct, parent, time) {
    const exitSide = parent.side === 'buy' ? 'sell' : 'buy';
    const base = { symbol: parent.symbol, side: exitSide, qty: parent.qty, status: 'open', createdAt: time, reduceOnly: true, ocoGroup: parent.id, parentId: parent.id };
    if (parent.bracket.stopLoss) acct.orders.push({ ...base, id: acct.nextId++, type: 'stop', limitPrice: null, stopPrice: parent.bracket.stopLoss, tag: 'SL' });
    if (parent.bracket.takeProfit) acct.orders.push({ ...base, id: acct.nextId++, type: 'limit', limitPrice: parent.bracket.takeProfit, stopPrice: null, tag: 'TP' });
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

    let bracket = null;
    const sl = Number(req.stopLoss) || 0, tp = Number(req.takeProfit) || 0;
    if (sl > 0 || tp > 0) {
      const entry = type === 'limit' ? round2(req.limitPrice) : type === 'stop' ? round2(req.stopPrice) : quote.price;
      const long = req.side === 'buy';
      if (sl > 0 && (long ? sl >= entry : sl <= entry)) return { ok: false, error: `Stop-loss must be ${long ? 'below' : 'above'} the entry price (${entry.toFixed(2)})` };
      if (tp > 0 && (long ? tp <= entry : tp >= entry)) return { ok: false, error: `Take-profit must be ${long ? 'above' : 'below'} the entry price (${entry.toFixed(2)})` };
      bracket = { stopLoss: sl > 0 ? round2(sl) : null, takeProfit: tp > 0 ? round2(tp) : null };
    }

    const order = {
      id: acct.nextId++, symbol, side: req.side, qty, type, bracket,
      limitPrice: type === 'limit' ? round2(req.limitPrice) : null,
      stopPrice: type === 'stop' ? round2(req.stopPrice) : null,
      status: 'open', createdAt: time,
    };

    const refPrice = type === 'limit' ? order.limitPrice : type === 'stop' ? order.stopPrice : quote.price;
    const capErr = capacityError(acct, symbol, order.side, qty, refPrice, prices);
    if (capErr) return { ok: false, error: capErr };

    acct.orders.push(order);
    const fill = tryFill(acct, order, quote.price, time);
    return { ok: true, order, fill };
  }

  function tryFill(acct, order, last, time) {
    if (order.status !== 'open') return null;
    const s = acct.settings;
    if (order.reduceOnly) {
      const pos = acct.positions[order.symbol];
      const reduces = pos && (order.side === 'sell' ? pos.qty > 0 : pos.qty < 0);
      if (!reduces) { order.status = 'cancelled'; order.reason = 'Position closed'; return null; }
      order.qty = Math.min(order.qty, Math.abs(pos.qty));
    }
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
  // `tradable(sym)` (optional) says whether that symbol's market is open right now.
  function processPrices(acct, prices, time = Date.now(), tradable = () => true) {
    const fills = [];
    for (const o of acct.orders) {
      if (o.status !== 'open' || !(prices[o.symbol] > 0) || !tradable(o.symbol)) continue;
      // Re-check buying power / margin at fill time for exposure-increasing orders.
      if (capacityError(acct, o.symbol, o.side, o.qty, prices[o.symbol], prices)) {
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
      if (f.time < sinceMs || futuresSpec(f.symbol)) continue; // the PDT rule doesn't apply to futures
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
    FUTURES, futuresSpec, multiplier, futuresMargin,
  };
});
