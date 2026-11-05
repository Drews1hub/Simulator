'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/engine.js');

const noFees = { commissionPerShare: 0, minCommission: 0, slippageBps: 0, leverage: 1, startingCash: 10000 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('long round trip realizes P&L', () => {
  const a = E.createAccount(noFees);
  // slippage floor is 1 cent even at 0 bps
  let r = E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 10, type: 'market' }, { price: 60 }, { KO: 60 });
  assert.ok(r.ok); near(r.fill.price, 60.01);
  r = E.placeOrder(a, { symbol: 'KO', side: 'sell', qty: 10, type: 'market' }, { price: 61 }, { KO: 61 });
  near(r.fill.price, 60.99);
  near(a.realized, 9.8);
  assert.deepStrictEqual(a.positions, {});
  near(a.cash, 10009.8);
});

test('short, then cover with flip to long', () => {
  const a = E.createAccount(noFees);
  E.placeOrder(a, { symbol: 'F', side: 'sell', qty: 100, type: 'market' }, { price: 12 }, { F: 12 });
  assert.strictEqual(a.positions.F.qty, -100);
  near(E.equity(a, { F: 12 }), 10000 - 1); // 1 cent slippage * 100
  E.placeOrder(a, { symbol: 'F', side: 'buy', qty: 150, type: 'market' }, { price: 11 }, { F: 11 });
  assert.strictEqual(a.positions.F.qty, 50);
  near(a.positions.F.avgPrice, 11.01);
  near(a.realized, (11.99 - 11.01) * 100);
});

test('buying power is enforced with leverage', () => {
  const a = E.createAccount(noFees);
  const r = E.placeOrder(a, { symbol: 'IBM', side: 'buy', qty: 100, type: 'market' }, { price: 250 }, { IBM: 250 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /buying power/);
  const b = E.createAccount({ ...noFees, leverage: 4 });
  assert.ok(E.placeOrder(b, { symbol: 'IBM', side: 'buy', qty: 100, type: 'market' }, { price: 250 }, { IBM: 250 }).ok);
});

test('closing trades are allowed even with no buying power', () => {
  const a = E.createAccount({ ...noFees, leverage: 1 });
  E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 160, type: 'market' }, { price: 60 }, { KO: 60 });
  const r = E.placeOrder(a, { symbol: 'KO', side: 'sell', qty: 160, type: 'market' }, { price: 55 }, { KO: 55 });
  assert.ok(r.ok, r.error);
});

test('limit and stop orders trigger on price updates', () => {
  const a = E.createAccount(noFees);
  const lim = E.placeOrder(a, { symbol: 'JPM', side: 'buy', qty: 10, type: 'limit', limitPrice: 200 }, { price: 205 }, { JPM: 205 });
  assert.strictEqual(lim.fill, null);
  assert.strictEqual(E.processPrices(a, { JPM: 202 }).length, 0);
  const f = E.processPrices(a, { JPM: 199.5 });
  assert.strictEqual(f.length, 1); near(f[0].price, 199.5);
  E.placeOrder(a, { symbol: 'JPM', side: 'sell', qty: 10, type: 'stop', stopPrice: 195 }, { price: 199 }, { JPM: 199 });
  assert.strictEqual(E.processPrices(a, { JPM: 196 }).length, 0);
  const s = E.processPrices(a, { JPM: 194 });
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(a.positions, {});
});

test('commissions use per-share with minimum', () => {
  const s = E.createAccount().settings;
  assert.strictEqual(E.commissionFor(s, 10), 1);
  assert.strictEqual(E.commissionFor(s, 1000), 5);
});

test('flattenAll closes everything and cancels open orders', () => {
  const a = E.createAccount({ ...noFees, leverage: 4 });
  E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 10, type: 'market' }, { price: 60 }, { KO: 60 });
  E.placeOrder(a, { symbol: 'F', side: 'sell', qty: 10, type: 'market' }, { price: 12 }, { KO: 60, F: 12 });
  E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 10, type: 'limit', limitPrice: 50 }, { price: 60 }, { KO: 60, F: 12 });
  E.flattenAll(a, { KO: 60, F: 12 });
  assert.deepStrictEqual(a.positions, {});
  assert.ok(a.orders.every((o) => o.status !== 'open'));
});

test('invalid orders are rejected', () => {
  const a = E.createAccount();
  assert.strictEqual(E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 0 }, { price: 60 }, {}).ok, false);
  assert.strictEqual(E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 5 }, null, {}).ok, false);
  assert.strictEqual(E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 5, type: 'limit' }, { price: 60 }, {}).ok, false);
});

test('bracket order spawns OCO stop-loss and take-profit', () => {
  const a = E.createAccount({ ...noFees, leverage: 4 });
  const r = E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 100, type: 'market', stopLoss: 95, takeProfit: 98 }, { price: 96 }, { KO: 96 });
  assert.ok(r.ok, r.error);
  const legs = a.orders.filter((o) => o.status === 'open');
  assert.deepStrictEqual(legs.map((o) => o.tag).sort(), ['SL', 'TP']);
  assert.strictEqual(E.processPrices(a, { KO: 97 }).length, 0);
  const f = E.processPrices(a, { KO: 98.2 });
  assert.strictEqual(f.length, 1);
  near(f[0].price, 98.2);
  assert.deepStrictEqual(a.positions, {});
  assert.ok(a.orders.every((o) => o.status !== 'open'), 'stop-loss leg cancelled');
});

test('bracket legs cancel when position is closed manually', () => {
  const a = E.createAccount({ ...noFees, leverage: 4 });
  E.placeOrder(a, { symbol: 'F', side: 'sell', qty: 100, type: 'market', stopLoss: 13, takeProfit: 11 }, { price: 12 }, { F: 12 });
  assert.strictEqual(a.positions.F.qty, -100);
  E.placeOrder(a, { symbol: 'F', side: 'buy', qty: 100, type: 'market' }, { price: 12 }, { F: 12 });
  assert.ok(a.orders.every((o) => o.status !== 'open'));
  assert.strictEqual(E.processPrices(a, { F: 14 }).length, 0, 'no stray short-cover fills');
  assert.deepStrictEqual(a.positions, {});
});

test('bracket prices are validated against entry', () => {
  const a = E.createAccount();
  const r = E.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 10, type: 'market', stopLoss: 97 }, { price: 96 }, { KO: 96 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /below/);
});

test('limit entry with bracket only arms legs after the entry fills', () => {
  const a = E.createAccount({ ...noFees, leverage: 4 });
  E.placeOrder(a, { symbol: 'JPM', side: 'buy', qty: 10, type: 'limit', limitPrice: 200, stopLoss: 195, takeProfit: 210 }, { price: 205 }, { JPM: 205 });
  assert.strictEqual(a.orders.filter((o) => o.status === 'open').length, 1);
  E.processPrices(a, { JPM: 199 });
  assert.strictEqual(a.positions.JPM.qty, 10);
  assert.strictEqual(a.orders.filter((o) => o.status === 'open').length, 2);
});
