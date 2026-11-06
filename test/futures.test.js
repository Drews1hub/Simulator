'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../public/engine.js');

const acct0 = () => Engine.createAccount({ startingCash: 10000, slippageBps: 0, leverage: 4 });

test('MCL: $1 move = $100 per contract; only P&L and fees touch cash', () => {
  const a = acct0();
  const r = Engine.placeOrder(a, { symbol: 'MCL', side: 'buy', qty: 2, type: 'market' }, { price: 80 }, { MCL: 80 });
  assert.ok(r.ok, r.error);
  // Bought 2 @ 80.01 (1-cent minimum slippage); paid only the $2 fee, not the contract value.
  assert.strictEqual(r.fill.price, 80.01);
  assert.strictEqual(r.fill.fee, 2);
  assert.strictEqual(a.cash, 9998);
  // Mark to 81.01: +$1 x 100 barrels x 2 contracts = +$200 open profit.
  assert.strictEqual(Math.round(Engine.unrealized(a, { MCL: 81.01 })), 200);
  assert.strictEqual(Math.round(Engine.equity(a, { MCL: 81.01 })), 10198);
  // Close at 81.02 (81.03 last minus 1 cent slippage): realized +$200, minus another $2 fee.
  const c = Engine.placeOrder(a, { symbol: 'MCL', side: 'sell', qty: 2, type: 'market' }, { price: 81.03 }, { MCL: 81.03 });
  assert.ok(c.ok, c.error);
  assert.strictEqual(Math.round(c.fill.realized), 202);
  assert.strictEqual(Math.round(a.cash), 10198);
  assert.strictEqual(a.positions.MCL, undefined);
});

test('MCL short profits when oil falls', () => {
  const a = acct0();
  Engine.placeOrder(a, { symbol: 'MCL', side: 'sell', qty: 1, type: 'market' }, { price: 80 }, { MCL: 80 });
  assert.strictEqual(Math.round(Engine.unrealized(a, { MCL: 78.99 })), 100); // 79.99 -> 78.99
});

test('futures need margin per contract, not the full contract value', () => {
  const a = acct0(); // $10,000 equity; MCL margin $1,000 each
  assert.ok(Engine.placeOrder(a, { symbol: 'MCL', side: 'buy', qty: 9, type: 'market' }, { price: 80 }, { MCL: 80 }).ok);
  const r = Engine.placeOrder(a, { symbol: 'MCL', side: 'buy', qty: 1, type: 'market' }, { price: 80 }, { MCL: 80 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Insufficient margin/);
  // Closing is always allowed.
  assert.ok(Engine.placeOrder(a, { symbol: 'MCL', side: 'sell', qty: 9, type: 'market' }, { price: 80 }, { MCL: 80 }).ok);
});

test('futures margin reduces stock buying power', () => {
  const a = acct0();
  const before = Engine.buyingPower(a, {});
  Engine.placeOrder(a, { symbol: 'MCL', side: 'buy', qty: 1, type: 'market' }, { price: 80 }, { MCL: 80 });
  const after = Engine.buyingPower(a, { MCL: 80.01 });
  // $1,000 margin + $1 fee, times 4x leverage.
  assert.strictEqual(Math.round(before - after), 4004);
});

test('stocks are unchanged: shares cost the full price', () => {
  const a = acct0();
  const r = Engine.placeOrder(a, { symbol: 'KO', side: 'buy', qty: 10, type: 'market' }, { price: 50 }, { KO: 50 });
  assert.ok(r.ok);
  assert.strictEqual(a.cash, 10000 - 10 * 50.01 - 1);
  assert.strictEqual(Engine.commissionFor(a.settings, 10, 'KO'), 1);
  assert.strictEqual(Engine.commissionFor(a.settings, 10, 'MCL'), 10);
});

test('closed futures market: tradable() holds orders back', () => {
  const a = acct0();
  Engine.placeOrder(a, { symbol: 'MCL', side: 'buy', qty: 1, type: 'limit', limitPrice: 79 }, { price: 80 }, { MCL: 80 });
  assert.strictEqual(Engine.processPrices(a, { MCL: 78 }, Date.now(), () => false).length, 0);
  assert.strictEqual(Engine.processPrices(a, { MCL: 78 }, Date.now(), () => true).length, 1);
});

test('futures round trips do not count toward the PDT day-trade limit', () => {
  const a = acct0();
  Engine.placeOrder(a, { symbol: 'MCL', side: 'buy', qty: 1, type: 'market' }, { price: 80 }, { MCL: 80 });
  Engine.placeOrder(a, { symbol: 'MCL', side: 'sell', qty: 1, type: 'market' }, { price: 80 }, { MCL: 80 });
  assert.strictEqual(Engine.dayTradeCount(a, 0), 0);
});
