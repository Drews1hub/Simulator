'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/layout.js');

test('default or missing layout keeps the stylesheet grid', () => {
  assert.strictEqual(L.gridSpec(null, 1400, 900), null);
  assert.strictEqual(L.gridSpec({ order: ['w', 'c', 't'], hidden: [], widths: {} }, 1400, 900), null);
});

test('normalize repairs bad saved data', () => {
  const n = L.normalize({ order: ['t', 't', 'x'], hidden: ['c', 'b', 'b'], widths: { w: '320', t: -5 }, topH: 'abc' });
  assert.deepStrictEqual(n, { order: ['w', 'c', 't'], hidden: ['b'], widths: { w: 320 }, topH: null });
});

test('custom widths, order and row height become a grid', () => {
  const s = L.gridSpec({ order: ['c', 'w', 't'], widths: { w: 350 }, topH: 600 }, 1400, 900);
  assert.strictEqual(s.columns, 'minmax(0, 1fr) 350px 280px');
  assert.strictEqual(s.areas, '"c w t" "b b b"');
  assert.strictEqual(s.rows, '600px auto');
});

test('widths are clamped to their limits', () => {
  const s = L.gridSpec({ widths: { w: 50, t: 9999 } }, 1600, 900);
  assert.strictEqual(s.widths.w, L.MIN.w);
  assert.strictEqual(s.widths.t, L.MAX.t);
});

test('hidden panels drop out of the grid', () => {
  const s = L.gridSpec({ hidden: ['w', 'b'] }, 1400, 900);
  assert.strictEqual(s.areas, '"c t"');
  assert.strictEqual(s.columns, 'minmax(0, 1fr) 280px');
  assert.ok(!s.rows.includes('auto'));
});

test('side panels shrink so the chart keeps its minimum width', () => {
  const s = L.gridSpec({ widths: { w: 560, t: 480 } }, 900, 800);
  const chart = 900 - 20 - 20 - s.widths.w - s.widths.t;
  assert.ok(chart >= L.MIN.c, `chart only ${chart}px`);
});

test('row height is kept on screen', () => {
  assert.strictEqual(L.gridSpec({ topH: 5000 }, 1400, 800).rows, '680px auto');
  assert.strictEqual(L.gridSpec({ topH: 100 }, 1400, 800).rows, L.MIN_TOP + 'px auto');
});
