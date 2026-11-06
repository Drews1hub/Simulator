'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// data.js is a browser script that attaches itself to window.
const ctx = { window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
  fetch: (...a) => global.fetch(...a), setTimeout, Date };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/data.js'), 'utf8'), ctx);
const { FinnhubSource } = ctx.window.DataSources;

test('parseTwelve converts UTC rows to sorted candles', () => {
  const out = FinnhubSource.parseTwelve([
    { datetime: '2026-11-05 15:00:00', open: '96.1', high: '96.5', low: '96.0', close: '96.4', volume: '1000' },
    { datetime: '2026-11-05 14:00:00', open: '95.9', high: '96.2', low: '95.8', close: '96.1', volume: '900' },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].t, Date.UTC(2026, 10, 5, 14));
  assert.strictEqual(out[1].c, 96.4);
});

test('5D/1M use Twelve Data when a key is set and cache the result', async () => {
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.match(url, /api\.twelvedata\.com\/time_series\?symbol=KO&interval=15min&outputsize=135/);
    return { ok: true, status: 200, json: async () => ({ status: 'ok', values: [
      { datetime: '2026-11-05 15:00:00', open: '1', high: '2', low: '1', close: '2', volume: '5' }] }) };
  };
  const s = Object.create(FinnhubSource.prototype);
  Object.assign(s, { twelveKey: 'k', hist: {}, histAt: 0 });
  const a = await s.longHistory('KO', '15m');
  const b = await s.longHistory('KO', '15m');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(b, a);
  assert.strictEqual(calls, 1);
});
